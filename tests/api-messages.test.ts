import { beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../src/db/schema.js";
import { createSession, insertChatMessage, upsertProject } from "../src/db/queries.js";
import { createApiRouter } from "../src/web/api.js";
import type { NormalizedMessage } from "../src/shared/message-types.js";

let db: Database;
const SID = "sess-api";
const PROJECT = "/tmp/api-proj";

interface Pub {
  topic: string;
  payload: string;
}

function makeFakeMqtt(): { publishes: Pub[]; client: any } {
  const publishes: Pub[] = [];
  const client = {
    publish(topic: string, payload: string | Buffer) {
      publishes.push({ topic, payload: typeof payload === "string" ? payload : payload.toString() });
    },
    subscribe(_t: string | string[], cb?: (err: Error | null) => void) {
      cb?.(null);
    },
    unsubscribe() {},
    on() {
      return client;
    },
    removeListener() {
      return client;
    },
  };
  return { publishes, client };
}

function makeApp(mqttClient: any) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(createApiRouter(db, mqttClient));
  return app;
}

beforeEach(() => {
  db = initDatabase(":memory:");
  upsertProject(db, { path: PROJECT, name: "p" });
  createSession(db, { id: SID, project_path: PROJECT, model: "opus" });
});

async function reqJson(app: express.Express, method: "GET" | "POST", path: string, body?: any) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const server = (app as any).listen(0, async () => {
      try {
        const port = (server.address() as any).port;
        const fres = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await fres.text();
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        server.close();
        resolve({ status: fres.status, body: parsed });
      } catch (e) {
        server.close();
        reject(e);
      }
    });
  });
}

describe("GET /api/sessions/:id/messages → NormalizedMessage[]", () => {
  test("returns rows with kind discriminators", async () => {
    insertChatMessage(
      db,
      { kind: "user", id: "u1", text: "hello", timestamp: Date.now() },
      SID,
    );
    insertChatMessage(
      db,
      {
        kind: "assistant",
        id: "a1",
        text: "world",
        model: "opus",
        usage: null,
        timestamp: Date.now(),
      },
      SID,
    );
    const { client } = makeFakeMqtt();
    const app = makeApp(client);
    const r = await reqJson(app, "GET", `/sessions/${SID}/messages`);
    expect(r.status).toBe(200);
    const messages = r.body as NormalizedMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[0].kind).toBe("user");
    expect(messages[1].kind).toBe("assistant");
  });

  test("?includeHidden=1 returns hidden user rows", async () => {
    // Empty user text gets hidden_from_render=1 by insertChatMessage.
    insertChatMessage(
      db,
      { kind: "user", id: "u-hidden", text: "", timestamp: Date.now() },
      SID,
    );
    insertChatMessage(
      db,
      { kind: "user", id: "u-vis", text: "visible", timestamp: Date.now() },
      SID,
    );
    const { client } = makeFakeMqtt();
    const app = makeApp(client);

    const def = await reqJson(app, "GET", `/sessions/${SID}/messages`);
    expect(def.body).toHaveLength(1);

    const all = await reqJson(app, "GET", `/sessions/${SID}/messages?includeHidden=1`);
    expect(all.body).toHaveLength(2);
  });
});

describe("POST /sessions/:id/plan-response", () => {
  test("updates plan_proposal row to approved + publishes permission_response", async () => {
    insertChatMessage(
      db,
      {
        kind: "plan_proposal",
        id: "p1",
        plan: "# do it",
        status: "pending",
        toolUseId: "tu-plan-x",
        timestamp: Date.now(),
      },
      SID,
    );
    const { publishes, client } = makeFakeMqtt();
    const app = makeApp(client);

    const r = await reqJson(app, "POST", `/sessions/${SID}/plan-response`, {
      approved: true,
      toolUseId: "tu-plan-x",
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const get = await reqJson(app, "GET", `/sessions/${SID}/messages`);
    const plan = (get.body as NormalizedMessage[]).find((m) => m.kind === "plan_proposal");
    expect(plan?.kind).toBe("plan_proposal");
    if (plan?.kind === "plan_proposal") expect(plan.status).toBe("approved");

    const pub = publishes.find((p) => p.topic.endsWith("/permission_response"));
    expect(pub).toBeDefined();
    const payload = JSON.parse(pub!.payload);
    expect(payload.tool).toBe("ExitPlanMode");
    expect(payload.decision).toBe("allow");
    expect(payload.toolUseId).toBe("tu-plan-x");
  });

  test("rejected with feedback persists feedback", async () => {
    insertChatMessage(
      db,
      {
        kind: "plan_proposal",
        id: "p1",
        plan: "# stuff",
        status: "pending",
        toolUseId: "tu-plan-y",
        timestamp: Date.now(),
      },
      SID,
    );
    const { client } = makeFakeMqtt();
    const app = makeApp(client);
    await reqJson(app, "POST", `/sessions/${SID}/plan-response`, {
      approved: false,
      feedback: "needs more detail",
      toolUseId: "tu-plan-y",
    });
    const get = await reqJson(app, "GET", `/sessions/${SID}/messages`);
    const plan = (get.body as NormalizedMessage[]).find((m) => m.kind === "plan_proposal");
    expect(plan?.kind).toBe("plan_proposal");
    if (plan?.kind === "plan_proposal") {
      expect(plan.status).toBe("rejected");
      expect(plan.feedback).toBe("needs more detail");
    }
  });
});

describe("GET /sessions/:id/messages hidden-row filtering", () => {
  test("hidden user row is omitted by default but returned with includeHidden=1", async () => {
    // Empty user text triggers hidden_from_render=1 in insertChatMessage.
    insertChatMessage(
      db,
      { kind: "user", id: "u-hidden-row", text: "", timestamp: Date.now() },
      SID,
    );
    insertChatMessage(
      db,
      { kind: "user", id: "u-shown-row", text: "shown", timestamp: Date.now() },
      SID,
    );

    const { client } = makeFakeMqtt();
    const app = makeApp(client);

    const def = await reqJson(app, "GET", `/sessions/${SID}/messages`);
    expect(def.status).toBe(200);
    const defMsgs = def.body as NormalizedMessage[];
    expect(defMsgs).toHaveLength(1);
    expect(defMsgs[0].kind).toBe("user");
    if (defMsgs[0].kind === "user") expect(defMsgs[0].text).toBe("shown");

    const all = await reqJson(app, "GET", `/sessions/${SID}/messages?includeHidden=1`);
    expect(all.status).toBe(200);
    const allMsgs = all.body as NormalizedMessage[];
    expect(allMsgs).toHaveLength(2);
    const texts = allMsgs.map((m) => (m.kind === "user" ? m.text : ""));
    expect(texts).toContain("");
    expect(texts).toContain("shown");
  });
});

describe("GET /sessions/:id/messages/count", () => {
  test("returns total", async () => {
    insertChatMessage(db, { kind: "user", id: "u1", text: "hi", timestamp: Date.now() }, SID);
    insertChatMessage(db, { kind: "user", id: "u2", text: "ho", timestamp: Date.now() }, SID);
    const { client } = makeFakeMqtt();
    const app = makeApp(client);
    const r = await reqJson(app, "GET", `/sessions/${SID}/messages/count`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
  });
});
