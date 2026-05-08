import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../src/db/schema.js";

// Seed auth config BEFORE importing websocket.ts (which transitively loads
// auth.ts that caches the config).
const tmp = mkdtempSync(join(tmpdir(), "vekka-ws-subproto-"));
const AUTH_PATH = join(tmp, "auth.json");
const TOKEN = "valid-token-abc";
const DEVICE_TRUSTED = "device-trusted-1";
const DEVICE_TRUSTED_SECRET = "secret-trusted";
const DEVICE_PENDING = "device-pending-1";
const DEVICE_PENDING_SECRET = "secret-pending";

writeFileSync(
  AUTH_PATH,
  JSON.stringify({
    token: TOKEN,
    pairingMode: false,
    devices: {
      [DEVICE_TRUSTED]: {
        name: "trusted",
        secret: DEVICE_TRUSTED_SECRET,
        status: "trusted",
        created: new Date().toISOString(),
        lastSeen: null,
      },
      [DEVICE_PENDING]: {
        name: "pending",
        secret: DEVICE_PENDING_SECRET,
        status: "pending",
        created: new Date().toISOString(),
        lastSeen: null,
      },
    },
  }),
  "utf-8",
);
process.env.VAKKA_AUTH_TOKEN_PATH = AUTH_PATH;

const sharedConfig = await import("../src/shared/config.js");
sharedConfig.setConfig({ authTokenPath: AUTH_PATH });

const auth = await import("../src/web/auth.js");
const { setupWebSocket } = await import("../src/web/websocket.js");

let db: Database;
let server: HttpServer;

function makeFakeMqtt() {
  const handlers: Array<(t: string, p: Buffer) => void> = [];
  const client: any = {
    subscribe(_t: any, cb?: (e: Error | null) => void) {
      cb?.(null);
    },
    unsubscribe() {},
    publish() {},
    on(event: string, cb: any) {
      if (event === "message") handlers.push(cb);
      return client;
    },
    removeListener() {
      return client;
    },
  };
  return client;
}

async function startServer(): Promise<number> {
  server = createServer();
  setupWebSocket(server, makeFakeMqtt(), db);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  return (server.address() as any).port;
}

beforeEach(() => {
  db = initDatabase(":memory:");
  auth._resetAuthCacheForTests();
  auth._resetWsDeprecationWarnedForTests();
});

afterEach(async () => {
  if (server) {
    // Forcibly destroy any lingering keep-alive sockets so server.close()
    // resolves promptly. Without this, an undrained WS connection (e.g. one
    // closed by the safety-timeout in connectWs) keeps the event loop alive
    // and causes test-suite hangs.
    if (typeof (server as any).closeAllConnections === "function") {
      (server as any).closeAllConnections();
    }
    await new Promise<void>((res) => server.close(() => res()));
    server = undefined as unknown as HttpServer;
  }
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    db = undefined as unknown as Database;
  }
});

afterAll(() => {
  sharedConfig.setConfig({});
});

interface ClientResult {
  opened: boolean;
  closedBeforeOpen: boolean;
}

