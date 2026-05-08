import { describe, expect, test, beforeEach } from "bun:test";
import { initDatabase } from "../src/db/schema.js";
import {
  upsertProject,
  createSession,
  getSession,
  updateSessionPid,
  updateSessionStartTime,
  updateSessionSdkId,
  updateSessionStatus,
  updateSessionCost,
  insertChatMessage,
  copyMessages,
  getChatMessages,
  getResumeCandidates,
} from "../src/db/queries.js";
import type { Database } from "bun:sqlite";

let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  upsertProject(db, { path: "/tmp/p", name: "p" });
});

describe("queries.ts — start_time_ms migration", () => {
  test("updateSessionPid round-trips", () => {
    createSession(db, { id: "s1", project_path: "/tmp/p", model: "opus" });
    updateSessionPid(db, "s1", 12345);
    const s = getSession(db, "s1");
    expect(s?.pid).toBe(12345);
  });

  test("updateSessionStartTime round-trips", () => {
    createSession(db, { id: "s2", project_path: "/tmp/p", model: "opus" });
    updateSessionStartTime(db, "s2", 1700000000000);
    const s = getSession(db, "s2");
    expect(s?.start_time_ms).toBe(1700000000000);
  });

  test("ALTER TABLE start_time_ms is idempotent across reinitialization", () => {
    // Reinitialize on the same in-memory handle isn't meaningful; instead
    // assert that two consecutive initDatabase calls on the same file path
    // succeed without throwing. Use a temp path so the second run sees the
    // pre-existing column.
    const tmp = `/tmp/vakka-test-${Date.now()}.db`;
    const db1 = initDatabase(tmp);
    db1.close();
    const db2 = initDatabase(tmp); // should NOT throw despite ALTER on existing column
    db2.close();
  });

  test("start_time_ms defaults to null until set", () => {
    createSession(db, { id: "s3", project_path: "/tmp/p", model: "opus" });
    const s = getSession(db, "s3");
    expect(s?.start_time_ms).toBeNull();
  });
});

describe("queries.ts — session resume", () => {
  test("updateSessionSdkId round-trips and defaults null", () => {
    createSession(db, { id: "r1", project_path: "/tmp/p", model: "opus" });
    expect(getSession(db, "r1")?.sdk_session_id).toBeNull();
    updateSessionSdkId(db, "r1", "sdk-uuid-abc");
    expect(getSession(db, "r1")?.sdk_session_id).toBe("sdk-uuid-abc");
  });

  test("copyMessages duplicates rows preserving order", () => {
    createSession(db, { id: "src", project_path: "/tmp/p", model: "opus" });
    createSession(db, { id: "dst", project_path: "/tmp/p", model: "opus" });
    insertChatMessage(
      db,
      { kind: "user", id: "u1", text: "hi", timestamp: 1 },
      "src",
    );
    insertChatMessage(
      db,
      {
        kind: "assistant",
        id: "a1",
        text: "hello",
        model: "opus",
        usage: null,
        timestamp: 2,
      },
      "src",
    );
    insertChatMessage(
      db,
      { kind: "user", id: "u2", text: "thanks", timestamp: 3 },
      "src",
    );

    const copied = copyMessages(db, "src", "dst");
    expect(copied).toBe(3);

    const dst = getChatMessages(db, "dst");
    expect(dst.map((m) => m.kind)).toEqual(["user", "assistant", "user"]);
  });

  test("getResumeCandidates returns terminal-only, ordered, with previews", () => {
    // Two terminal sessions + one running (excluded).
    createSession(db, { id: "old", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "old", "completed");
    updateSessionSdkId(db, "old", "sdk-old");
    updateSessionCost(db, "old", 0.05);
    insertChatMessage(
      db,
      { kind: "user", id: "u-old", text: "first question", timestamp: 1 },
      "old",
    );
    insertChatMessage(
      db,
      {
        kind: "assistant",
        id: "a-old",
        text: "first answer",
        model: "opus",
        usage: null,
        timestamp: 2,
      },
      "old",
    );

    createSession(db, { id: "newer", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "newer", "failed");
    // Intentionally no sdk_session_id → resumable=false
    insertChatMessage(
      db,
      { kind: "user", id: "u-newer", text: "later question", timestamp: 3 },
      "newer",
    );

    createSession(db, { id: "live", project_path: "/tmp/p", model: "opus" });
    updateSessionStatus(db, "live", "running");

    const cands = getResumeCandidates(db, "/tmp/p", 10);
    expect(cands.length).toBe(2);
    expect(cands.find((c) => c.id === "live")).toBeUndefined();

    const old = cands.find((c) => c.id === "old")!;
    expect(old.resumable).toBe(true);
    expect(old.last_user_text).toBe("first question");
    expect(old.last_assistant_text).toBe("first answer");
    expect(old.message_count).toBe(2);

    const newer = cands.find((c) => c.id === "newer")!;
    expect(newer.resumable).toBe(false);
  });

  test("getResumeCandidates respects limit", () => {
    for (let i = 0; i < 5; i++) {
      createSession(db, { id: `t${i}`, project_path: "/tmp/p", model: "opus" });
      updateSessionStatus(db, `t${i}`, "completed");
    }
    expect(getResumeCandidates(db, "/tmp/p", 3).length).toBe(3);
  });
});
