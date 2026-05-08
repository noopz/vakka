import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test sets a fresh tmp auth.json BEFORE the dynamic import, then resets
// the in-memory cache. The auth module reads VAKKA_AUTH_TOKEN_PATH from env at
// load time via getConfig() — but config is also cached, so we set the env
// var once up front and overwrite the file contents per test.

const tmpDir = mkdtempSync(join(tmpdir(), "vekka-auth-pairing-"));
const AUTH_PATH = join(tmpDir, "auth.json");
process.env.VAKKA_AUTH_TOKEN_PATH = AUTH_PATH;

// Seed an initial empty config so the very first import of auth.ts (during
// dynamic import below) doesn't blow up.
writeFileSync(AUTH_PATH, JSON.stringify({ token: "t", devices: {}, pairingMode: true }), "utf-8");

const auth = await import("../src/web/auth.js");
const routes = await import("../src/web/auth-routes.js");
const sharedConfig = await import("../src/shared/config.js");

// Pin shared config to our tmp path. This forces the cache to materialize
// against our path even if some other test imported auth.ts first.
sharedConfig.setConfig({ authTokenPath: AUTH_PATH });

function writeFreshConfig(opts: { devices?: Record<string, unknown>; pairingMode?: boolean } = {}) {
  const data = {
    token: "test-token",
    devices: opts.devices ?? {},
    ...(opts.pairingMode !== undefined ? { pairingMode: opts.pairingMode } : {}),
  };
  writeFileSync(AUTH_PATH, JSON.stringify(data), "utf-8");
  auth._resetAuthCacheForTests();
}

function makeApp() {
  const app = express();
  app.use(express.json());
  // Trust X-Forwarded-For so we can simulate distinct IPs.
  app.set("trust proxy", true);
  app.use("/api/auth", routes.createAuthRouter());
  return app;
}

