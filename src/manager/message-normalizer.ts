// Server-only SDK envelope normalizer.
//
// One source of truth for converting raw MQTT envelopes into the wire-format
// `NormalizedMessage[]`. The frontend NEVER imports this file (would bloat
// the bundle and break the "render rows, don't decode" boundary).
//
// `normalizeSdkEnvelope` is a pure function over (envelope, ctx). It mutates
// only `ctx.nameMap` / `ctx.summaryMap` (used to thread tool_use ↔ tool_result
// resolution within an envelope batch). It never throws on weird input —
// malformed envelopes return `[]`.

import type {
  NormalizedMessage,
  NormalizerContext,
  QuestionEntry,
  SdkEnvelope,
} from "../shared/message-types.js";

// SDK injects this exact prefix on the synthetic user turn it creates after
// /compact (and after auto-compact). Matching the prefix is enough; the body
// after it is the rolling summary. Centralized here so any future SDK upgrade
// only edits one place.
export const COMPACT_SUMMARY_PREFIX =
  "This session is being continued from a previous conversation";

export function isCompactSummary(text: unknown): boolean {
  return (
    typeof text === "string" &&
    text.trimStart().startsWith(COMPACT_SUMMARY_PREFIX)
  );
}

/**
 * Compact one-line summary of a tool call's input args. Mirrors the shape
 * users will recognize from the CC CLI / live chat (e.g. Edit on a path,
 * Bash with a command). Falls back to truncated JSON for unknown tools.
 */
export function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, any>;

  switch (name) {
    case "Bash":
      return String(obj.command ?? "").slice(0, 200);
    case "Read":
    case "Write":
      return String(obj.file_path ?? "");
    case "Edit":
    case "MultiEdit": {
      const p = obj.file_path ?? "";
      const op = obj.replace_all ? " (replace_all)" : "";
      return `${p}${op}`;
    }
    case "Glob":
      return String(obj.pattern ?? "");
    case "Grep":
      return String(obj.pattern ?? "");
    case "WebFetch":
      return String(obj.url ?? "");
    case "WebSearch":
      return String(obj.query ?? "");
    case "AskUserQuestion": {
      const qs = Array.isArray(obj.questions) ? obj.questions : [];
      if (qs.length === 0) return "ask user";
      if (qs.length === 1) return String(qs[0]?.question ?? "ask user").slice(0, 160);
      return `${qs.length} questions`;
    }
    case "ExitPlanMode": {
      const plan = String(obj.plan ?? "");
      return plan.split("\n", 1)[0]?.slice(0, 160) ?? "exit plan mode";
    }
    case "TodoWrite": {
      const todos = Array.isArray(obj.todos) ? obj.todos.length : 0;
      return `${todos} todo${todos === 1 ? "" : "s"}`;
    }
    default:
      try {
        return JSON.stringify(input).slice(0, 160);
      } catch {
        return "";
      }
  }
}

/**
 * CC wraps internal events in XML-ish tags. Render the meaningful ones cleanly
 * and drop the pure noise:
 *   <command-name>/X</command-name> <command-args>…</command-args>  →  "/X args"
 *   <local-command-caveat>…</local-command-caveat>                  →  null (drop)
 *   <system-reminder>…</system-reminder>                            →  null (drop)
 *   <command-stdout>…</command-stdout>                              →  passthrough text
 *   <command-stderr>…</command-stderr>                              →  passthrough text
 *
 * Returns null when the cleaned text is empty (caller decides whether to set
 * `hidden_from_render`). Never throws.
 */
export function cleanCommandText(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^<local-command-caveat>/i.test(trimmed)) return null;
  if (/^<system-reminder>/i.test(trimmed)) return null;

  const nameMatch = trimmed.match(/<command-name>([^<]+)<\/command-name>/);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    const argsMatch = trimmed.match(/<command-args>([^<]*)<\/command-args>/);
    const args = argsMatch ? argsMatch[1].trim() : "";
    return args ? `${name} ${args}` : name;
  }

  const stdout = trimmed.match(/<command-stdout>([\s\S]*?)<\/command-stdout>/);
  if (stdout) return stdout[1].trim() || null;
  const stderr = trimmed.match(/<command-stderr>([\s\S]*?)<\/command-stderr>/);
  if (stderr) return stderr[1].trim() || null;

  return raw;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function extractToolResultOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text as string)
      .join("\n");
  }
  if (content && typeof content === "object") {
    // Defensive: nested object (e.g. image block emitted as a single block).
    // Coerce to a sensible string instead of crashing.
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return "";
}

