import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../src/db/schema.js";
import {
  createSession,
  getChatMessages,
  upsertProject,
} from "../src/db/queries.js";
import { handleEnvelope } from "../src/manager/mqtt-handler.js";
import { rowToNormalizedMessage } from "../src/manager/chat-message-projection.js";

let db: Database;
const SID = "sess-mqtt";

beforeEach(() => {
  db = initDatabase(":memory:");
  upsertProject(db, { path: "/tmp/p", name: "p" });
  createSession(db, { id: SID, project_path: "/tmp/p", model: "opus" });
});

function rows() {
  return getChatMessages(db, SID, { limit: 1000, includeHidden: true });
}

function normalized() {
  return rows().map(rowToNormalizedMessage);
}

describe("handleEnvelope: output assistant + tool_use", () => {
  test("persists assistant text + tool_use rows; broadcast safe", () => {
    handleEnvelope(db, null, {}, SID, "output", {
      type: "assistant",
      message: {
        id: "msg-1",
        model: "claude-opus-4",
        content: [
          { type: "text", text: "running a command" },
          {
            type: "tool_use",
            id: "tu-bash-1",
            name: "Bash",
            input: { command: "ls /tmp" },
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const out = normalized();
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe("assistant");
    expect(out[1].kind).toBe("tool_use");
    if (out[1].kind === "tool_use") {
      expect(out[1].toolUseId).toBe("tu-bash-1");
      expect(out[1].toolName).toBe("Bash");
      expect(out[1].toolSummary).toBe("ls /tmp");
    }
  });
});

describe("handleEnvelope: tool_result with denormalized name/summary", () => {
  test("user envelope tool_result resolves prior tool_use via DB lookup", () => {
    // First feed an assistant envelope with tool_use to populate the DB.
    handleEnvelope(db, null, {}, SID, "output", {
      type: "assistant",
      message: {
        id: "m1",
        model: "opus",
        content: [
          {
            type: "tool_use",
            id: "tu-read",
            name: "Read",
            input: { file_path: "/etc/hosts" },
          },
        ],
      },
    });

    // Then feed a user/tool_result envelope.
    handleEnvelope(db, null, {}, SID, "output", {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-read",
            content: "127.0.0.1 localhost",
            is_error: false,
          },
        ],
      },
    });

    const out = normalized();
    const result = out.find((m) => m.kind === "tool_result");
    expect(result).toBeDefined();
    if (result?.kind === "tool_result") {
      expect(result.toolName).toBe("Read");
      expect(result.toolSummary).toBe("/etc/hosts");
      expect(result.output).toBe("127.0.0.1 localhost");
      expect(result.isError).toBe(false);
    }
  });

  test("manager-restart-mid-stream: tool_result resolves via DB even without in-memory state", () => {
    // Persist tool_use as if a prior process did it.
    handleEnvelope(db, null, {}, SID, "output", {
      type: "assistant",
      message: {
        id: "m1",
        content: [
          {
            type: "tool_use",
            id: "tu-edit",
            name: "Edit",
            input: { file_path: "/x.ts", replace_all: true },
          },
        ],
      },
    });

    // Simulate a fresh handler: send tool_result with no warm map.
    handleEnvelope(db, null, {}, SID, "output", {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-edit",
            content: "ok",
          },
        ],
      },
    });

    const result = normalized().find((m) => m.kind === "tool_result");
    expect(result?.kind).toBe("tool_result");
    if (result?.kind === "tool_result") {
      expect(result.toolName).toBe("Edit");
      expect(result.toolSummary).toBe("/x.ts (replace_all)");
    }
  });
});

describe("handleEnvelope: parallel tool_use", () => {
  test("N tool_use blocks → N tool_use rows; results in mixed order resolve correctly", () => {
    handleEnvelope(db, null, {}, SID, "output", {
      type: "assistant",
      message: {
        id: "m1",
        content: [
          { type: "tool_use", id: "tu-a", name: "Bash", input: { command: "echo a" } },
          { type: "tool_use", id: "tu-b", name: "Read", input: { file_path: "/b" } },
          { type: "tool_use", id: "tu-c", name: "Glob", input: { pattern: "**/*.ts" } },
        ],
      },
    });
    handleEnvelope(db, null, {}, SID, "output", {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu-c", content: "match.ts" },
          { type: "tool_result", tool_use_id: "tu-a", content: "a" },
          { type: "tool_result", tool_use_id: "tu-b", content: "b-content" },
        ],
      },
    });
    const out = normalized();
    const uses = out.filter((m) => m.kind === "tool_use");
    const results = out.filter((m) => m.kind === "tool_result");
    expect(uses).toHaveLength(3);
    expect(results).toHaveLength(3);
    const namesByUseId = new Map(
      results.map((r) => (r.kind === "tool_result" ? [r.toolUseId, r.toolName] : ["", ""])),
    );
    expect(namesByUseId.get("tu-a")).toBe("Bash");
    expect(namesByUseId.get("tu-b")).toBe("Read");
    expect(namesByUseId.get("tu-c")).toBe("Glob");
  });
});