async function withServer<T>(
  app: express.Express,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const server = (app as any).listen(0, async () => {
      const cleanup = () => {
        try { server.closeAllConnections?.(); } catch {}
        server.close();
      };
      try {
        const port = (server.address() as any).port;
        const result = await fn(port);
        cleanup();
        resolve(result);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  });
}

beforeEach(() => {
  routes._resetRateLimitForTests();
});

afterEach(() => {
  // Reset between tests to avoid bleed.
  auth._resetAuthCacheForTests();
});

afterAll(() => {
  // Drop our pinned shared config so subsequent test files in the same bun
  // process can reinitialize from their own VAKKA_AUTH_TOKEN_PATH env var.
  auth._resetAuthCacheForTests();
  sharedConfig._resetConfigForTests();
});

describe("auth pairing mode", () => {
  test("fresh config: first registerDevice → trusted, pairingMode flips to false", () => {
    writeFreshConfig({ devices: {}, pairingMode: true });
    const result = auth.registerDevice("first-device");
    expect(result.status).toBe("trusted");
    if (result.status !== "trusted") throw new Error("unexpected");
    expect(typeof result.deviceId).toBe("string");
    expect(typeof result.secret).toBe("string");

    // Reload from disk to confirm persistence.
    auth._resetAuthCacheForTests();
    const cfg = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
    expect(cfg.pairingMode).toBe(false);
    expect(Object.keys(cfg.devices).length).toBe(1);
    expect(cfg.devices[result.deviceId].status).toBe("trusted");
  });

  test("second registerDevice with pairingMode=false → rejected, no device persisted", () => {
    // Pre-populate with one trusted device + pairingMode false (post-bootstrap).
    writeFreshConfig({
      devices: {
        "existing-1": {
          name: "first",
          secret: "s",
          status: "trusted",
          created: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        },
      },
      pairingMode: false,
    });

    const result = auth.registerDevice("intruder");
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("unexpected");
    expect(result.error).toMatch(/Pairing mode disabled/);

    auth._resetAuthCacheForTests();
    const cfg = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
    expect(Object.keys(cfg.devices).length).toBe(1);
  });

  test("toggling pairingMode=true via route then registerDevice → pending; approve → trusted", async () => {
    writeFreshConfig({
      devices: {
        "existing-1": {
          name: "first",
          secret: "secret-1",
          status: "trusted",
          created: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        },
      },
      pairingMode: false,
    });

    const app = makeApp();
    await withServer(app, async (port) => {
      // Toggle pairing-mode ON via authed route.
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/pairing-mode`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Device existing-1:secret-1",
        },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pairingMode).toBe(true);

      // Now a new device registration should be pending.
      const reg = auth.registerDevice("second-device");
      expect(reg.status).toBe("pending");
      if (reg.status !== "pending") throw new Error("unexpected");

      // Approve it.
      const ok = auth.approveDevice(reg.deviceId);
      expect(ok).toBe(true);
      const cfg = auth.loadAuthConfig();
      expect(cfg.devices[reg.deviceId].status).toBe("trusted");

      // Toggle pairing-mode OFF, third device → rejected.
      const off = await fetch(`http://127.0.0.1:${port}/api/auth/pairing-mode`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Device existing-1:secret-1",
        },
        body: JSON.stringify({ enabled: false }),
      });
      expect(off.status).toBe(200);
      const offBody = await off.json();
      expect(offBody.pairingMode).toBe(false);

      const third = auth.registerDevice("third-device");
      expect(third.status).toBe("rejected");
    });
  });

  test("GET /pairing-mode returns current state", async () => {
    writeFreshConfig({
      devices: {
        "existing-1": {
          name: "first",
          secret: "secret-1",
          status: "trusted",
          created: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        },
      },
      pairingMode: true,
    });
    const app = makeApp();
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/pairing-mode`, {
        headers: { Authorization: "Device existing-1:secret-1" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pairingMode).toBe(true);
    });
  });

  test("pairing-mode route requires auth", async () => {
    writeFreshConfig({ devices: {}, pairingMode: true });
    const app = makeApp();
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/pairing-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(401);
    });
  });

  test("rate limit: 6 POSTs to /register from same IP → 6th returns 429 with Retry-After", async () => {
    writeFreshConfig({ devices: {}, pairingMode: true });
    const app = makeApp();
    await withServer(app, async (port) => {
      const url = `http://127.0.0.1:${port}/api/auth/register`;
      const headers = {
        "Content-Type": "application/json",
        // Force a stable IP via X-Forwarded-For (trust proxy is on).
        "X-Forwarded-For": "10.9.8.7",
      } as Record<string, string>;
      const responses: Response[] = [];
      for (let i = 0; i < 6; i++) {
        responses.push(
          await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ name: `dev-${i}` }),
          }),
        );
      }
      for (let i = 0; i < 5; i++) {
        expect(responses[i].status).toBe(200);
      }
      expect(responses[5].status).toBe(429);
      expect(responses[5].headers.get("Retry-After")).toBeTruthy();
    });
  });

  test("legacy config without pairingMode field, with existing devices → defaults to false", () => {
    // Write a legacy config (no pairingMode field) WITH existing devices.
    writeFileSync(
      AUTH_PATH,
      JSON.stringify({
        token: "legacy",
        devices: {
          "legacy-1": {
            name: "old",
            secret: "x",
            status: "trusted",
            created: new Date().toISOString(),
            lastSeen: null,
          },
        },
      }),
      "utf-8",
    );
    auth._resetAuthCacheForTests();
    expect(auth.getPairingMode()).toBe(false);
  });

  test("legacy config without pairingMode field, empty devices → defaults to true", () => {
    writeFileSync(AUTH_PATH, JSON.stringify({ token: "legacy", devices: {} }), "utf-8");
    auth._resetAuthCacheForTests();
    expect(auth.getPairingMode()).toBe(true);
  });
});
