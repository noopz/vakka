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

describe("relay /vk/push HTTP route removed", () => {
  test("POST /vk/sessions/x/push with no auth → 404", async () => {
    const { app } = makeApp();
    await withServer(app, async (port) => {
      const r = await fetch(
        `http://127.0.0.1:${port}/vk/sessions/x/push`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: { foo: "bar" } }),
        },
      );
      expect(r.status).toBe(404);
    });
  });

  test("POST /vk/sessions/x/push with bearer → 404", async () => {
    const { app } = makeApp();
    await withServer(app, async (port) => {
      const r = await fetch(
        `http://127.0.0.1:${port}/vk/sessions/x/push`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: "Bearer anything",
          },
          body: JSON.stringify({ data: { foo: "bar" } }),
        },
      );
      expect(r.status).toBe(404);
    });
  });

  test("in-process pushFrame method still works", () => {
    const { relay } = makeApp();
    // No SSE clients connected → 0 delivered, but call must not throw.
    const delivered = relay.pushFrame("session-z", {
      data: { type: "test", foo: "bar" },
    });
    expect(delivered).toBe(0);

    // listSessions should now include the session.
    expect(relay.listSessions()).toContain("session-z");
    const state = relay.getState("session-z");
    expect(state).toBeDefined();
    expect(state?.cseId).toBe("session-z");
  });
});