// Connect via the `ws` client. On Bun, the client cannot reliably parse a
// 401 response body (the upstream `node:net` 'data' event doesn't fire when
// the server closes the socket immediately after writing), so we just
// distinguish "got open" from "closed before open" — which is functionally
// equivalent to "auth accepted" vs. "auth refused".
function connectWs(port: number, opts: { subprotocol?: string; query?: string } = {}): Promise<ClientResult> {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${port}/ws${opts.query ?? ""}`;
    const ws = new WebSocket(url, opts.subprotocol ? [opts.subprotocol] : undefined);
    let opened = false;
    let settled = false;
    let safetyTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (safetyTimer) clearTimeout(safetyTimer);
      // Always tear down the underlying socket so it can't pin the event loop.
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
      resolve({ opened, closedBeforeOpen: !opened });
    };
    ws.on("open", () => {
      opened = true;
      ws.close();
    });
    ws.on("error", () => {
      /* swallow — we resolve via close/safety */
    });
    ws.on("close", settle);
    safetyTimer = setTimeout(settle, 1500);
  });
}

describe("WebSocket subprotocol auth", () => {
  test("valid bearer subprotocol → accepted", async () => {
    const port = await startServer();
    const r = await connectWs(port, { subprotocol: `vakka.bearer.${TOKEN}` });
    expect(r.opened).toBe(true);
  });

  test("invalid bearer subprotocol → refused", async () => {
    const port = await startServer();
    const r = await connectWs(port, { subprotocol: "vakka.bearer.WRONG" });
    expect(r.opened).toBe(false);
    expect(r.closedBeforeOpen).toBe(true);
  });

  test("valid device subprotocol (trusted) → accepted", async () => {
    const port = await startServer();
    const r = await connectWs(port, {
      subprotocol: `vakka.device.${DEVICE_TRUSTED}.${DEVICE_TRUSTED_SECRET}`,
    });
    expect(r.opened).toBe(true);
  });

  test("device subprotocol for pending device → refused", async () => {
    const port = await startServer();
    const r = await connectWs(port, {
      subprotocol: `vakka.device.${DEVICE_PENDING}.${DEVICE_PENDING_SECRET}`,
    });
    expect(r.opened).toBe(false);
  });

  test("device subprotocol with wrong secret → refused", async () => {
    const port = await startServer();
    const r = await connectWs(port, {
      subprotocol: `vakka.device.${DEVICE_TRUSTED}.WRONG`,
    });
    expect(r.opened).toBe(false);
  });

  test("no subprotocol AND no query-string token → refused", async () => {
    const port = await startServer();
    const r = await connectWs(port);
    expect(r.opened).toBe(false);
  });

  test("query-string token fallback still works", async () => {
    const port = await startServer();
    const r = await connectWs(port, { query: `?token=${TOKEN}` });
    expect(r.opened).toBe(true);
  });

  test("query-string device fallback still works", async () => {
    const port = await startServer();
    const r = await connectWs(port, {
      query: `?device=${DEVICE_TRUSTED}&secret=${DEVICE_TRUSTED_SECRET}`,
    });
    expect(r.opened).toBe(true);
  });

  test("offered vakka subprotocol that doesn't match is NOT silently bypassed by query string", async () => {
    const port = await startServer();
    // Even though query-string token is valid, presence of an unrecognized
    // vakka.* subprotocol forces a refusal.
    const r = await connectWs(port, {
      query: `?token=${TOKEN}`,
      subprotocol: "vakka.bearer.WRONG",
    });
    expect(r.opened).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for validateWsAuth — exercises the parser/echo logic directly
// without needing a TCP roundtrip.
// ---------------------------------------------------------------------------
describe("validateWsAuth — subprotocol parsing", () => {
  function makeReq(headers: Record<string, string>, url = "/ws"): {
    url: string;
    headers: Record<string, string | string[] | undefined>;
  } {
    return { url, headers: { host: "127.0.0.1", ...headers } };
  }

  test("valid bearer subprotocol returns ok + matched protocol to echo", () => {
    const r = auth.validateWsAuth(
      makeReq({ "sec-websocket-protocol": `vakka.bearer.${TOKEN}` }),
    );
    expect(r.ok).toBe(true);
    expect(r.subprotocol).toBe(`vakka.bearer.${TOKEN}`);
  });

  test("valid device subprotocol returns ok + matched protocol", () => {
    const r = auth.validateWsAuth(
      makeReq({
        "sec-websocket-protocol": `vakka.device.${DEVICE_TRUSTED}.${DEVICE_TRUSTED_SECRET}`,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.subprotocol).toBe(
      `vakka.device.${DEVICE_TRUSTED}.${DEVICE_TRUSTED_SECRET}`,
    );
  });

  test("pending device subprotocol → not ok", () => {
    const r = auth.validateWsAuth(
      makeReq({
        "sec-websocket-protocol": `vakka.device.${DEVICE_PENDING}.${DEVICE_PENDING_SECRET}`,
      }),
    );
    expect(r.ok).toBe(false);
  });

  test("multi-offered list — picks the first matching vakka.* entry", () => {
    const r = auth.validateWsAuth(
      makeReq({
        "sec-websocket-protocol": `chat, vakka.bearer.${TOKEN}, vakka.device.x.y`,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.subprotocol).toBe(`vakka.bearer.${TOKEN}`);
  });

  test("query-string fallback returns ok with null subprotocol (nothing to echo)", () => {
    const r = auth.validateWsAuth(makeReq({}, `/ws?token=${TOKEN}`));
    expect(r.ok).toBe(true);
    expect(r.subprotocol).toBeNull();
  });

  test("offered vakka.* that doesn't match short-circuits — query string is NOT consulted", () => {
    const r = auth.validateWsAuth(
      makeReq(
        { "sec-websocket-protocol": "vakka.bearer.WRONG" },
        `/ws?token=${TOKEN}`,
      ),
    );
    expect(r.ok).toBe(false);
  });

  test("no creds at all → not ok", () => {
    const r = auth.validateWsAuth(makeReq({}));
    expect(r.ok).toBe(false);
  });
});