function permissionStatusFromDecision(
  decision: unknown,
): "pending" | "allowed" | "denied" {
  if (decision === "allow" || decision === "allow_always") return "allowed";
  if (decision === "deny") return "denied";
  return "pending";
}

function answerToStrings(answer: unknown): string[] | undefined {
  if (answer == null) return undefined;
  if (Array.isArray(answer)) return answer.map((a) => String(a));
  return [String(answer)];
}

// ──────────────────────────────────────────────────────────────────────────
// Subtopic handlers
// ──────────────────────────────────────────────────────────────────────────

function normalizeInput(
  data: any,
  ctx: NormalizerContext,
): NormalizedMessage[] {
  // The `input` subtopic is a user-typed text envelope from the wrapper.
  // Shape: { text: string, ... }
  const raw = typeof data?.text === "string" ? data.text : "";
  const cleaned = cleanCommandText(raw);

  if (cleaned === null) {
    // Caveat-only / reminder-only / empty. Persist with hiddenFromRender so
    // the audit trail survives but the UI doesn't show it.
    if (typeof raw !== "string" || raw.length === 0) return [];
    return [
      {
        kind: "user",
        id: ctx.idFallback(),
        text: raw,
        timestamp: ctx.timestamp,
        hiddenFromRender: true,
      },
    ];
  }

  if (isCompactSummary(cleaned)) {
    return [
      {
        kind: "compact_summary",
        id: ctx.idFallback(),
        text: cleaned,
        timestamp: ctx.timestamp,
      },
    ];
  }

  return [
    {
      kind: "user",
      id: ctx.idFallback(),
      text: cleaned,
      timestamp: ctx.timestamp,
    },
  ];
}

