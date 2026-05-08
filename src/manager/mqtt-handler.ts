import type { MqttClient } from "mqtt";
import type { Database } from "bun:sqlite";
import { managerTopics, extractSessionId, extractSubtopic, topics } from "../shared/mqtt.js";
import {
  insertChatMessage,
  updateSessionStatus,
  updateSessionCost,
  updateSessionActivity,
  updateSessionPid,
  updateSessionStartTime,
  updateSessionSdkId,
  updateChatMessageStatus,
  getToolUseByCorrelationId,
  getPromptCardIdByToolUseId,
  getChatMessages,
} from "../db/queries.js";
import { logger } from "../shared/logger.js";
import { normalizeSdkEnvelope } from "./message-normalizer.js";
import { rowToNormalizedMessage } from "./chat-message-projection.js";
import type {
  EnvelopeSubtopic,
  NormalizedMessage,
  NormalizerContext,
} from "../shared/message-types.js";

export interface MQTTHandlerCallbacks {
  onPermissionRequest?: (sessionId: string, data: any) => void;
  onQuestionRequest?: (sessionId: string, data: any) => void;
  onSessionComplete?: (sessionId: string, data: any) => void;
  onSessionFailed?: (sessionId: string, data: any) => void;
}

const ROW_PRODUCING_SUBTOPICS = new Set<EnvelopeSubtopic>([
  // NOTE: "input" intentionally excluded — the API path inserts the user
  // row directly (see api.ts POST /sessions/:id/messages). The wrapper does
  // not echo input back, but if it did, allowing it through would
  // double-insert. We skip the subtopic here unconditionally.
  "output",
  "permission",
  "question",
]);

/**
 * Build a NormalizerContext, seeding nameMap/summaryMap from prior tool_use
 * rows in the DB so that cross-envelope tool_result blocks resolve their
 * tool_name/tool_summary even after manager restarts.
 */
function buildContext(
  db: Database,
  sessionId: string,
  data: any,
  idPrefix: string,
): NormalizerContext {
  const nameMap = new Map<string, string>();
  const summaryMap = new Map<string, string>();

  // Seed from DB if the envelope contains tool_result blocks. Look at
  // data.message.content for tool_use_ids and prefetch their names/summaries.
  const blocks = data?.message?.content;
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (b && b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const prior = getToolUseByCorrelationId(db, b.tool_use_id, sessionId);
        if (prior?.tool_name) nameMap.set(b.tool_use_id, prior.tool_name);
        if (prior?.tool_summary) summaryMap.set(b.tool_use_id, prior.tool_summary);
      }
    }
  }

  let counter = 0;
  return {
    sessionId,
    nameMap,
    summaryMap,
    timestamp: Date.now(),
    idFallback: () => `${idPrefix}-${++counter}`,
  };
}

export function setupManagerMQTTHandler(
  mqttClient: MqttClient,
  db: Database,
  callbacks: MQTTHandlerCallbacks = {},
  onSubscribed?: (err: Error | null) => void,
): void {
  // Subscribe to all agent topics using wildcards
  const topicList = Object.values(managerTopics);
  mqttClient.subscribe(topicList, (err) => {
    if (err) logger.error("mqtt-handler", "Failed to subscribe to manager topics", err);
    else logger.info("mqtt-handler", `Subscribed to ${topicList.length} wildcard topics`);
    onSubscribed?.(err);
  });

  mqttClient.on("message", (topic, payload) => {
    const sessionId = extractSessionId(topic);
    const subtopic = extractSubtopic(topic);
    if (!sessionId || !subtopic) return;

    // Empty payload on `hello` is a wrapper signalling end-of-session
    // (clearing its retained value). Nothing to record.
    if (subtopic === "hello" && payload.length === 0) return;

    try {
      const data = JSON.parse(payload.toString());
      handleEnvelope(db, mqttClient, callbacks, sessionId, subtopic, data);
    } catch (err) {
      logger.error("mqtt-handler", `Error processing message on ${topic}`, err);
    }
  });
}

/**
 * Pure-function dispatch, exported so tests can drive the pipeline directly
 * without a live MQTT broker. The normalize → insert → broadcast sequence
 * is identical to the live path.
 */
