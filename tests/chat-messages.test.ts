import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../src/db/schema.js";
import {
  copyMessages,
  createSession,
  getChatMessages,
  getChatMessagesBefore,
  getLatestMessageId,
  getMessageCount,
  getResumeCandidates,
  getToolUseByCorrelationId,
  insertChatMessage,
  updateChatMessageStatus,
  updateSessionCost,
  updateSessionSdkId,
  updateSessionStatus,
  upsertProject,
} from "../src/db/queries.js";
import { rowToNormalizedMessage } from "../src/manager/chat-message-projection.js";
import type { NormalizedMessage } from "../src/shared/message-types.js";

let db: Database;
const SID = "s1";

function setup(sessionId = SID): void {
  upsertProject(db, { path: "/tmp/p", name: "p" });
  createSession(db, { id: sessionId, project_path: "/tmp/p", model: "opus" });
}

beforeEach(() => {
  db = initDatabase(":memory:");
  setup();
});

// ── Per-kind round-trip helpers ──────────────────────────────────────

const TS = 1_700_000_000_000;

const fixtures: Record<string, () => NormalizedMessage> = {
  user: () => ({ kind: "user", id: "u1", text: "hi there", timestamp: TS }),
  assistant: () => ({
    kind: "assistant",
    id: "a1",
    text: "hello",
    model: "claude-opus-4",
    usage: {
      inputTokens: 12,
      outputTokens: 34,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 6,
    },
    timestamp: TS,
  }),
  tool_use: () => ({
    kind: "tool_use",
    id: "tu1",
    parentId: "a1",
    toolUseId: "toolu_abc",
    toolName: "Bash",
    toolSummary: "$ ls -la",
    toolInput: { command: "ls -la", description: "list" },
    timestamp: TS,
  }),
  tool_result: () => ({
    kind: "tool_result",
    id: "tr1",
    toolUseId: "toolu_abc",
    toolName: "Bash",
    toolSummary: "$ ls -la",
    output: "file1\nfile2",
    isError: false,
    timestamp: TS,
  }),
  system: () => ({ kind: "system", id: "sy1", text: "notice", timestamp: TS }),
  compact: () => ({
    kind: "compact",
    id: "c1",
    preTokens: 1000,
    postTokens: 200,
    trigger: "manual",
    timestamp: TS,
  }),
  compact_summary: () => ({
    kind: "compact_summary",
    id: "cs1",
    text: "summary text",
    timestamp: TS,
  }),
  permission_request: () => ({
    kind: "permission_request",
    id: "p1",
    tool: "Bash",
    input: { command: "rm -rf /" },
    alwaysAsk: true,
    status: "pending",
    toolUseId: "toolu_perm_1",
    timestamp: TS,
  }),
  question: () => ({
    kind: "question",
    id: "q1",
    questions: [
      {
        question: "Pick one",
        header: "Choice",
        options: [{ label: "A" }, { label: "B" }],
        allowFreeText: false,
        multiSelect: false,
      },
    ],
    status: "pending",
    questionId: "q-uuid-1",
    toolUseId: "toolu_q_1",
    timestamp: TS,
  }),
  plan_proposal: () => ({
    kind: "plan_proposal",
    id: "pp1",
    plan: "# Plan\nstep 1",
    status: "pending",
    toolUseId: "toolu_plan_1",
    timestamp: TS,
  }),
};

describe("insertChatMessage round-trips for every kind", () => {
  for (const [name, build] of Object.entries(fixtures)) {
    test(`kind=${name}`, () => {
      // For tool_result: pre-insert the matching tool_use so denorm lookup hits.
      if (name === "tool_result") {
        insertChatMessage(db, fixtures.tool_use(), SID);
      }
      const msg = build();
      const id = insertChatMessage(db, msg, SID);
      expect(id).toBeGreaterThan(0);

      const rows = getChatMessages(db, SID, { includeHidden: true });
      const row = rows.find((r) => r.id === id);
      expect(row).toBeDefined();
      const projected = rowToNormalizedMessage(row!);
      expect(projected.kind).toBe(msg.kind);
    });
  }
});