function normalizeOutput(
  data: any,
  ctx: NormalizerContext,
): NormalizedMessage[] {
  const t = data?.type;

  if (t === "assistant") {
    // SDK assistant envelope: { type:'assistant', message:{ id, model, content:[...], usage } }
    const message = data.message ?? {};
    const blocks: any[] = Array.isArray(message.content) ? message.content : [];
    const assistantId = typeof message.id === "string" ? message.id : ctx.idFallback();

    const text = blocks
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n\n");

    const usage = message.usage && typeof message.usage === "object"
      ? {
          inputTokens: Number(message.usage.input_tokens ?? 0) || 0,
          outputTokens: Number(message.usage.output_tokens ?? 0) || 0,
          cacheCreationInputTokens:
            Number(message.usage.cache_creation_input_tokens ?? 0) || 0,
          cacheReadInputTokens:
            Number(message.usage.cache_read_input_tokens ?? 0) || 0,
        }
      : null;

    const out: NormalizedMessage[] = [];

    if (text) {
      out.push({
        kind: "assistant",
        id: assistantId,
        text,
        model: typeof message.model === "string" ? message.model : null,
        usage,
        timestamp: ctx.timestamp,
      });
    }

    // Walk tool_use blocks: emit a tool_use row + populate the maps so a
    // tool_result in the same envelope (rare but defensive) can resolve.
    //
    // NOTE for persistence layer: each tool_use row's `parentId` references
    // the SDK assistant message id. If the assistant envelope has no text
    // block, we DO NOT emit an `assistant` row — meaning `parentId` may not
    // correspond to a persisted `chat_messages.id`. Any DB schema for these
    // rows must therefore NOT enforce a FOREIGN KEY constraint on
    // `parent_id` (or must keep SQLite's `PRAGMA foreign_keys` off).
    for (const b of blocks) {
      if (b?.type !== "tool_use") continue;
      if (typeof b.id !== "string" || !b.id) {
        // Missing id → emit a tool_use row with a fallback id but DO NOT
        // populate the map (no correlation key to look up against).
        const name = typeof b.name === "string" ? b.name : "Tool";
        const summary = summarizeToolInput(name, b.input);
        out.push({
          kind: "tool_use",
          id: ctx.idFallback(),
          parentId: assistantId,
          toolUseId: "",
          toolName: name,
          toolSummary: summary,
          toolInput:
            b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {},
          timestamp: ctx.timestamp,
        });
        continue;
      }

      const name = typeof b.name === "string" ? b.name : "Tool";
      const summary = summarizeToolInput(name, b.input);
      ctx.nameMap.set(b.id, name);
      if (summary) ctx.summaryMap.set(b.id, summary);

      out.push({
        kind: "tool_use",
        id: b.id,
        parentId: assistantId,
        toolUseId: b.id,
        toolName: name,
        toolSummary: summary,
        toolInput:
          b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {},
        timestamp: ctx.timestamp,
      });
    }

    return out;
  }

  if (t === "user") {
    // SDK user envelope = tool_result batch.
    // Shape: { type:'user', message:{ content:[ { type:'tool_result', tool_use_id, content, is_error } ] } }
    const blocks = data?.message?.content;
    if (!Array.isArray(blocks)) return [];
    const out: NormalizedMessage[] = [];
    for (const block of blocks) {
      if (!block || block.type !== "tool_result") continue;
      const useId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const output = extractToolResultOutput(block.content);
      // Match pre-refactor chat-view parser behavior: tool_result blocks
      // whose extracted content is empty emit no row (downstream rendering
      // code expects this filter — see src/frontend/views/chat-view.tsx).
      if (!output) continue;
      const toolName =
        (typeof block.tool_name === "string" && block.tool_name) ||
        (useId && ctx.nameMap.get(useId)) ||
        "Tool";
      const toolSummary = (useId && ctx.summaryMap.get(useId)) || "";
      out.push({
        kind: "tool_result",
        id: useId || ctx.idFallback(),
        toolUseId: useId,
        toolName,
        toolSummary,
        output,
        isError: !!block.is_error,
        timestamp: ctx.timestamp,
      });
    }
    return out;
  }

  if (t === "system") {
    const subtype = data?.subtype;
    if (subtype === "compact_boundary") {
      const meta = data?.compact_metadata ?? data?.metadata ?? {};
      return [
        {
          kind: "compact",
          id: ctx.idFallback(),
          preTokens: Number(meta.pre_tokens ?? data?.pre_tokens ?? 0) || 0,
          postTokens: Number(meta.post_tokens ?? data?.post_tokens ?? 0) || 0,
          trigger: String(meta.trigger ?? data?.trigger ?? ""),
          timestamp: ctx.timestamp,
        },
      ];
    }
    if (subtype === "notice") {
      const text =
        typeof data?.message?.content === "string"
          ? data.message.content
          : typeof data?.text === "string"
            ? data.text
            : "";
      if (!text) return [];
      return [
        {
          kind: "system",
          id: ctx.idFallback(),
          text,
          timestamp: ctx.timestamp,
        },
      ];
    }
    // init / result / unknown subtype → no row (caller handles side effects)
    return [];
  }

  // result, stream_event, rate_limit_event, unknown type → no rows
  return [];
}