describe("handleEnvelope: compact_boundary + permission/question/plan", () => {
  test("compact_boundary → kind:compact row with metadata", () => {
    handleEnvelope(db, null, {}, SID, "output", {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { pre_tokens: 1000, post_tokens: 200, trigger: "auto" },
    });
    const out = normalized();
    const c = out.find((m) => m.kind === "compact");
    expect(c).toBeDefined();
    if (c?.kind === "compact") {
      expect(c.preTokens).toBe(1000);
      expect(c.postTokens).toBe(200);
      expect(c.trigger).toBe("auto");
    }
  });

  test("permission Bash → permission_request row", () => {
    handleEnvelope(db, null, {}, SID, "permission", {
      tool: "Bash",
      input: { command: "rm -rf /" },
      toolUseId: "tu-perm-1",
    });
    const out = normalized();
    const p = out.find((m) => m.kind === "permission_request");
    expect(p?.kind).toBe("permission_request");
    if (p?.kind === "permission_request") {
      expect(p.tool).toBe("Bash");
      expect(p.status).toBe("pending");
    }
  });

  test("permission AskUserQuestion → question row", () => {
    handleEnvelope(db, null, {}, SID, "permission", {
      tool: "AskUserQuestion",
      input: {
        questions: [{ question: "Pick one?", options: [{ label: "yes" }, { label: "no" }] }],
      },
      toolUseId: "tu-q-1",
    });
    const q = normalized().find((m) => m.kind === "question");
    expect(q?.kind).toBe("question");
    if (q?.kind === "question") {
      expect(q.questions).toHaveLength(1);
      expect(q.questions[0].question).toBe("Pick one?");
    }
  });

  test("permission ExitPlanMode → plan_proposal row", () => {
    handleEnvelope(db, null, {}, SID, "permission", {
      tool: "ExitPlanMode",
      input: { plan: "# Plan\n\n- step 1" },
      toolUseId: "tu-plan-1",
    });
    const p = normalized().find((m) => m.kind === "plan_proposal");
    expect(p?.kind).toBe("plan_proposal");
    if (p?.kind === "plan_proposal") {
      expect(p.plan).toContain("# Plan");
      expect(p.status).toBe("pending");
    }
  });
});

describe("handleEnvelope: response-merge round-trips", () => {
  test("permission_response updates row status to allowed", () => {
    handleEnvelope(db, null, {}, SID, "permission", {
      tool: "Bash",
      input: { command: "ls" },
      toolUseId: "tu-pr",
    });
    handleEnvelope(db, null, {}, SID, "permission_response", {
      tool: "Bash",
      toolUseId: "tu-pr",
      decision: "allow",
    });
    const p = normalized().find((m) => m.kind === "permission_request");
    expect(p?.kind).toBe("permission_request");
    if (p?.kind === "permission_request") {
      expect(p.status).toBe("allowed");
    }
  });

  test("question_response updates row status to answered + answers", () => {
    handleEnvelope(db, null, {}, SID, "question", {
      question: "color?",
      questionId: "q-1",
      options: ["red", "blue"],
    });
    handleEnvelope(db, null, {}, SID, "question_response", {
      questionId: "q-1",
      answer: ["red"],
    });
    const q = normalized().find((m) => m.kind === "question");
    expect(q?.kind).toBe("question");
    if (q?.kind === "question") {
      expect(q.status).toBe("answered");
      expect(q.answers).toEqual(["red"]);
    }
  });
});

describe("handleEnvelope: side-effects (no rows)", () => {
  test("system init updates session sdk_session_id; no row", () => {
    handleEnvelope(db, null, {}, SID, "output", {
      type: "system",
      subtype: "init",
      session_id: "sdk-abc",
    });
    expect(rows()).toHaveLength(0);
    const s = db.query("SELECT sdk_session_id FROM sessions WHERE id = ?1").get(SID) as
      | { sdk_session_id: string | null }
      | null;
    expect(s?.sdk_session_id).toBe("sdk-abc");
  });

  test("input subtopic does NOT insert (API path inserts user rows)", () => {
    handleEnvelope(db, null, {}, SID, "input", { text: "hello" });
    expect(rows()).toHaveLength(0);
  });

  test("status subtopic updates session, no row", () => {
    handleEnvelope(db, null, {}, SID, "status", { status: "completed" });
    expect(rows()).toHaveLength(0);
    const s = db.query("SELECT status FROM sessions WHERE id = ?1").get(SID) as
      | { status: string }
      | null;
    expect(s?.status).toBe("completed");
  });
});

describe("handleEnvelope: assistant usage + model persistence", () => {
  test("usage fields and model round-trip onto NormalizedMessage", () => {
    handleEnvelope(db, null, {}, SID, "output", {
      type: "assistant",
      message: {
        id: "msg-usage-1",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "hi" }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
        },
      },
    });
    const out = normalized();
    const assistant = out.find((m) => m.kind === "assistant");
    expect(assistant).toBeDefined();
    if (assistant?.kind !== "assistant") throw new Error("not assistant");
    expect(assistant.model).toBe("claude-opus-4-7");
    expect(assistant.usage).not.toBeNull();
    expect(assistant.usage?.inputTokens).toBe(100);
    expect(assistant.usage?.outputTokens).toBe(50);
    expect(assistant.usage?.cacheCreationInputTokens).toBe(10);
    expect(assistant.usage?.cacheReadInputTokens).toBe(20);
  });

  test("per-turn model isolation: each assistant row carries its own model", () => {
    handleEnvelope(db, null, {}, SID, "output", {
      type: "assistant",
      message: {
        id: "msg-turn-a",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "first" }],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    handleEnvelope(db, null, {}, SID, "output", {
      type: "assistant",
      message: {
        id: "msg-turn-b",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "second" }],
        usage: {
          input_tokens: 2,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const persisted = db
      .query(
        "SELECT model FROM chat_messages WHERE session_id = ?1 AND kind = 'assistant' ORDER BY id ASC",
      )
      .all(SID) as Array<{ model: string | null }>;
    expect(persisted).toHaveLength(2);
    expect(persisted[0].model).toBe("claude-opus-4-7");
    expect(persisted[1].model).toBe("claude-sonnet-4-6");
    expect(persisted[0].model).not.toBe(persisted[1].model);
  });
});
