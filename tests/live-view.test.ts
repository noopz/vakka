import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../src/db/schema.js";
import {
  upsertProject,
  createSession,
  updateSessionPid,
  updateSessionStartTime,
  updateSessionSdkId,
  updateSessionStatus,
} from "../src/db/queries.js";
import { buildLiveView, _clearLiveViewCache } from "../src/manager/live-view.js";
import type { LiveProcess } from "../src/manager/live-processes.js";

const PROJECT_PATH = "/Users/test/proj";
const PROJECT_KEY = "-Users-test-proj";

function project(path = PROJECT_PATH, slug = "test-proj") {
  return { path, display_slug: slug };
}

function jsonl(records: object[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

let db: Database;
let tmpRoot: string;

beforeEach(() => {
  db = initDatabase(":memory:");
  upsertProject(db, { path: PROJECT_PATH, name: "proj" });
  tmpRoot = mkdtempSync(join(tmpdir(), "vakka-liveview-"));
  _clearLiveViewCache();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeJsonl(uuid: string, key = PROJECT_KEY, cwd = PROJECT_PATH) {
  const dir = join(tmpRoot, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${uuid}.jsonl`),
    jsonl([
      { type: "user", sessionId: uuid, cwd, message: { content: "hi" } },
      {
        type: "assistant",
        sessionId: uuid,
        message: { content: [{ type: "text", text: "yo" }] },
      },
    ]),
  );
}

describe("buildLiveView", () => {
  test("Vakka-only project emits one wrapper row", async () => {
    createSession(db, { id: "v1", project_path: PROJECT_PATH, model: "opus" });
    updateSessionPid(db, "v1", 9001);
    updateSessionStartTime(db, "v1", 1700000000000);
    updateSessionStatus(db, "v1", "running");

    const view = await buildLiveView({
      db,
      liveProcesses: [],
      projects: [project()],
      projectsRoot: tmpRoot,
    });
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({
      origin: "vakka",
      transport: "wrapper",
      vakka_session_id: "v1",
      pid: 9001,
      slug: "test-proj",
      project_path: PROJECT_PATH,
      permission_pending: false,
      status_verb: "running",
    });
    expect(view[0].started_at).toBe(new Date(1700000000000).toISOString());
  });

  test("external CLI in registered project resolves slug + sdk_session_id", async () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    makeJsonl(uuid);
    const subdir = `${PROJECT_PATH}/sub`;
    const subKey = "-Users-test-proj-sub";
    makeJsonl(uuid, subKey, subdir);

    const lp: LiveProcess[] = [
      { pid: 7777, cwd: subdir, kind: "cc-cli", manifest_mtime: "2026-05-01T00:00:00.000Z" },
    ];
    const view = await buildLiveView({
      db,
      liveProcesses: lp,
      projects: [project()],
      projectsRoot: tmpRoot,
    });
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({
      origin: "external",
      transport: "cli",
      slug: "test-proj",
      project_path: PROJECT_PATH,
      cwd: subdir,
      cwd_basename: "sub",
      pid: 7777,
      sdk_session_id: uuid,
      cost_usd: 0,
    });
  });

  test("RC row from registry-confirmed cseId emits cse_id", async () => {
    const lp: LiveProcess[] = [
      {
        pid: 8001,
        cwd: PROJECT_PATH,
        kind: "rc",
        manifest_mtime: "2026-05-01T00:00:00.000Z",
        cseId: "cse_abc",
        cseFromRegistry: true,
        workerStatus: "running",
        cumulativeCostUsd: 0.42,
      },
    ];
    const view = await buildLiveView({
      db,
      liveProcesses: lp,
      projects: [project()],
      projectsRoot: tmpRoot,
      resolveSdkId: async () => null,
    });
    expect(view[0].cse_id).toBe("cse_abc");
    expect(view[0].origin).toBe("external");
    expect(view[0].transport).toBe("rc");
    expect(view[0].cost_usd).toBe(0.42);
  });

  test("RC row from synthetic cseId fallback emits cse_id null", async () => {
    const lp: LiveProcess[] = [
      {
        pid: 8002,
        cwd: PROJECT_PATH,
        kind: "rc",
        manifest_mtime: "2026-05-01T00:00:00.000Z",
        cseId: "cse_synthetic",
        cseFromRegistry: false,
      },
    ];
    const view = await buildLiveView({
      db,
      liveProcesses: lp,
      projects: [project()],
      projectsRoot: tmpRoot,
      resolveSdkId: async () => null,
    });
    expect(view[0].cse_id).toBeNull();
    expect(view[0].origin).toBe("external");
    expect(view[0].transport).toBe("rc");
  });

  test("dedup is pid-only and cc-cli only", async () => {
    createSession(db, { id: "v1", project_path: PROJECT_PATH, model: "opus", pid: 5000 });
    updateSessionStatus(db, "v1", "running");

    const lp: LiveProcess[] = [
      // cc-cli with same pid as wrapper → dropped.
      { pid: 5000, cwd: PROJECT_PATH, kind: "cc-cli", manifest_mtime: "2026-05-01T00:00:00.000Z" },
      // RC with same pid as wrapper → kept (pid-join unreachable for RC; v1 invariant).
      {
        pid: 5000,
        cwd: PROJECT_PATH,
        kind: "rc",
        manifest_mtime: "2026-05-01T00:00:01.000Z",
        cseId: "cse_xyz",
        cseFromRegistry: true,
      },
    ];
    const view = await buildLiveView({
      db,
      liveProcesses: lp,
      projects: [project()],
      projectsRoot: tmpRoot,
      resolveSdkId: async () => null,
    });
    const transports = view.map((v) => v.transport).sort();
    expect(transports).toEqual(["rc", "wrapper"]);
  });

  test("perf invariant: resolver not called for wrapper rows", async () => {
    createSession(db, { id: "v1", project_path: PROJECT_PATH, model: "opus", pid: 9999 });
    updateSessionStatus(db, "v1", "running");
    updateSessionSdkId(db, "v1", "abc");

    let calls = 0;
    const lp: LiveProcess[] = [
      { pid: 1234, cwd: PROJECT_PATH, kind: "cc-cli", manifest_mtime: "2026-05-01T00:00:00.000Z" },
    ];
    await buildLiveView({
      db,
      liveProcesses: lp,
      projects: [project()],
      projectsRoot: tmpRoot,
      resolveSdkId: async () => {
        calls++;
        return null;
      },
    });
    // One external row → exactly one resolver call. Wrapper row uses
    // sessions.sdk_session_id directly, never invokes the resolver.
    expect(calls).toBe(1);
  });

  test("pre-migration start_time_ms null emits started_at null", async () => {
    createSession(db, { id: "v1", project_path: PROJECT_PATH, model: "opus" });
    updateSessionStatus(db, "v1", "running");
    const view = await buildLiveView({
      db,
      liveProcesses: [],
      projects: [project()],
      projectsRoot: tmpRoot,
    });
    expect(view[0].started_at).toBeNull();
  });

  test("cwd matching no project: project_path null but sdk_session_id still resolved", async () => {
    const orphanCwd = "/Users/test/orphan";
    const orphanKey = "-Users-test-orphan";
    const uuid = "22222222-2222-4222-8222-222222222222";
    makeJsonl(uuid, orphanKey, orphanCwd);
    const lp: LiveProcess[] = [
      { pid: 4242, cwd: orphanCwd, kind: "cc-cli", manifest_mtime: "2026-05-01T00:00:00.000Z" },
    ];
    const view = await buildLiveView({
      db,
      liveProcesses: lp,
      projects: [project()],
      projectsRoot: tmpRoot,
    });
    expect(view[0].project_path).toBeNull();
    expect(view[0].slug).toBeNull();
    expect(view[0].sdk_session_id).toBe(uuid);
  });

  test("tiebreaker stable when last_activity ties", async () => {
    const lp: LiveProcess[] = [
      { pid: 200, cwd: PROJECT_PATH, kind: "cc-cli", manifest_mtime: "2026-05-01T00:00:00.000Z" },
      { pid: 100, cwd: PROJECT_PATH, kind: "cc-cli", manifest_mtime: "2026-05-01T00:00:00.000Z" },
    ];
    const a = await buildLiveView({
      db,
      liveProcesses: lp,
      projects: [project()],
      projectsRoot: tmpRoot,
      resolveSdkId: async () => null,
    });
    const b = await buildLiveView({
      db,
      liveProcesses: [...lp].reverse(),
      projects: [project()],
      projectsRoot: tmpRoot,
      resolveSdkId: async () => null,
    });
    expect(a.map((v) => v.pid)).toEqual(b.map((v) => v.pid));
  });

  test("sort by last_activity desc", async () => {
    const lp: LiveProcess[] = [
      { pid: 1, cwd: PROJECT_PATH, kind: "cc-cli", manifest_mtime: "2026-05-01T00:00:00.000Z" },
      { pid: 2, cwd: PROJECT_PATH, kind: "cc-cli", manifest_mtime: "2026-05-02T00:00:00.000Z" },
      { pid: 3, cwd: PROJECT_PATH, kind: "cc-cli", manifest_mtime: "2026-05-03T00:00:00.000Z" },
    ];
    const view = await buildLiveView({
      db,
      liveProcesses: lp,
      projects: [project()],
      projectsRoot: tmpRoot,
      resolveSdkId: async () => null,
    });
    expect(view.map((v) => v.pid)).toEqual([3, 2, 1]);
  });

  test("Vakka starting status maps to status_verb 'starting'", async () => {
    createSession(db, { id: "v1", project_path: PROJECT_PATH, model: "opus" });
    // status defaults to 'starting' from schema.
    const view = await buildLiveView({
      db,
      liveProcesses: [],
      projects: [project()],
      projectsRoot: tmpRoot,
    });
    expect(view[0].status_verb).toBe("starting");
  });

  test("waiting_permission sets permission_pending true", async () => {
    createSession(db, { id: "v1", project_path: PROJECT_PATH, model: "opus" });
    updateSessionStatus(db, "v1", "waiting_permission");
    const view = await buildLiveView({
      db,
      liveProcesses: [],
      projects: [project()],
      projectsRoot: tmpRoot,
    });
    expect(view[0].permission_pending).toBe(true);
    expect(view[0].status_verb).toBe("awaiting permission");
  });

  test("longest-prefix wins when multiple projects could match", async () => {
    const inner = `${PROJECT_PATH}/inner`;
    upsertProject(db, { path: inner, name: "inner" });
    const lp: LiveProcess[] = [
      { pid: 555, cwd: `${inner}/x`, kind: "cc-cli", manifest_mtime: "2026-05-01T00:00:00.000Z" },
    ];
    const view = await buildLiveView({
      db,
      liveProcesses: lp,
      projects: [project(), project(inner, "inner")],
      projectsRoot: tmpRoot,
      resolveSdkId: async () => null,
    });
    expect(view[0].project_path).toBe(inner);
    expect(view[0].slug).toBe("inner");
  });
});