describe("rowToNormalizedMessage projection round-trips", () => {
  test("assistant carries model + usage", () => {
    const id = insertChatMessage(db, fixtures.assistant(), SID);
    const row = getChatMessages(db, SID).find((r) => r.id === id)!;
    const m = rowToNormalizedMessage(row);
    if (m.kind !== "assistant") throw new Error("expected assistant");
    expect(m.model).toBe("claude-opus-4");
    expect(m.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 6,
    });
    expect(m.text).toBe("hello");
  });

  test("tool_use parses tool_input_json", () => {
    const id = insertChatMessage(db, fixtures.tool_use(), SID);
    const row = getChatMessages(db, SID).find((r) => r.id === id)!;
    const m = rowToNormalizedMessage(row);
    if (m.kind !== "tool_use") throw new Error("expected tool_use");
    expect(m.toolUseId).toBe("toolu_abc");
    expect(m.toolName).toBe("Bash");
    expect(m.toolInput).toEqual({ command: "ls -la", description: "list" });
  });

  test("tool_use round-trips parentId (SDK message id)", () => {
    const msg: NormalizedMessage = {
      kind: "tool_use",
      id: "tu-pid",
      parentId: "msg_abc",
      toolUseId: "toolu_pid",
      toolName: "Bash",
      toolSummary: "$ ls",
      toolInput: { command: "ls" },
      timestamp: TS,
    };
    const id = insertChatMessage(db, msg, SID);
    const row = getChatMessages(db, SID).find((r) => r.id === id)!;
    expect(row.parent_id).toBe("msg_abc");
    const m = rowToNormalizedMessage(row);
    if (m.kind !== "tool_use") throw new Error("expected tool_use");
    expect(m.parentId).toBe("msg_abc");
  });

  test("tool_result inherits denormalized name/summary from sibling tool_use", () => {
    insertChatMessage(db, fixtures.tool_use(), SID);
    const trId = insertChatMessage(db, fixtures.tool_result(), SID);
    const row = getChatMessages(db, SID).find((r) => r.id === trId)!;
    expect(row.tool_name).toBe("Bash");
    expect(row.tool_summary).toBe("$ ls -la");
    const m = rowToNormalizedMessage(row);
    if (m.kind !== "tool_result") throw new Error("expected tool_result");
    expect(m.output).toBe("file1\nfile2");
    expect(m.isError).toBe(false);
  });

  test("tool_result with no sibling tool_use falls back to 'Tool'", () => {
    const orphan: NormalizedMessage = {
      kind: "tool_result",
      id: "tr-orphan",
      toolUseId: "toolu_missing",
      toolName: "",
      toolSummary: "",
      output: "x",
      isError: true,
      timestamp: TS,
    };
    const id = insertChatMessage(db, orphan, SID);
    const row = getChatMessages(db, SID).find((r) => r.id === id)!;
    expect(row.tool_name).toBe("Tool");
    expect(row.tool_summary).toBeNull();
    expect(row.is_error).toBe(1);
  });

  test("compact carries metadata columns", () => {
    const id = insertChatMessage(db, fixtures.compact(), SID);
    const row = getChatMessages(db, SID).find((r) => r.id === id)!;
    const m = rowToNormalizedMessage(row);
    if (m.kind !== "compact") throw new Error("expected compact");
    expect(m.preTokens).toBe(1000);
    expect(m.postTokens).toBe(200);
    expect(m.trigger).toBe("manual");
  });

  test("permission_request preserves payload + tool_use_id", () => {
    const id = insertChatMessage(db, fixtures.permission_request(), SID);
    const row = getChatMessages(db, SID).find((r) => r.id === id)!;
    expect(row.tool_use_id).toBe("toolu_perm_1");
    const m = rowToNormalizedMessage(row);
    if (m.kind !== "permission_request") throw new Error("expected permission_request");
    expect(m.tool).toBe("Bash");
    expect(m.input).toEqual({ command: "rm -rf /" });
    expect(m.alwaysAsk).toBe(true);
    expect(m.status).toBe("pending");
  });

  test("question preserves questions array + question_id", () => {
    const id = insertChatMessage(db, fixtures.question(), SID);
    const row = getChatMessages(db, SID).find((r) => r.id === id)!;
    expect(row.question_id).toBe("q-uuid-1");
    const m = rowToNormalizedMessage(row);
    if (m.kind !== "question") throw new Error("expected question");
    expect(m.questions.length).toBe(1);
    expect(m.questions[0].question).toBe("Pick one");
    expect(m.questions[0].options?.length).toBe(2);
    expect(m.status).toBe("pending");
  });

  test("plan_proposal preserves plan markdown + status", () => {
    const id = insertChatMessage(db, fixtures.plan_proposal(), SID);
    const row = getChatMessages(db, SID).find((r) => r.id === id)!;
    const m = rowToNormalizedMessage(row);
    if (m.kind !== "plan_proposal") throw new Error("expected plan_proposal");
    expect(m.plan).toBe("# Plan\nstep 1");
    expect(m.toolUseId).toBe("toolu_plan_1");
    expect(m.status).toBe("pending");
  });
});

