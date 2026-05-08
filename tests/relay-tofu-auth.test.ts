import { describe, expect, test } from "bun:test";
import express from "express";
import { createCcRcRelay } from "../src/relay/cc-rc-relay.js";

function makeApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  const relay = createCcRcRelay({ log: () => {} });
  app.use(relay.router);
  return { app, relay };
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

describe("relay TOFU JWT pin", () => {
  test("first request with bearer pins; same bearer accepted", async () => {
    const { app } = makeApp();
    await withServer(app, async (port) => {
      const r1 = await fetch(
        `http://127.0.0.1:${port}/v1/code/sessions/A/worker`,
        { headers: { Authorization: "Bearer jwt-1" } },
      );
      expect(r1.status).toBe(200);

      const r2 = await fetch(
        `http://127.0.0.1:${port}/v1/code/sessions/A/worker`,
        { headers: { Authorization: "Bearer jwt-1" } },
      );
      expect(r2.status).toBe(200);
    });
  });

  test("mismatched bearer for pinned session → 401", async () => {
    const { app } = makeApp();
    await withServer(app, async (port) => {
      const r1 = await fetch(
        `http://127.0.0.1:${port}/v1/code/sessions/A/worker`,
        { headers: { Authorization: "Bearer jwt-1" } },
      );
      expect(r1.status).toBe(200);

      const r2 = await fetch(
        `http://127.0.0.1:${port}/v1/code/sessions/A/worker`,
        { headers: { Authorization: "Bearer jwt-2" } },
      );
      expect(r2.status).toBe(401);
    });
  });

  test("missing Authorization → 401", async () => {
    const { app } = makeApp();
    await withServer(app, async (port) => {
      const r = await fetch(
        `http://127.0.0.1:${port}/v1/code/sessions/A/worker`,
      );
      expect(r.status).toBe(401);
    });
  });

  test("different cseId is independently pinned", async () => {
    const { app } = makeApp();
    await withServer(app, async (port) => {
      const r1 = await fetch(
        `http://127.0.0.1:${port}/v1/code/sessions/A/worker`,
        { headers: { Authorization: "Bearer jwt-1" } },
      );
      expect(r1.status).toBe(200);

      const r2 = await fetch(
        `http://127.0.0.1:${port}/v1/code/sessions/B/worker`,
        { headers: { Authorization: "Bearer jwt-2" } },
      );
      expect(r2.status).toBe(200);
    });
  });

  test("POST /worker/events enforces pin", async () => {
    const { app } = makeApp();
    await withServer(app, async (port) => {
      const r1 = await fetch(
        `http://127.0.0.1:${port}/v1/code/sessions/X/worker/events`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: "Bearer jwt-x",
          },
          body: JSON.stringify({ events: [] }),
        },
      );
      expect(r1.status).toBe(200);

      const r2 = await fetch(
        `http://127.0.0.1:${port}/v1/code/sessions/X/worker/events`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: "Bearer jwt-other",
          },
          body: JSON.stringify({ events: [] }),
        },
      );
      expect(r2.status).toBe(401);
    });
  });

  test("PATCH /v1/sessions/:sessionId enforces pin", async () => {
    const { app } = makeApp();
    await withServer(app, async (port) => {
      const r1 = await fetch(
        `http://127.0.0.1:${port}/v1/sessions/sess-1`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            Authorization: "Bearer jwt-s",
          },
          body: JSON.stringify({ title: "t" }),
        },
      );
      expect(r1.status).toBe(200);

      const r2 = await fetch(
        `http://127.0.0.1:${port}/v1/sessions/sess-1`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            Authorization: "Bearer jwt-other",
          },
          body: JSON.stringify({ title: "t" }),
        },
      );
      expect(r2.status).toBe(401);
    });
  });

  test("SSE stream: first opens, mismatched bearer on second connect → 401", async () => {
    const { app } = makeApp();
    await withServer(app, async (port) => {
      // Open first SSE with jwt-1 (this pins)
      const ctrl = new AbortController();
      const sse1 = await fetch(
        `http://127.0.0.1:${port}/v1/code/sessions/S/worker/events/stream`,
        { headers: { Authorization: "Bearer jwt-1" }, signal: ctrl.signal },
      );
      expect(sse1.status).toBe(200);

      // Mismatched second connect → 401
      const sse2 = await fetch(
        `http://127.0.0.1:${port}/v1/code/sessions/S/worker/events/stream`,
        { headers: { Authorization: "Bearer jwt-2" } },
      );
      expect(sse2.status).toBe(401);

      ctrl.abort();
      // Drain to avoid leaking
      try { await sse1.body?.cancel(); } catch {}
    });
  });
});
