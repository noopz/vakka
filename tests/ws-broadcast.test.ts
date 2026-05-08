import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../src/db/schema.js";
import { createSession, upsertProject } from "../src/db/queries.js";

// Seed auth config BEFORE importing websocket.ts (which transitively loads
// auth.ts that caches the config from this file).
const tmp = mkdtempSync(join(tmpdir(), "vekka-ws-test-"));
const AUTH_PATH = join(tmp, "auth.json");
const TOKEN = "test-token-123";
writeFileSync(AUTH_PATH, JSON.stringify({ token: TOKEN, devices: {} }), "utf-8");
process.env.VAKKA_AUTH_TOKEN_PATH = AUTH_PATH;

const { broadcastChatMessages, setupWebSocket } = await import("../src/web/websocket.js");
import type { NormalizedMessage } from "../src/shared/message-types.js";

let db: Database;
let server: HttpServer;
const SID = "ws-sess";

interface FakeMqtt {
  client: any;
  emit: (topic: string, payload: Buffer) => void;
}

function makeFakeMqtt(): FakeMqtt {
  const handlers: Array<(topic: string, payload: Buffer) => void> = [];
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
    removeListener(event: string, cb: any) {
      if (event === "message") {
        const i = handlers.indexOf(cb);
        if (i >= 0) handlers.splice(i, 1);
      }
      return client;
    },
  };
  return {
    client,
    emit(topic, payload) {
      for (const h of handlers) h(topic, payload);
    },
  };
}

beforeEach(async () => {
  db = initDatabase(":memory:");
  upsertProject(db, { path: "/tmp/p", name: "p" });
  createSession(db, { id: SID, project_path: "/tmp/p", model: "opus" });
});

afterEach(() => {
  if (server) server.close();
});

async function startServer(client: any): Promise<{ port: number }> {
  server = createServer();
  setupWebSocket(server, client, db);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const addr = server.address() as any;
  return { port: addr.port };
}

async function connect(port: number, sessionId: string): Promise<{ ws: WebSocket; messages: any[] }> {
  const messages: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()));
    } catch {
      messages.push(raw.toString());
    }
  });
  ws.send(JSON.stringify({ type: "subscribe", sessionId }));
  // Give server a tick to register the subscription.
  await new Promise((r) => setTimeout(r, 50));
  return { ws, messages };
}

describe("broadcastChatMessages", () => {
  test("delivers chat_messages to clients subscribed to the session", async () => {
    const { client } = makeFakeMqtt();
    const { port } = await startServer(client);
    const { ws, messages } = await connect(port, SID);

    const payload: NormalizedMessage[] = [
      { kind: "user", id: "u1", text: "hi", timestamp: Date.now() },
    ];
    broadcastChatMessages(SID, payload);

    await new Promise((r) => setTimeout(r, 80));
    ws.close();

    const got = messages.find((m) => m?.type === "chat_messages");
    expect(got).toBeDefined();
    expect(got.sessionId).toBe(SID);
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0].kind).toBe("user");
  });

  test("does NOT deliver chat_messages to clients not subscribed", async () => {
    const { client } = makeFakeMqtt();
    const { port } = await startServer(client);
    const { ws, messages } = await connect(port, "other-session");

    broadcastChatMessages(SID, [
      { kind: "user", id: "u1", text: "hi", timestamp: Date.now() },
    ]);
    await new Promise((r) => setTimeout(r, 80));
    ws.close();

    const got = messages.find((m) => m?.type === "chat_messages");
    expect(got).toBeUndefined();
  });
});

describe("raw mqtt forwarding", () => {
  test("status/cost/context still forwarded as type:'mqtt'", async () => {
    const fake = makeFakeMqtt();
    const { port } = await startServer(fake.client);
    const { ws, messages } = await connect(port, SID);

    fake.emit(`vakka/sessions/${SID}/status`, Buffer.from(JSON.stringify({ status: "running" })));
    fake.emit(`vakka/sessions/${SID}/cost`, Buffer.from(JSON.stringify({ cumulative_cost_usd: 0.01 })));
    await new Promise((r) => setTimeout(r, 80));
    ws.close();

    const status = messages.find((m) => m.type === "mqtt" && m.subtopic === "status");
    const cost = messages.find((m) => m.type === "mqtt" && m.subtopic === "cost");
    expect(status).toBeDefined();
    expect(cost).toBeDefined();
  });

  test("output streaming-delta envelope forwarded; assistant envelope NOT forwarded", async () => {
    const fake = makeFakeMqtt();
    const { port } = await startServer(fake.client);
    const { ws, messages } = await connect(port, SID);

    // stream_event passes through.
    fake.emit(
      `vakka/sessions/${SID}/output`,
      Buffer.from(
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
        }),
      ),
    );
    // assistant envelope should NOT be forwarded as type:'mqtt'.
    fake.emit(
      `vakka/sessions/${SID}/output`,
      Buffer.from(
        JSON.stringify({
          type: "assistant",
          message: { id: "m1", content: [{ type: "text", text: "yo" }] },
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 80));
    ws.close();

    const delta = messages.find(
      (m) => m.type === "mqtt" && m.subtopic === "output" && m.data?.type === "stream_event",
    );
    const assistant = messages.find(
      (m) => m.type === "mqtt" && m.subtopic === "output" && m.data?.type === "assistant",
    );
    expect(delta).toBeDefined();
    expect(assistant).toBeUndefined();
  });

  test("permission/question raw envelopes are NOT forwarded to client", async () => {
    const fake = makeFakeMqtt();
    const { port } = await startServer(fake.client);
    const { ws, messages } = await connect(port, SID);

    fake.emit(`vakka/sessions/${SID}/permission`, Buffer.from(JSON.stringify({ tool: "Bash" })));
    fake.emit(`vakka/sessions/${SID}/question`, Buffer.from(JSON.stringify({ question: "?" })));
    await new Promise((r) => setTimeout(r, 80));
    ws.close();

    const perm = messages.find((m) => m.type === "mqtt" && m.subtopic === "permission");
    const q = messages.find((m) => m.type === "mqtt" && m.subtopic === "question");
    expect(perm).toBeUndefined();
    expect(q).toBeUndefined();
  });
});