describe("getChatMessages cursor pagination", () => {
  beforeEach(() => {
    for (let i = 0; i < 6; i++) {
      insertChatMessage(
        db,
        { kind: "user", id: `u${i}`, text: `msg ${i}`, timestamp: TS + i },
        SID,
      );
    }
  });

  test("default returns chronological order", () => {
    const rows = getChatMessages(db, SID);
    expect(rows.length).toBe(6);
    expect(rows.map((r) => r.text)).toEqual([
      "msg 0",
      "msg 1",
      "msg 2",
      "msg 3",
      "msg 4",
      "msg 5",
    ]);
  });

  test("limit caps result count", () => {
    const rows = getChatMessages(db, SID, { limit: 2 });
    expect(rows.length).toBe(2);
  });

  test("after returns rows with id > cursor", () => {
    const all = getChatMessages(db, SID);
    const cursor = all[2].id;
    const after = getChatMessages(db, SID, { after: cursor });
    expect(after.length).toBe(3);
    expect(after[0].text).toBe("msg 3");
  });

  test("before returns N rows with id < cursor in chronological order", () => {
    const all = getChatMessages(db, SID);
    const cursor = all[5].id;
    const before = getChatMessagesBefore(db, SID, cursor, 3);
    expect(before.length).toBe(3);
    expect(before.map((r) => r.text)).toEqual(["msg 2", "msg 3", "msg 4"]);
  });
});

describe("hidden_from_render filter", () => {
  test("default excludes hidden rows; includeHidden returns them", () => {
    // Visible
    insertChatMessage(
      db,
      { kind: "user", id: "u-vis", text: "real text", timestamp: TS },
      SID,
    );
    // Hidden: empty user text triggers hidden_from_render = 1.
    insertChatMessage(db, { kind: "user", id: "u-hid", text: "", timestamp: TS }, SID);

    const visible = getChatMessages(db, SID);
    expect(visible.length).toBe(1);
    expect(visible[0].text).toBe("real text");

    const all = getChatMessages(db, SID, { includeHidden: true });
    expect(all.length).toBe(2);
  });
});

describe("updateChatMessageStatus", () => {
  test("flips a permission_request from pending to allowed via toolUseId", () => {
    const id = insertChatMessage(db, fixtures.permission_request(), SID);
    const updatedId = updateChatMessageStatus(
      db,
      SID,
      { toolUseId: "toolu_perm_1" },
      { status: "allowed" },
    );
    expect(updatedId).toBe(id);
    const row = getChatMessages(db, SID).find((r) => r.id === id)!;
    const m = rowToNormalizedMessage(row);
    if (m.kind !== "permission_request") throw new Error("expected permission_request");
    expect(m.status).toBe("allowed");
  });

  test("flips a question from pending to answered via questionId", () => {
    const id = insertChatMessage(db, fixtures.question(), SID);
    const updatedId = updateChatMessageStatus(
      db,
      SID,
      { questionId: "q-uuid-1" },
      { status: "answered", answers: ["A"] },
    );
    expect(updatedId).toBe(id);
    const row = getChatMessages(db, SID).find((r) => r.id === id)!;
    const m = rowToNormalizedMessage(row);
    if (m.kind !== "question") throw new Error("expected question");
    expect(m.status).toBe("answered");
    expect(m.answers).toEqual(["A"]);
  });

  test("returns null when no matching row", () => {
    const r = updateChatMessageStatus(
      db,
      SID,
      { toolUseId: "nonexistent" },
      { status: "allowed" },
    );
    expect(r).toBeNull();
  });

  test("toolUseId lookup ignores tool_use rows; only updates permission_request/question/plan_proposal", () => {
    // Insert a tool_use row with toolUseId='x' first, then a permission_request
    // sharing the same toolUseId. Kind filter must select the permission_request,
    // not the tool_use, regardless of insertion order.
    const SHARED = "shared-tool-use-id";
    const toolUseRow = {
      kind: "tool_use" as const,
      id: "tu-shared",
      parentId: "a1",
      toolUseId: SHARED,
      toolName: "Bash",
      toolSummary: "$ echo hi",
      toolInput: { command: "echo hi" },
      timestamp: TS,
    };
    const permRow = {
      kind: "permission_request" as const,
      id: "p-shared",
      tool: "Bash",
      input: { command: "echo hi" },
      alwaysAsk: false,
      status: "pending" as const,
      toolUseId: SHARED,
      timestamp: TS,
    };
    const tuId = insertChatMessage(db, toolUseRow, SID);
    const permId = insertChatMessage(db, permRow, SID);

    const updatedId = updateChatMessageStatus(
      db,
      SID,
      { toolUseId: SHARED },
      { status: "allowed" },
    );
    expect(updatedId).toBe(permId);

    const all = getChatMessages(db, SID, { includeHidden: true });
    const tuRow = all.find((r) => r.id === tuId)!;
    const prRow = all.find((r) => r.id === permId)!;

    // The tool_use row's payload_json must NOT have been touched.
    const tuParsed = tuRow.payload_json ? JSON.parse(tuRow.payload_json) : null;
    expect(tuParsed?.status).toBeUndefined();

    // The permission_request row's payload_json status must be 'allowed'.
    const prParsed = JSON.parse(prRow.payload_json!);
    expect(prParsed.status).toBe("allowed");
  });
});

