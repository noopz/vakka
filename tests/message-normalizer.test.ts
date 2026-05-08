import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPACT_SUMMARY_PREFIX,
  cleanCommandText,
  isCompactSummary,
  normalizeSdkEnvelope,
  summarizeToolInput,
} from "../src/manager/message-normalizer.js";
import type {
  NormalizedMessage,
  NormalizerContext,
  SdkEnvelope,
} from "../src/shared/message-types.js";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "sdk-envelopes");

function loadFixture(name: string): SdkEnvelope {
  const raw = readFileSync(join(FIXTURE_DIR, name), "utf-8");
  return JSON.parse(raw) as SdkEnvelope;
}

let counter = 0;
function makeCtx(over: Partial<NormalizerContext> = {}): NormalizerContext {
  counter = 0;
  return {
    sessionId: "session-test",
    nameMap: new Map(),
    summaryMap: new Map(),
    timestamp: 1_700_000_000_000,
    idFallback: () => `gen-${++counter}`,
    ...over,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// summarizeToolInput
// ──────────────────────────────────────────────────────────────────────────

describe("summarizeToolInput", () => {
  test("Bash truncates command to 200 chars", () => {
    expect(summarizeToolInput("Bash", { command: "ls -la" })).toBe("ls -la");
    const long = "x".repeat(500);
    expect(summarizeToolInput("Bash", { command: long }).length).toBe(200);
  });

  test("Read returns file_path", () => {
    expect(summarizeToolInput("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
  });

  test("Write returns file_path", () => {
    expect(summarizeToolInput("Write", { file_path: "/a.txt" })).toBe("/a.txt");
  });

  test("Edit appends (replace_all) when set", () => {
    expect(summarizeToolInput("Edit", { file_path: "/a.ts" })).toBe("/a.ts");
    expect(
      summarizeToolInput("Edit", { file_path: "/a.ts", replace_all: true }),
    ).toBe("/a.ts (replace_all)");
  });

  test("Grep returns pattern", () => {
    expect(summarizeToolInput("Grep", { pattern: "TODO" })).toBe("TODO");
  });

  test("Glob returns pattern", () => {
    expect(summarizeToolInput("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  test("WebFetch returns url", () => {
    expect(summarizeToolInput("WebFetch", { url: "https://example.com" })).toBe(
      "https://example.com",
    );
  });

  test("WebSearch returns query", () => {
    expect(summarizeToolInput("WebSearch", { query: "anthropic" })).toBe("anthropic");
  });

  test("AskUserQuestion summarizes single vs multi", () => {
    expect(
      summarizeToolInput("AskUserQuestion", {
        questions: [{ question: "yes?" }],
      }),
    ).toBe("yes?");
    expect(
      summarizeToolInput("AskUserQuestion", {
        questions: [{ question: "a" }, { question: "b" }, { question: "c" }],
      }),
    ).toBe("3 questions");
    expect(summarizeToolInput("AskUserQuestion", {})).toBe("ask user");
  });

  test("ExitPlanMode shows first line", () => {
    expect(
      summarizeToolInput("ExitPlanMode", {
        plan: "## Plan\n\nstep one\nstep two",
      }),
    ).toBe("## Plan");
  });

  test("default falls back to truncated JSON", () => {
    expect(summarizeToolInput("UnknownTool", { x: 1 })).toBe('{"x":1}');
  });

  test("default falls back to empty for non-object input", () => {
    expect(summarizeToolInput("Bash", null)).toBe("");
    expect(summarizeToolInput("UnknownTool", "string")).toBe("");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// cleanCommandText
// ──────────────────────────────────────────────────────────────────────────

describe("cleanCommandText", () => {
  test("returns null on empty/non-string", () => {
    expect(cleanCommandText("")).toBeNull();
    expect(cleanCommandText("   ")).toBeNull();
    expect(cleanCommandText(null)).toBeNull();
    expect(cleanCommandText(undefined)).toBeNull();
    expect(cleanCommandText(123 as any)).toBeNull();
  });

  test("drops <local-command-caveat>", () => {
    expect(cleanCommandText("<local-command-caveat>x</local-command-caveat>")).toBeNull();
  });

  test("drops <system-reminder>", () => {
    expect(cleanCommandText("<system-reminder>x</system-reminder>")).toBeNull();
  });

  test("renders command-name + command-args", () => {
    expect(
      cleanCommandText(
        "<command-name>/compact</command-name> <command-args>focus</command-args>",
      ),
    ).toBe("/compact focus");
    expect(cleanCommandText("<command-name>/help</command-name>")).toBe("/help");
  });

  test("unwraps command-stdout / command-stderr", () => {
    expect(cleanCommandText("<command-stdout>hello</command-stdout>")).toBe("hello");
    expect(cleanCommandText("<command-stderr>oops</command-stderr>")).toBe("oops");
  });

  test("returns input verbatim for plain text", () => {
    expect(cleanCommandText("just words")).toBe("just words");
  });

  test("does not throw on weird input", () => {
    expect(() => cleanCommandText({} as any)).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// isCompactSummary
// ──────────────────────────────────────────────────────────────────────────

describe("isCompactSummary", () => {
  test("matches the documented prefix", () => {
    expect(isCompactSummary(`${COMPACT_SUMMARY_PREFIX} that ran out of context.`)).toBe(true);
  });
  test("rejects non-strings and non-prefix text", () => {
    expect(isCompactSummary(null)).toBe(false);
    expect(isCompactSummary(123)).toBe(false);
    expect(isCompactSummary("not the prefix")).toBe(false);
  });
  test("tolerates leading whitespace", () => {
    expect(isCompactSummary(`   ${COMPACT_SUMMARY_PREFIX} blah`)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// normalizeSdkEnvelope — input subtopic
// ──────────────────────────────────────────────────────────────────────────

describe("normalizeSdkEnvelope: input", () => {
  test("plain user text → kind:user", () => {
    const env = loadFixture("input-user-text.json");
    const ctx = makeCtx();
    const out = normalizeSdkEnvelope(env, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "user",
      text: "Add a hello-world test to the suite please.",
    });
  });

  test("slash-command envelope → cleaned text", () => {
    const env = loadFixture("input-slash-command.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("user");
    expect((out[0] as Extract<NormalizedMessage, { kind: "user" }>).text).toBe(
      "/compact focus on the recent changes",
    );
  });

  test("command-stdout → cleaned passthrough", () => {
    const env = loadFixture("input-bash-stdout.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    expect((out[0] as any).text).toBe("file1.txt\nfile2.txt");
  });

  test("local-command-caveat → hidden_from_render row, not dropped", () => {
    const env = loadFixture("input-local-command-caveat.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("user");
    expect((out[0] as any).hiddenFromRender).toBe(true);
  });

  test("compact-summary user turn → kind:compact_summary", () => {
    const env = loadFixture("input-compact-summary.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("compact_summary");
  });

  test("empty input → no rows", () => {
    const out = normalizeSdkEnvelope(
      { subtopic: "input", data: { text: "" } },
      makeCtx(),
    );
    expect(out).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// normalizeSdkEnvelope — output: assistant
// ──────────────────────────────────────────────────────────────────────────

describe("normalizeSdkEnvelope: output (assistant)", () => {
  test("text-only assistant → 1 assistant row with usage + model", () => {
    const env = loadFixture("output-assistant-text.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    const a = out[0] as Extract<NormalizedMessage, { kind: "assistant" }>;
    expect(a.kind).toBe("assistant");
    expect(a.text).toBe("Sure — here's the answer.");
    expect(a.model).toBe("claude-opus-4-7");
    expect(a.usage).toEqual({
      inputTokens: 17,
      outputTokens: 42,
      cacheCreationInputTokens: 1024,
      cacheReadInputTokens: 5000,
    });
  });

  test("assistant with tool_use → assistant row + tool_use row + map populated", () => {
    const env = loadFixture("output-assistant-tool-use.json");
    const ctx = makeCtx();
    const out = normalizeSdkEnvelope(env, ctx);
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe("assistant");
    const tu = out[1] as Extract<NormalizedMessage, { kind: "tool_use" }>;
    expect(tu.kind).toBe("tool_use");
    expect(tu.toolUseId).toBe("toolu_01ReadAbc");
    expect(tu.toolName).toBe("Read");
    expect(tu.toolSummary).toBe("/tmp/example.ts");
    expect(tu.parentId).toBe("msg_01ToolUseExample");
    expect(ctx.nameMap.get("toolu_01ReadAbc")).toBe("Read");
    expect(ctx.summaryMap.get("toolu_01ReadAbc")).toBe("/tmp/example.ts");
  });

  test("parallel tool_use → 2 tool_use rows sharing parent_id", () => {
    const env = loadFixture("output-assistant-parallel-tool-use.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    // No text → no assistant row, just 2 tool_use rows
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.kind === "tool_use")).toBe(true);
    const parents = new Set(out.map((m) => (m as any).parentId));
    expect(parents.size).toBe(1);
    expect([...parents][0]).toBe("msg_01ParallelToolUse");
  });

  test("assistant tool_use-only (no text) → N tool_use rows, no assistant row, maps populated", () => {
    const ctx = makeCtx();
    const out = normalizeSdkEnvelope(
      {
        subtopic: "output",
        data: {
          type: "assistant",
          message: {
            id: "msg_01OnlyToolUse",
            content: [
              {
                type: "tool_use",
                id: "toolu_01A",
                name: "Read",
                input: { file_path: "/tmp/a.ts" },
              },
              {
                type: "tool_use",
                id: "toolu_01B",
                name: "Grep",
                input: { pattern: "foo" },
              },
            ],
          },
        },
      } as unknown as SdkEnvelope,
      ctx,
    );
    // Two tool_use rows, no assistant row.
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.kind === "tool_use")).toBe(true);
    expect(out.some((m) => m.kind === "assistant")).toBe(false);
    // Each tool_use row's parentId is the assistant message id.
    for (const m of out) {
      expect((m as any).parentId).toBe("msg_01OnlyToolUse");
    }
    // Maps populated for each tool_use id.
    expect(ctx.nameMap.get("toolu_01A")).toBe("Read");
    expect(ctx.nameMap.get("toolu_01B")).toBe("Grep");
    expect(ctx.summaryMap.get("toolu_01A")).toBe("/tmp/a.ts");
    expect(ctx.summaryMap.get("toolu_01B")).toBe("foo");
  });

  test("assistant empty content → no rows", () => {
    const out = normalizeSdkEnvelope(
      {
        subtopic: "output",
        data: { type: "assistant", message: { id: "x", content: [] } },
      },
      makeCtx(),
    );
    expect(out).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// normalizeSdkEnvelope — output: user (tool_result)
// ──────────────────────────────────────────────────────────────────────────

describe("normalizeSdkEnvelope: output (user / tool_result)", () => {
  test("tool_result resolves toolName/toolSummary from maps", () => {
    const ctx = makeCtx();
    ctx.nameMap.set("toolu_01ReadAbc", "Read");
    ctx.summaryMap.set("toolu_01ReadAbc", "/tmp/example.ts");
    const env = loadFixture("output-user-tool-result.json");
    const out = normalizeSdkEnvelope(env, ctx);
    expect(out).toHaveLength(1);
    const r = out[0] as Extract<NormalizedMessage, { kind: "tool_result" }>;
    expect(r.kind).toBe("tool_result");
    expect(r.toolUseId).toBe("toolu_01ReadAbc");
    expect(r.toolName).toBe("Read");
    expect(r.toolSummary).toBe("/tmp/example.ts");
    expect(r.output).toBe("file contents here\nline 2");
    expect(r.isError).toBe(false);
  });

  test("tool_result fallback toolName 'Tool' when map empty", () => {
    const env = loadFixture("output-user-tool-result.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    expect((out[0] as any).toolName).toBe("Tool");
  });

  test("tool_result is_error propagates", () => {
    const env = loadFixture("output-user-tool-result-error.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    expect((out[0] as any).isError).toBe(true);
    expect((out[0] as any).output).toBe("ENOENT: no such file");
  });

  test("tool_result with empty output is dropped (matches chat-view filter)", () => {
    // String-content empty case
    const out1 = normalizeSdkEnvelope(
      {
        subtopic: "output",
        data: {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_empty1",
                content: "",
                is_error: false,
              },
            ],
          },
        },
      } as unknown as SdkEnvelope,
      makeCtx(),
    );
    expect(out1).toHaveLength(0);

    // Block-array with empty text case
    const out2 = normalizeSdkEnvelope(
      {
        subtopic: "output",
        data: {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_empty2",
                content: [{ type: "text", text: "" }],
                is_error: false,
              },
            ],
          },
        },
      } as unknown as SdkEnvelope,
      makeCtx(),
    );
    expect(out2).toHaveLength(0);

    // Regression: a non-empty tool_result in the same envelope still emits.
    const out3 = normalizeSdkEnvelope(
      {
        subtopic: "output",
        data: {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_empty3",
                content: "",
                is_error: false,
              },
              {
                type: "tool_result",
                tool_use_id: "toolu_nonempty3",
                content: "hello",
                is_error: false,
              },
            ],
          },
        },
      } as unknown as SdkEnvelope,
      makeCtx(),
    );
    expect(out3).toHaveLength(1);
    expect((out3[0] as any).toolUseId).toBe("toolu_nonempty3");
    expect((out3[0] as any).output).toBe("hello");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// normalizeSdkEnvelope — output: system
// ──────────────────────────────────────────────────────────────────────────

describe("normalizeSdkEnvelope: output (system)", () => {
  test("system init → no row", () => {
    const env = loadFixture("output-system-init.json");
    expect(normalizeSdkEnvelope(env, makeCtx())).toEqual([]);
  });

  test("system notice → kind:system row", () => {
    const env = loadFixture("output-system-notice.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("system");
    expect((out[0] as any).text).toBe("Resumed session from snapshot.");
  });

  test("compact_boundary → kind:compact with metadata", () => {
    const env = loadFixture("output-system-compact-boundary.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    const c = out[0] as Extract<NormalizedMessage, { kind: "compact" }>;
    expect(c.kind).toBe("compact");
    expect(c.preTokens).toBe(152340);
    expect(c.postTokens).toBe(18450);
    expect(c.trigger).toBe("auto");
  });

  test("result envelope → no row", () => {
    const env = loadFixture("output-result.json");
    expect(normalizeSdkEnvelope(env, makeCtx())).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// normalizeSdkEnvelope — permission subtopic dispatch
// ──────────────────────────────────────────────────────────────────────────

describe("normalizeSdkEnvelope: permission", () => {
  test("Bash permission with no decision → status=pending, kind=permission_request", () => {
    const env = loadFixture("permission-bash.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    const p = out[0] as Extract<NormalizedMessage, { kind: "permission_request" }>;
    expect(p.kind).toBe("permission_request");
    expect(p.tool).toBe("Bash");
    expect(p.status).toBe("pending");
    expect(p.toolUseId).toBe("toolu_01BashRm");
    expect(p.alwaysAsk).toBe(false);
  });

  test("decision=allow → status=allowed", () => {
    const env = loadFixture("permission-bash-allowed.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect((out[0] as any).status).toBe("allowed");
  });

  test("decision=deny → status=denied", () => {
    const env = loadFixture("permission-bash-denied.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect((out[0] as any).status).toBe("denied");
  });

  test("decision=allow_always → status=allowed", () => {
    const out = normalizeSdkEnvelope(
      {
        subtopic: "permission",
        data: { tool: "Bash", input: {}, decision: "allow_always" },
      },
      makeCtx(),
    );
    expect((out[0] as any).status).toBe("allowed");
  });

  test("AskUserQuestion → kind:question with questions[] array verbatim", () => {
    const env = loadFixture("permission-ask-user-question.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    const q = out[0] as Extract<NormalizedMessage, { kind: "question" }>;
    expect(q.kind).toBe("question");
    expect(q.questions).toHaveLength(2);
    expect(q.questions[0].question).toBe("Which database driver should we target first?");
    expect(q.questions[0].header).toBe("Database");
    expect(q.questions[0].options).toEqual([
      { label: "Postgres", description: "Best long-term fit." },
      { label: "SQLite", description: "Lower friction for dev." },
    ]);
    expect(q.questions[1].allowFreeText).toBe(true);
    expect(q.toolUseId).toBe("toolu_01AskUser");
    expect(q.status).toBe("pending");
  });

  test("ExitPlanMode → kind:plan_proposal carrying plan markdown", () => {
    const env = loadFixture("permission-exit-plan-mode.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    const p = out[0] as Extract<NormalizedMessage, { kind: "plan_proposal" }>;
    expect(p.kind).toBe("plan_proposal");
    expect(p.plan).toContain("## Plan");
    expect(p.toolUseId).toBe("toolu_01ExitPlan");
    expect(p.status).toBe("pending");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// normalizeSdkEnvelope — question (legacy)
// ──────────────────────────────────────────────────────────────────────────

describe("normalizeSdkEnvelope: question (legacy)", () => {
  test("legacy single-question payload wraps as questions:[1]", () => {
    const env = loadFixture("question-legacy-single.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    const q = out[0] as Extract<NormalizedMessage, { kind: "question" }>;
    expect(q.kind).toBe("question");
    expect(q.questions).toHaveLength(1);
    expect(q.questions[0].question).toBe("Continue with the rebuild?");
    expect(q.questions[0].options).toEqual([{ label: "Yes" }, { label: "No" }]);
    expect(q.questionId).toBe("q_legacy_001");
    expect(q.status).toBe("pending");
    expect(q.answers).toBeUndefined();
  });

  test("answer array → status answered + answers stringified", () => {
    const env = loadFixture("question-legacy-answered.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    expect((out[0] as any).status).toBe("answered");
    expect((out[0] as any).answers).toEqual(["red"]);
  });

  test("answer string → answers single-element array", () => {
    const out = normalizeSdkEnvelope(
      {
        subtopic: "question",
        data: { question: "x?", answer: "yes" },
      },
      makeCtx(),
    );
    expect((out[0] as any).answers).toEqual(["yes"]);
    expect((out[0] as any).status).toBe("answered");
  });

  test("legacy + SDK AskUserQuestion produce identical questions[] shape", () => {
    const single = normalizeSdkEnvelope(
      loadFixture("question-legacy-single.json"),
      makeCtx(),
    )[0] as Extract<NormalizedMessage, { kind: "question" }>;
    const sdk = normalizeSdkEnvelope(
      loadFixture("permission-ask-user-question.json"),
      makeCtx(),
    )[0] as Extract<NormalizedMessage, { kind: "question" }>;
    expect(Array.isArray(single.questions)).toBe(true);
    expect(Array.isArray(sdk.questions)).toBe(true);
    // Same key set on the entry shape
    const keysOf = (q: any) => Object.keys(q).sort();
    expect(keysOf(single.questions[0]).every((k) =>
      ["question", "header", "options", "allowFreeText", "multiSelect"].includes(k),
    )).toBe(true);
    expect(keysOf(sdk.questions[0]).every((k) =>
      ["question", "header", "options", "allowFreeText", "multiSelect"].includes(k),
    )).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Negative fixtures — must never throw, must produce sensible output
// ──────────────────────────────────────────────────────────────────────────

describe("normalizeSdkEnvelope: negative fixtures", () => {
  test("null content array → no rows, no throw", () => {
    const env = loadFixture("negative-null-content-array.json");
    expect(() => normalizeSdkEnvelope(env, makeCtx())).not.toThrow();
    expect(normalizeSdkEnvelope(env, makeCtx())).toEqual([]);
  });

  test("tool_use missing id → row with fallback id, map NOT populated", () => {
    const env = loadFixture("negative-tool-use-missing-id.json");
    const ctx = makeCtx();
    const out = normalizeSdkEnvelope(env, ctx);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("tool_use");
    expect((out[0] as any).id).toMatch(/^gen-/);
    expect(ctx.nameMap.size).toBe(0);
    expect(ctx.summaryMap.size).toBe(0);
  });

  test("tool_result with object content → coerced sanely, no throw", () => {
    const env = loadFixture("negative-tool-result-object-content.json");
    expect(() => normalizeSdkEnvelope(env, makeCtx())).not.toThrow();
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    expect(typeof (out[0] as any).output).toBe("string");
  });

  test("tool_result mixed image+text → text extracted, no throw", () => {
    const env = loadFixture("negative-tool-result-mixed-image-text.json");
    const out = normalizeSdkEnvelope(env, makeCtx());
    expect(out).toHaveLength(1);
    expect((out[0] as any).output).toBe("Caption: hello");
  });

  test("unknown envelope type → no rows, no throw", () => {
    const env = loadFixture("negative-unknown-type.json");
    expect(normalizeSdkEnvelope(env, makeCtx())).toEqual([]);
  });

  test("system unknown subtype → no rows, no throw", () => {
    const env = loadFixture("negative-system-unknown-subtype.json");
    expect(normalizeSdkEnvelope(env, makeCtx())).toEqual([]);
  });

  test("malformed envelope (null) → no rows", () => {
    expect(normalizeSdkEnvelope(null as any, makeCtx())).toEqual([]);
    expect(
      normalizeSdkEnvelope(
        { subtopic: "output", data: null } as any,
        makeCtx(),
      ),
    ).toEqual([]);
  });

  test("permission_response / question_response → no rows (UPDATE handled by caller)", () => {
    expect(
      normalizeSdkEnvelope(
        { subtopic: "permission_response", data: { decision: "allow" } },
        makeCtx(),
      ),
    ).toEqual([]);
    expect(
      normalizeSdkEnvelope(
        { subtopic: "question_response", data: { answer: "yes" } },
        makeCtx(),
      ),
    ).toEqual([]);
  });
});
