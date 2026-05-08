// Server-only column→shape projection for chat_messages rows.
//
// Maps a `ChatMessageRow` (the SQLite row shape) to the wire-format
// `NormalizedMessage` discriminated union. JSON.parse is performed only on
// `tool_input_json` (tool_use rows) and `payload_json` (permission_request /
// question / plan_proposal rows). All other fields are direct column-to-field
// mappings.
//
// Used by commit 3's HTTP read path (`GET /api/sessions/:id/messages`) and by
// any other server-side consumer that wants the wire shape.

import type { ChatMessageRow } from "../db/queries.js";
import type {
  NormalizedMessage,
  PermissionStatus,
  QuestionEntry,
} from "../shared/message-types.js";

function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowTimestamp(row: ChatMessageRow): number {
  // created_at is `datetime('now')` — UTC seconds-resolution string. Convert
  // to ms epoch, falling back to 0 on any parse failure (defensive).
  const t = Date.parse(`${row.created_at}Z`);
  return Number.isFinite(t) ? t : 0;
}

export function rowToNormalizedMessage(row: ChatMessageRow): NormalizedMessage {
  const id = String(row.id);
  const timestamp = rowTimestamp(row);

  switch (row.kind) {
    case "user":
      return { kind: "user", id, text: row.text ?? "", timestamp };

    case "assistant": {
      const hasUsage =
        row.input_tokens != null ||
        row.output_tokens != null ||
        row.cache_creation_input_tokens != null ||
        row.cache_read_input_tokens != null;
      return {
        kind: "assistant",
        id,
        text: row.text ?? "",
        model: row.model,
        usage: hasUsage
          ? {
              inputTokens: row.input_tokens ?? 0,
              outputTokens: row.output_tokens ?? 0,
              cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
              cacheReadInputTokens: row.cache_read_input_tokens ?? 0,
            }
          : null,
        timestamp,
      };
    }

    case "tool_use": {
      const toolInput = parseObject(row.tool_input_json);
      return {
        kind: "tool_use",
        id,
        parentId: row.parent_id ?? "",
        toolUseId: row.tool_use_id ?? "",
        toolName: row.tool_name ?? "Tool",
        toolSummary: row.tool_summary ?? "",
        toolInput,
        timestamp,
      };
    }

    case "tool_result":
      return {
        kind: "tool_result",
        id,
        toolUseId: row.tool_use_id ?? "",
        toolName: row.tool_name ?? "Tool",
        toolSummary: row.tool_summary ?? "",
        output: row.output ?? "",
        isError: row.is_error === 1,
        timestamp,
      };

    case "system":
      return { kind: "system", id, text: row.text ?? "", timestamp };

    case "compact":
      return {
        kind: "compact",
        id,
        preTokens: row.pre_tokens ?? 0,
        postTokens: row.post_tokens ?? 0,
        trigger: row.trigger ?? "",
        timestamp,
      };

    case "compact_summary":
      return { kind: "compact_summary", id, text: row.text ?? "", timestamp };

    case "permission_request": {
      const payload = parseObject(row.payload_json);
      const status = (payload.status as PermissionStatus | undefined) ?? "pending";
      const tool = (payload.tool as string | undefined) ?? row.tool_name ?? "";
      const input = (payload.input as Record<string, unknown> | undefined) ?? {};
      const alwaysAsk = payload.alwaysAsk as boolean | undefined;
      return {
        kind: "permission_request",
        id,
        tool,
        input,
        alwaysAsk,
        status,
        toolUseId: row.tool_use_id ?? undefined,
        timestamp,
      };
    }

    case "question": {
      const payload = parseObject(row.payload_json);
      const questions = (payload.questions as QuestionEntry[] | undefined) ?? [];
      const status = (payload.status as "pending" | "answered" | undefined) ?? "pending";
      const answers = payload.answers as string[] | undefined;
      return {
        kind: "question",
        id,
        questions,
        status,
        questionId: row.question_id ?? undefined,
        toolUseId: row.tool_use_id ?? undefined,
        answers,
        timestamp,
      };
    }

    case "plan_proposal": {
      const payload = parseObject(row.payload_json);
      const status =
        (payload.status as "pending" | "approved" | "rejected" | undefined) ?? "pending";
      const feedback = payload.feedback as string | undefined;
      const plan = (payload.plan as string | undefined) ?? row.text ?? "";
      return {
        kind: "plan_proposal",
        id,
        plan,
        status,
        toolUseId: row.tool_use_id ?? undefined,
        feedback,
        timestamp,
      };
    }

    default:
      // Unknown kind — surface as a system row so callers don't crash.
      return { kind: "system", id, text: row.text ?? "", timestamp };
  }
}