export function handleEnvelope(
  db: Database,
  mqttClient: MqttClient | null,
  callbacks: MQTTHandlerCallbacks,
  sessionId: string,
  subtopic: string,
  data: any,
): void {
  // Cross-process broadcast: mqtt-handler runs in the manager process; the
  // WS server runs in the web process. Direct in-memory broadcastChatMessages
  // would be a no-op here. Publish to MQTT and let the WS server fan out.
  const broadcastChatMessages = (sid: string, messages: NormalizedMessage[]): void => {
    if (!mqttClient || messages.length === 0) return;
    mqttClient.publish(topics(sid).chatMessages, JSON.stringify(messages));
  };
  // ── Side-effect-only subtopics ─────────────────────────────────────────

  if (subtopic === "status") {
    logger.info("mqtt-handler", `[${sessionId.slice(0, 8)}] status → ${data.status}${data.error ? ` (${data.error})` : ""}`);
    updateSessionStatus(db, sessionId, data.status);
    if (data.status === "completed") callbacks.onSessionComplete?.(sessionId, data);
    if (data.status === "failed" || data.status === "error") callbacks.onSessionFailed?.(sessionId, data);
    return;
  }

  if (subtopic === "cost") {
    logger.debug("mqtt-handler", `[${sessionId.slice(0, 8)}] cost: $${data.cumulative_cost_usd?.toFixed(4) ?? "?"}`);
    updateSessionCost(db, sessionId, data.cumulative_cost_usd);
    return;
  }

  if (subtopic === "context") {
    // Context usage is ephemeral — don't persist
    return;
  }

  if (subtopic === "hello") {
    if (typeof data.pid === "number") updateSessionPid(db, sessionId, data.pid);
    if (typeof data.startTime === "number") updateSessionStartTime(db, sessionId, data.startTime);
    logger.debug("mqtt-handler", `[${sessionId.slice(0, 8)}] hello pid=${data.pid} startTime=${data.startTime}`);
    return;
  }

  // ── input subtopic ────────────────────────────────────────────────────
  if (subtopic === "input") {
    // Two distinct producers publish to `input`:
    //   1. POST /sessions/:id/messages (api.ts) — used by both wrapper and
    //      RC paths. The HTTP handler already inserted the user row directly
    //      via persistAndBroadcastUserText, so we MUST NOT re-insert.
    //   2. RC worker echo (rc-attached.ts mapWorkerEvent for type:"user"
    //      with plain string content). Tagged with `source:"rc-attached-user"`
    //      to distinguish from (1)'s `source:"rc-attached"`. This path fires
    //      when the user types directly into the hijacked CC CLI window —
    //      no HTTP POST happened, so this is the sole insertion site.
    if (data?.source === "rc-attached-user" && typeof data?.text === "string") {
      const text = data.text;
      const dbId = insertChatMessage(
        db,
        { kind: "user", id: `rc-user-${Date.now()}`, text, timestamp: Date.now() },
        sessionId,
      );
      broadcastChatMessages(sessionId, [
        { kind: "user", id: String(dbId), text, timestamp: Date.now() },
      ]);
    }
    updateSessionActivity(db, sessionId);
    return;
  }

  // ── output: handle init/result side-effects, then normalize ────────────
  if (subtopic === "output") {
    const outputType = data?.type;
    if (outputType === "system" && data?.subtype === "init" && typeof data?.session_id === "string") {
      updateSessionSdkId(db, sessionId, data.session_id);
      logger.info("mqtt-handler", `[${sessionId.slice(0, 8)}] sdk_session_id=${data.session_id}`);
      return; // init produces no row
    }
    if (outputType === "result") {
      logger.info(
        "mqtt-handler",
        `[${sessionId.slice(0, 8)}] output (result): ${data.subtype} cost=$${data.total_cost_usd?.toFixed(4) ?? "?"}`,
      );
      updateSessionActivity(db, sessionId);
      return; // result produces no row
    }
    // Streaming-delta envelopes (stream_event, rate_limit_event, etc.) are
    // not row-producing; the normalizer returns [] for them and we exit.
  }

  // ── Row-producing subtopics: normalize + insert + broadcast ────────────
  if (ROW_PRODUCING_SUBTOPICS.has(subtopic as EnvelopeSubtopic)) {
    const ctx = buildContext(db, sessionId, data, `${subtopic}-${Date.now()}`);
    const messages = normalizeSdkEnvelope(
      { subtopic: subtopic as EnvelopeSubtopic, data },
      ctx,
    );

    if (messages.length === 0) return;

    // Persist each row, swapping the in-envelope id for the durable DB id
    // so the broadcast carries ids the frontend can upsert against.
    //
    // Prompt cards (question / permission_request / plan_proposal) dedupe by
    // toolUseId: the rc-relay's SSE replays unresolved control_request events
    // every time the manager reconnects, so without this guard each manager
    // restart while a question is pending creates a fresh duplicate row that
    // the cancel/answer path can't update (updateChatMessageStatus only hits
    // the latest row by id).
    const persisted: NormalizedMessage[] = [];
    for (const m of messages) {
      const promptToolUseId =
        (m.kind === "question" ||
          m.kind === "permission_request" ||
          m.kind === "plan_proposal") && m.toolUseId
          ? m.toolUseId
          : null;
      if (promptToolUseId) {
        const existingId = getPromptCardIdByToolUseId(db, sessionId, promptToolUseId);
        if (existingId != null) {
          persisted.push({ ...m, id: String(existingId) });
          continue;
        }
      }
      const dbId = insertChatMessage(db, m, sessionId);
      persisted.push({ ...m, id: String(dbId) });
    }

    if (subtopic === "output") updateSessionActivity(db, sessionId);

    // Side-effect callbacks (kept for backward compatibility with manager
    // wiring that listens for permission/question prompts).
    if (subtopic === "permission") callbacks.onPermissionRequest?.(sessionId, data);
    if (subtopic === "question") callbacks.onQuestionRequest?.(sessionId, data);

    broadcastChatMessages(sessionId, persisted);

    // Brief log line for visibility, keyed on first row's kind.
    const firstKind = persisted[0]?.kind ?? "?";
    logger.info(
      "mqtt-handler",
      `[${sessionId.slice(0, 8)}] ${subtopic} → ${persisted.length} row(s) (${firstKind})`,
    );
    return;
  }

  // ── Response-merge subtopics: UPDATE then re-broadcast the row ─────────
  if (subtopic === "permission_response") {
    const toolUseId = data?.toolUseId;
    const decision = data?.decision;
    logger.info(
      "mqtt-handler",
      `[${sessionId.slice(0, 8)}] permission response: ${decision} for ${data?.tool ?? "?"}`,
    );
    if (typeof toolUseId === "string" && toolUseId) {
      const status = decision === "allow" || decision === "allow_always"
        ? "allowed"
        : decision === "deny"
          ? "denied"
          : "pending";
      const updatedId = updateChatMessageStatus(db, sessionId, { toolUseId }, {
        status,
        ...(typeof data?.message === "string" ? { feedback: data.message } : {}),
      });
      if (updatedId != null) {
        rebroadcastById(db, sessionId, updatedId, broadcastChatMessages);
      }
    }
    return;
  }

  if (subtopic === "question_response") {
    const questionId = data?.questionId;
    const toolUseId = data?.toolUseId;
    const answer = data?.answer;
    logger.info(
      "mqtt-handler",
      `[${sessionId.slice(0, 8)}] question response: ${typeof answer === "string" ? answer.slice(0, 80) : JSON.stringify(answer)}`,
    );
    const answers = Array.isArray(answer)
      ? answer.map(String)
      : answer != null
        ? [String(answer)]
        : undefined;
    // AskUserQuestion (routed via permission subtopic → kind:'question') has
    // toolUseId but no questionId; legacy question subtopic has questionId.
    // Try whichever the response carries.
    let updatedId: number | null = null;
    if (typeof questionId === "string" && questionId) {
      updatedId = updateChatMessageStatus(db, sessionId, { questionId }, {
        status: "answered",
        ...(answers ? { answers } : {}),
      });
    }
    if (updatedId == null && typeof toolUseId === "string" && toolUseId) {
      updatedId = updateChatMessageStatus(db, sessionId, { toolUseId }, {
        status: "answered",
        ...(answers ? { answers } : {}),
      });
    }
    if (updatedId != null) {
      logger.info(
        "mqtt-handler",
        `[${sessionId.slice(0, 8)}] question row #${updatedId} → answered (lookup: ${questionId ? "questionId" : "toolUseId"})`,
      );
      rebroadcastById(db, sessionId, updatedId, broadcastChatMessages);
    } else {
      logger.warn(
        "mqtt-handler",
        `[${sessionId.slice(0, 8)}] question response NOT persisted (questionId=${questionId ?? "∅"} toolUseId=${toolUseId ?? "∅"}) — row will reappear on refresh`,
      );
    }
    return;
  }
}

/**
 * Re-read a row by id, project it to NormalizedMessage, and broadcast a
 * single-element chat_messages payload so frontend upsert-by-id swaps the
 * pending row for the resolved one.
 */
function rebroadcastById(
  db: Database,
  sessionId: string,
  rowId: number,
  broadcastChatMessages: (sid: string, messages: NormalizedMessage[]) => void,
): void {
  // getChatMessages doesn't have a by-id helper; pull a small window with
  // includeHidden=true and find by id.
  const rows = getChatMessages(db, sessionId, { after: rowId - 1, limit: 1, includeHidden: true });
  const row = rows.find((r) => r.id === rowId);
  if (!row) return;
  const projected = rowToNormalizedMessage(row);
  broadcastChatMessages(sessionId, [projected]);
}
