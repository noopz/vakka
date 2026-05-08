import { describe, expect, test, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import { initDatabase } from "../src/db/schema.js";
import {
  upsertProject,
  createSession,
  updateSessionPid,
  updateSessionStartTime,
  updateSessionStatus,
  getSession,
} from "../src/db/queries.js";
import { reconcileOnStartup, awaitHello } from "../src/manager/reconcile.js";
import { isProcessAlive } from "../src/manager/spawner.js";
import { topics } from "../src/shared/mqtt.js";
import type { Database } from "bun:sqlite";

// Minimal MqttClient stub: just enough surface for awaitHello (on/off message,
// publish). Backed by EventEmitter so we can drive incoming messages from
// tests by calling stub.emit("message", topic, Buffer).
function makeMqttStub() {
  const ee = new EventEmitter();
  const published: Array<{ topic: string; payload: string }> = [];
  return {
    on: ee.on.bind(ee),
    off: ee.off.bind(ee),
    emit: ee.emit.bind(ee),
    publish: (topic: string, payload: any) => {
      published.push({ topic, payload: String(payload) });
    },
    published,
  } as any;
}

let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  upsertProject(db, { path: "/tmp/p", name: "p" });
});

describe("reconcileOnStartup (U5)", () => {
  test("reaps sessions whose PID is null", () => {
    createSession(db, { id: "s-null", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "s-null", "running");
    // pid intentionally left null

    const r = reconcileOnStartup(db);
    expect(r.reaped).toBe(1);
    expect(r.pending.length).toBe(0);
    expect(getSession(db, "s-null")?.status).toBe("failed");
  });

  test("reaps sessions whose recorded PID is dead", () => {
    createSession(db, { id: "s-dead", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "s-dead", "running");
    updateSessionPid(db, "s-dead", 99_999_999); // not alive

    const r = reconcileOnStartup(db);
    expect(r.reaped).toBe(1);
    expect(r.pending.length).toBe(0);
    expect(getSession(db, "s-dead")?.status).toBe("failed");
  });

  test("keeps sessions whose PID is alive in pending for hello confirmation", () => {
    createSession(db, { id: "s-alive", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "s-alive", "running");
    updateSessionPid(db, "s-alive", process.pid); // current process is alive
    updateSessionStartTime(db, "s-alive", Date.now());

    const r = reconcileOnStartup(db);
    expect(r.reaped).toBe(0);
    expect(r.pending.length).toBe(1);
    expect(r.pending[0].id).toBe("s-alive");
    // Status remains 'running' until awaitHello confirms or rejects.
    expect(getSession(db, "s-alive")?.status).toBe("running");
  });

  test("ignores sessions not in active states", () => {
    createSession(db, { id: "s-done", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "s-done", "completed");
    updateSessionPid(db, "s-done", 99_999_999);

    const r = reconcileOnStartup(db);
    expect(r.reaped).toBe(0);
    expect(r.pending.length).toBe(0);
  });
});

describe("awaitHello (U8)", () => {
  test("short-circuits on empty pending", async () => {
    const mqtt = makeMqttStub();
    const result = await awaitHello(mqtt, db, [], 50);
    expect(result.confirmed).toEqual([]);
    expect(result.reaped).toEqual([]);
    // No hello_request publishes when nothing to confirm.
    expect(mqtt.published.length).toBe(0);
  });

  test("confirms session when hello matches pid + start_time_ms", async () => {
    const startedAt = 1_700_000_000_000;
    createSession(db, { id: "s-ok", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "s-ok", "running");
    updateSessionPid(db, "s-ok", process.pid);
    updateSessionStartTime(db, "s-ok", startedAt);

    const mqtt = makeMqttStub();
    const pending = [getSession(db, "s-ok")!];
    const promise = awaitHello(mqtt, db, pending, 1000);

    // Drive a matching hello.
    queueMicrotask(() => {
      mqtt.emit(
        "message",
        topics("s-ok").hello,
        Buffer.from(JSON.stringify({ pid: process.pid, startTime: startedAt })),
      );
    });

    const result = await promise;
    expect(result.confirmed).toEqual(["s-ok"]);
    expect(result.reaped).toEqual([]);
    expect(getSession(db, "s-ok")?.status).toBe("running");
  });

  test("reaps session on pid mismatch (PID-reuse case)", async () => {
    const startedAt = 1_700_000_000_000;
    createSession(db, { id: "s-pidreuse", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "s-pidreuse", "running");
    updateSessionPid(db, "s-pidreuse", 99_999_999); // dead PID — won't be killed
    updateSessionStartTime(db, "s-pidreuse", startedAt);

    const mqtt = makeMqttStub();
    const pending = [getSession(db, "s-pidreuse")!];
    const promise = awaitHello(mqtt, db, pending, 1000);

    queueMicrotask(() => {
      mqtt.emit(
        "message",
        topics("s-pidreuse").hello,
        Buffer.from(JSON.stringify({ pid: 12345, startTime: startedAt })),
      );
    });

    const result = await promise;
    expect(result.confirmed).toEqual([]);
    expect(getSession(db, "s-pidreuse")?.status).toBe("failed");
  });

  test("reaps session on start_time mismatch (PID recycled to new process)", async () => {
    createSession(db, { id: "s-startmismatch", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "s-startmismatch", "running");
    updateSessionPid(db, "s-startmismatch", 99_999_999);
    updateSessionStartTime(db, "s-startmismatch", 1_700_000_000_000);

    const mqtt = makeMqttStub();
    const pending = [getSession(db, "s-startmismatch")!];
    const promise = awaitHello(mqtt, db, pending, 1000);

    queueMicrotask(() => {
      mqtt.emit(
        "message",
        topics("s-startmismatch").hello,
        Buffer.from(JSON.stringify({ pid: 99_999_999, startTime: 1_999_999_999_999 })),
      );
    });

    const result = await promise;
    expect(result.confirmed).toEqual([]);
    expect(getSession(db, "s-startmismatch")?.status).toBe("failed");
  });

  test("accepts first hello when start_time_ms was never recorded (legacy row)", async () => {
    createSession(db, { id: "s-legacy", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "s-legacy", "running");
    updateSessionPid(db, "s-legacy", process.pid);
    // Intentionally no updateSessionStartTime — legacy DB row.

    const mqtt = makeMqttStub();
    const pending = [getSession(db, "s-legacy")!];
    const promise = awaitHello(mqtt, db, pending, 1000);

    queueMicrotask(() => {
      mqtt.emit(
        "message",
        topics("s-legacy").hello,
        Buffer.from(JSON.stringify({ pid: process.pid, startTime: 1_700_000_000_000 })),
      );
    });

    const result = await promise;
    expect(result.confirmed).toEqual(["s-legacy"]);
  });

  test("reaps session on timeout when no hello arrives", async () => {
    createSession(db, { id: "s-silent", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "s-silent", "running");
    updateSessionPid(db, "s-silent", 99_999_999); // dead — no kill needed
    updateSessionStartTime(db, "s-silent", Date.now());

    const mqtt = makeMqttStub();
    const pending = [getSession(db, "s-silent")!];
    // Use a very short timeout to keep the test fast.
    const result = await awaitHello(mqtt, db, pending, 50);

    expect(result.confirmed).toEqual([]);
    expect(result.reaped).toEqual(["s-silent"]);
    expect(getSession(db, "s-silent")?.status).toBe("failed");
  });

  test("kills alive-but-unresponsive PID on timeout", async () => {
    // Spawn a real subprocess that won't talk to MQTT — simulates a stuck
    // wrapper or a recycled PID. awaitHello should mark failed AND SIGTERM it.
    const proc = Bun.spawn(["sleep", "30"]);
    expect(isProcessAlive(proc.pid)).toBe(true);

    createSession(db, { id: "s-stuck", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "s-stuck", "running");
    updateSessionPid(db, "s-stuck", proc.pid);
    updateSessionStartTime(db, "s-stuck", Date.now());

    const mqtt = makeMqttStub();
    const pending = [getSession(db, "s-stuck")!];
    const result = await awaitHello(mqtt, db, pending, 50);

    expect(result.reaped).toEqual(["s-stuck"]);
    expect(getSession(db, "s-stuck")?.status).toBe("failed");

    // Subprocess should have received SIGTERM and exited.
    await proc.exited;
    let alive = isProcessAlive(proc.pid);
    for (let i = 0; alive && i < 5; i++) {
      await Bun.sleep(20);
      alive = isProcessAlive(proc.pid);
    }
    expect(alive).toBe(false);
  });

  test("publishes hello_request immediately on entry", async () => {
    createSession(db, { id: "s-req", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "s-req", "running");
    updateSessionPid(db, "s-req", 99_999_999);

    const mqtt = makeMqttStub();
    const promise = awaitHello(mqtt, db, [getSession(db, "s-req")!], 30);
    // The very first publish (attempt: 0) fires synchronously in awaitHello.
    expect(mqtt.published.length).toBeGreaterThanOrEqual(1);
    expect(mqtt.published[0].topic).toBe("vakka/system/manager/hello_request");
    await promise;
  });
});