describe("getToolUseByCorrelationId", () => {
  test("returns tool_name + tool_summary + tool_input_json on hit", () => {
    insertChatMessage(db, fixtures.tool_use(), SID);
    const got = getToolUseByCorrelationId(db, "toolu_abc", SID);
    expect(got).not.toBeNull();
    expect(got?.tool_name).toBe("Bash");
    expect(got?.tool_summary).toBe("$ ls -la");
    expect(got?.tool_input_json).toBe(
      JSON.stringify({ command: "ls -la", description: "list" }),
    );
  });

  test("returns null on miss", () => {
    const got = getToolUseByCorrelationId(db, "nope", SID);
    expect(got).toBeNull();
  });

  test("scoped by sessionId — does not leak across sessions", () => {
    createSession(db, { id: "other", project_path: "/tmp/p", model: "opus" });
    insertChatMessage(db, fixtures.tool_use(), SID);
    const got = getToolUseByCorrelationId(db, "toolu_abc", "other");
    expect(got).toBeNull();
  });
});

describe("copyMessages contract", () => {
  test("copies assistant + 2× tool_use + 2× tool_result with parent_id NULL on copies and tool_use_id correlation preserved", () => {
    const A = SID;
    const B = "session-B";
    createSession(db, { id: B, project_path: "/tmp/p", model: "opus" });

    // Insert source rows: assistant + 2× tool_use + 2× tool_result.
    insertChatMessage(
      db,
      {
        kind: "assistant",
        id: "a1",
        text: "thinking",
        model: "opus",
        usage: null,
        timestamp: TS,
      },
      A,
    );

    // tool_use rows: insertChatMessage now persists parentId directly.
    insertChatMessage(
      db,
      {
        kind: "tool_use",
        id: "tu1",
        parentId: "a1",
        toolUseId: "toolu_one",
        toolName: "Bash",
        toolSummary: "$ ls",
        toolInput: { command: "ls" },
        timestamp: TS + 1,
      },
      A,
    );
    insertChatMessage(
      db,
      {
        kind: "tool_use",
        id: "tu2",
        parentId: "a1",
        toolUseId: "toolu_two",
        toolName: "Read",
        toolSummary: "Read foo.txt",
        toolInput: { file_path: "foo.txt" },
        timestamp: TS + 2,
      },
      A,
    );
    insertChatMessage(
      db,
      {
        kind: "tool_result",
        id: "tr1",
        toolUseId: "toolu_one",
        toolName: "Bash",
        toolSummary: "$ ls",
        output: "file1",
        isError: false,
        timestamp: TS + 3,
      },
      A,
    );
    insertChatMessage(
      db,
      {
        kind: "tool_result",
        id: "tr2",
        toolUseId: "toolu_two",
        toolName: "Read",
        toolSummary: "Read foo.txt",
        output: "contents",
        isError: false,
        timestamp: TS + 4,
      },
      A,
    );

    // Copy A → B.
    const copied = copyMessages(db, A, B);
    expect(copied).toBe(5);

    // (a) all 5 rows present in chronological order.
    const dst = getChatMessages(db, B);
    expect(dst.length).toBe(5);
    expect(dst.map((r) => r.kind)).toEqual([
      "assistant",
      "tool_use",
      "tool_use",
      "tool_result",
      "tool_result",
    ]);

    // (b) copied tool_use rows have parent_id IS NULL.
    const tuRows = dst.filter((r) => r.kind === "tool_use");
    expect(tuRows.length).toBe(2);
    for (const r of tuRows) expect(r.parent_id).toBeNull();

    // (c) tool_use rows still carry tool_name/tool_summary/tool_input_json.
    expect(tuRows.map((r) => r.tool_name)).toEqual(["Bash", "Read"]);
    expect(tuRows.map((r) => r.tool_summary)).toEqual(["$ ls", "Read foo.txt"]);
    expect(tuRows[0].tool_input_json).toBe(JSON.stringify({ command: "ls" }));
    expect(tuRows[1].tool_input_json).toBe(JSON.stringify({ file_path: "foo.txt" }));

    // (d) tool_result rows still carry tool_name/tool_summary/output/is_error.
    const trRows = dst.filter((r) => r.kind === "tool_result");
    expect(trRows.map((r) => r.tool_name)).toEqual(["Bash", "Read"]);
    expect(trRows.map((r) => r.output)).toEqual(["file1", "contents"]);
    expect(trRows.every((r) => r.is_error === 0)).toBe(true);

    // (e) getToolUseByCorrelationId scoped to B resolves.
    const t1 = getToolUseByCorrelationId(db, "toolu_one", B);
    expect(t1?.tool_name).toBe("Bash");
    const t2 = getToolUseByCorrelationId(db, "toolu_two", B);
    expect(t2?.tool_name).toBe("Read");
  });
});

