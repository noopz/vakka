// Shared, types-only module.
//
// Browser-safe: zero runtime exports. Both the manager (server) and the
// frontend bundle import only types from this file. The runtime normalizer
// lives in `src/manager/message-normalizer.ts` and must NEVER be imported
// by `src/frontend/`.
//
// `NormalizedMessage` is the wire format produced by `normalizeSdkEnvelope`
// and (later, in commit 2/3) the row shape returned by the DB projection.

export interface AssistantUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface QuestionEntry {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  allowFreeText?: boolean;
  multiSelect?: boolean;
}

export type PermissionStatus = "pending" | "allowed" | "denied";
export type QuestionStatus = "pending" | "answered";
export type PlanProposalStatus = "pending" | "approved" | "rejected";

export type NormalizedMessage =
  | {
      kind: "user";
      id: string;
      text: string;
      timestamp: number;
      hiddenFromRender?: boolean;
    }
  | {
      kind: "assistant";
      id: string;
      text: string;
      model: string | null;
      usage: AssistantUsage | null;
      timestamp: number;
    }
  | {
      kind: "tool_use";
      id: string;
      parentId: string;
      toolUseId: string;
      toolName: string;
      toolSummary: string;
      toolInput: Record<string, unknown>;
      timestamp: number;
    }
  | {
      kind: "tool_result";
      id: string;
      toolUseId: string;
      toolName: string;
      toolSummary: string;
      output: string;
      isError: boolean;
      timestamp: number;
    }
  | {
      kind: "system";
      id: string;
      text: string;
      timestamp: number;
    }
  | {
      kind: "compact";
      id: string;
      preTokens: number;
      postTokens: number;
      trigger: string;
      timestamp: number;
    }
  | {
      kind: "compact_summary";
      id: string;
      text: string;
      timestamp: number;
    }
  | {
      kind: "permission_request";
      id: string;
      tool: string;
      input: Record<string, unknown>;
      alwaysAsk?: boolean;
      status: PermissionStatus;
      toolUseId?: string;
      timestamp: number;
    }
  | {
      kind: "question";
      id: string;
      questions: QuestionEntry[];
      status: QuestionStatus;
      questionId?: string;
      toolUseId?: string;
      answers?: string[];
      timestamp: number;
    }
  | {
      kind: "plan_proposal";
      id: string;
      plan: string;
      status: PlanProposalStatus;
      toolUseId?: string;
      feedback?: string;
      timestamp: number;
    };

export type NormalizedMessageKind = NormalizedMessage["kind"];

export interface NormalizerContext {
  sessionId: string;
  /**
   * Tool-use lookup for tool_result blocks. The normalizer only reads from
   * and writes to this map; it never reaches outside.
   */
  nameMap: Map<string, string>;
  summaryMap: Map<string, string>;
  timestamp: number;
  idFallback: () => string;
}

/**
 * Subtopic on the MQTT envelope. The normalizer dispatches on this; the
 * caller (mqtt-handler) supplies it.
 */
export type EnvelopeSubtopic =
  | "input"
  | "output"
  | "permission"
  | "question"
  | "permission_response"
  | "question_response";

export interface SdkEnvelope {
  /** Manager-side subtopic (NOT the SDK type field). */
  subtopic: EnvelopeSubtopic;
  /** Raw payload as parsed from MQTT. */
  data: any;
}