function normalizePermission(
  data: any,
  ctx: NormalizerContext,
): NormalizedMessage[] {
  const id = ctx.idFallback();
  const tool = typeof data?.tool === "string" ? data.tool : "";
  const input =
    data?.input && typeof data.input === "object"
      ? (data.input as Record<string, unknown>)
      : {};
  const status = permissionStatusFromDecision(data?.decision);
  const toolUseId =
    typeof data?.toolUseId === "string" ? data.toolUseId : undefined;
  const ts = ctx.timestamp;

  // Tool-specific dispatch: AskUserQuestion → question, ExitPlanMode → plan_proposal,
  // anything else → permission_request.
  if (tool === "AskUserQuestion") {
    const rawQs = Array.isArray(input.questions) ? (input.questions as any[]) : [];
    const questions: QuestionEntry[] = rawQs.map((q) => ({
      question: String(q?.question ?? ""),
      header: typeof q?.header === "string" ? q.header : undefined,
      options: Array.isArray(q?.options)
        ? q.options.map((o: any) => ({
            label: String(o?.label ?? ""),
            description:
              typeof o?.description === "string" ? o.description : undefined,
          }))
        : undefined,
      allowFreeText: typeof q?.allowFreeText === "boolean" ? q.allowFreeText : undefined,
      multiSelect: typeof q?.multiSelect === "boolean" ? q.multiSelect : undefined,
    }));
    return [
      {
        kind: "question",
        id,
        questions,
        status: data?.answer !== undefined ? "answered" : "pending",
        toolUseId,
        answers: answerToStrings(data?.answer),
        timestamp: ts,
      },
    ];
  }

  if (tool === "ExitPlanMode") {
    const plan = typeof input.plan === "string" ? input.plan : "";
    let planStatus: "pending" | "approved" | "rejected" = "pending";
    if (data?.decision === "allow" || data?.decision === "allow_always" || data?.approved === true) {
      planStatus = "approved";
    } else if (data?.decision === "deny" || data?.approved === false) {
      planStatus = "rejected";
    }
    return [
      {
        kind: "plan_proposal",
        id,
        plan,
        status: planStatus,
        toolUseId,
        feedback: typeof data?.feedback === "string" ? data.feedback : undefined,
        timestamp: ts,
      },
    ];
  }

  return [
    {
      kind: "permission_request",
      id,
      tool: tool || (typeof data?.description === "string" ? data.description : ""),
      input,
      alwaysAsk: typeof data?.alwaysAsk === "boolean" ? data.alwaysAsk : undefined,
      status,
      toolUseId,
      timestamp: ts,
    },
  ];
}

function normalizeQuestion(
  data: any,
  ctx: NormalizerContext,
): NormalizedMessage[] {
  // Legacy single-question payload from the manager itself (not the SDK
  // AskUserQuestion tool). Wrap into the same `questions[]` shape so both
  // paths produce identical row shapes.
  const id = ctx.idFallback();
  const question = typeof data?.question === "string" ? data.question : "";
  const entry: QuestionEntry = {
    question,
    options: Array.isArray(data?.options)
      ? data.options.map((o: any) =>
          typeof o === "string"
            ? { label: o }
            : { label: String(o?.label ?? ""), description: o?.description },
        )
      : undefined,
    allowFreeText:
      typeof data?.allowFreeText === "boolean" ? data.allowFreeText : undefined,
    multiSelect:
      typeof data?.multiSelect === "boolean" ? data.multiSelect : undefined,
  };
  const answers = answerToStrings(data?.answer);
  return [
    {
      kind: "question",
      id,
      questions: [entry],
      status: data?.answer !== undefined ? "answered" : "pending",
      questionId: typeof data?.questionId === "string" ? data.questionId : undefined,
      toolUseId: typeof data?.toolUseId === "string" ? data.toolUseId : undefined,
      answers,
      timestamp: ctx.timestamp,
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// Public entry point
// ──────────────────────────────────────────────────────────────────────────

/**
 * Pure: returns 0..N normalized messages. Mutates only ctx.nameMap /
 * ctx.summaryMap. Never throws.
 */
export function normalizeSdkEnvelope(
  envelope: SdkEnvelope,
  ctx: NormalizerContext,
): NormalizedMessage[] {
  if (!envelope || typeof envelope !== "object") return [];
  const { subtopic, data } = envelope;
  if (!data || typeof data !== "object") return [];
  try {
    switch (subtopic) {
      case "input":
        return normalizeInput(data, ctx);
      case "output":
        return normalizeOutput(data, ctx);
      case "permission":
        return normalizePermission(data, ctx);
      case "question":
        return normalizeQuestion(data, ctx);
      case "permission_response":
      case "question_response":
        // No row produced; the response merge is handled by the caller via
        // an UPDATE on the existing row. Returning [] keeps the normalizer
        // pure-functional for these subtopics.
        return [];
      default:
        return [];
    }
  } catch {
    return [];
  }
}