describe("getResumeCandidates uses chat_messages", () => {
  test("counts user+assistant rows and returns last text per kind", () => {
    // Add a tool_use row in addition — should NOT be counted in message_count.
    insertChatMessage(
      db,
      { kind: "user", id: "u-old", text: "first question", timestamp: TS },
      SID,
    );
    insertChatMessage(
      db,
      {
        kind: "assistant",
        id: "a-old",
        text: "first answer",
        model: "opus",
        usage: null,
        timestamp: TS + 1,
      },
      SID,
    );
    insertChatMessage(
      db,
      {
        kind: "tool_use",
        id: "tu-old",
        parentId: "a-old",
        toolUseId: "toolu_x",
        toolName: "Bash",
        toolSummary: "$ ls",
        toolInput: { command: "ls" },
        timestamp: TS + 2,
      },
      SID,
    );
    updateSessionStatus(db, SID, "completed");
    updateSessionSdkId(db, SID, "sdk-old");
    updateSessionCost(db, SID, 0.05);

    const cands = getResumeCandidates(db, "/tmp/p", 10);
    expect(cands.length).toBe(1);
    const c = cands[0];
    expect(c.id).toBe(SID);
    expect(c.message_count).toBe(2); // user + assistant only
    expect(c.last_user_text).toBe("first question");
    expect(c.last_assistant_text).toBe("first answer");
    expect(c.resumable).toBe(true);
  });

  test("excludes hidden_from_render rows from message_count", () => {
    // 1 visible user (text="visible"), 1 hidden user (empty text → hidden_from_render=1),
    // 1 visible assistant.
    insertChatMessage(
      db,
      { kind: "user", id: "u-vis", text: "visible", timestamp: TS },
      SID,
    );
    insertChatMessage(
      db,
      { kind: "user", id: "u-hidden", text: "", timestamp: TS + 1 },
      SID,
    );
    insertChatMessage(
      db,
      {
        kind: "assistant",
        id: "a-vis",
        text: "answer",
        model: "opus",
        usage: null,
        timestamp: TS + 2,
      },
      SID,
    );
    updateSessionStatus(db, SID, "completed");

    const cands = getResumeCandidates(db, "/tmp/p", 10);
    expect(cands.length).toBe(1);
    expect(cands[0].message_count).toBe(2);
  });
});

describe("getLatestMessageId / getMessageCount target chat_messages", () => {
  test("getMessageCount counts all kinds; getLatestMessageId returns max id", () => {
    expect(getMessageCount(db, SID)).toBe(0);
    expect(getLatestMessageId(db, SID)).toBeNull();

    const id1 = insertChatMessage(
      db,
      { kind: "user", id: "u1", text: "a", timestamp: TS },
      SID,
    );
    const id2 = insertChatMessage(
      db,
      { kind: "system", id: "sy1", text: "b", timestamp: TS },
      SID,
    );

    expect(getMessageCount(db, SID)).toBe(2);
    expect(getLatestMessageId(db, SID)).toBe(Math.max(id1, id2));
  });
});
