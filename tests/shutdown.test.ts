import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { initDatabase } from "../src/db/schema.js";
import {
  upsertProject,
  createSession,
  updateSessionPid,
  updateSessionStatus,
  getSession,
  getActiveSessions,
} from "../src/db/queries.js";
import { shutdown, setRestarting, _resetShuttingDownForTests } from "../src/manager/shutdown.js";
import { unlinkSync, existsSync } from "fs";

// shutdown.ts closes its db dep, so we use a file-based DB and re-open a
// fresh handle after shutdown to assert persisted state.
function tmpDbPath(): string {
  return `/tmp/vakka-shutdown-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`;
}

function makeMqttStub() {
  return {
    publish: (
      _topic: string,
      _payload: string,
      _opts: any,
      cb?: (err?: Error | null) => void,
    ) => {
      cb?.(null);
    },
    end: (_force: boolean, _opts: any, cb?: () => void) => {
      cb?.();
    },
  } as any;
}

let dbPath: string;
let originalExit: typeof process.exit;
let exitCode: number | null;

beforeEach(() => {
  dbPath = tmpDbPath();
  exitCode = null;
  originalExit = process.exit;
  // @ts-expect-error — stubbing for tests
  process.exit = (code: number) => {
    exitCode = code;
    throw new Error(`__test_exit_${code}`);
  };
  setRestarting(false);
  _resetShuttingDownForTests();
});

afterEach(() => {
  process.exit = originalExit;
  setRestarting(false);
  for (const ext of ["", "-shm", "-wal"]) {
    const p = dbPath + ext;
    if (existsSync(p)) try { unlinkSync(p); } catch {}
  }
});

describe("shutdown — kill semantics (U4)", () => {
  test("SIGTERM kills active agents (restarting=false) and exits 0", () => {
    const db = initDatabase(dbPath);
    upsertProject(db, { path: "/tmp/p", name: "p" });
    createSession(db, { id: "s1", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "s1", "running");
    updateSessionPid(db, "s1", 99_999_998);

    const scanTimer = setInterval(() => {}, 1_000_000);
    try {
      shutdown("SIGTERM", { db, mqttClient: makeMqttStub(), scanTimer });
    } catch (e: any) {
      expect(e.message).toMatch(/__test_exit_/);
    }
    expect(exitCode).toBe(0);
    clearInterval(scanTimer);

    // Reopen a fresh handle to verify persisted state.
    const verify = initDatabase(dbPath);
    expect(getSession(verify, "s1")?.status).toBe("completed");
    expect(getActiveSessions(verify).length).toBe(0);
    verify.close();
  });

  test("hot-restart preserves active agents (restarting=true) and exits 42", () => {
    const db = initDatabase(dbPath);
    upsertProject(db, { path: "/tmp/p", name: "p" });
    createSession(db, { id: "s2", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "s2", "running");
    updateSessionPid(db, "s2", 99_999_997);

    setRestarting(true);
    const scanTimer = setInterval(() => {}, 1_000_000);
    try {
      shutdown("RESTART", { db, mqttClient: makeMqttStub(), scanTimer });
    } catch (e: any) {
      expect(e.message).toMatch(/__test_exit_/);
    }
    expect(exitCode).toBe(42);
    clearInterval(scanTimer);

    const verify = initDatabase(dbPath);
    expect(getSession(verify, "s2")?.status).toBe("running");
    verify.close();
  });

  test("SIGINT path is identical to SIGTERM (signals always kill)", () => {
    const db = initDatabase(dbPath);
    upsertProject(db, { path: "/tmp/p", name: "p" });
    createSession(db, { id: "s3", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "s3", "running");
    updateSessionPid(db, "s3", 99_999_996);

    const scanTimer = setInterval(() => {}, 1_000_000);
    try {
      shutdown("SIGINT", { db, mqttClient: makeMqttStub(), scanTimer });
    } catch { /* exit thrown */ }
    expect(exitCode).toBe(0);
    clearInterval(scanTimer);

    const verify = initDatabase(dbPath);
    expect(getSession(verify, "s3")?.status).toBe("completed");
    verify.close();
  });
});
