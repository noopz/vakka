import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { MqttClient } from "mqtt";
import type { Database } from "bun:sqlite";
import { topics, extractSessionId, extractSubtopic, systemTopics } from "../shared/mqtt.js";
import { getChatMessages } from "../db/queries.js";
import { rowToNormalizedMessage } from "../manager/chat-message-projection.js";
import { validateWsAuth } from "./auth.js";
import { logger } from "../shared/logger.js";
import type { NormalizedMessage } from "../shared/message-types.js";

// ── Manager-online tracking ──────────────────────────────────────────
// Cached so api.ts can gate spawn/kill/restart endpoints without a per-request
// MQTT round-trip. Updated by the manager_online subscription set up below.
interface ManagerOnlineState {
  status: "up" | "down";
  pid?: number;
  startedAt?: number;
  graceful?: boolean;
  restarting?: boolean;
}
let lastManagerOnline: ManagerOnlineState = { status: "down" };
export function getManagerOnline(): ManagerOnlineState {
  return lastManagerOnline;
}
export function isManagerOnline(): boolean {
  return lastManagerOnline.status === "up";
}

interface ClientState {
  subscribedSessions: Set<string>;
  mqttHandler: (topic: string, payload: Buffer) => void;
}

const clientStates = new WeakMap<WebSocket, ClientState>();

// Module-level reference to the active WebSocketServer so broadcasts initiated
// by the manager-side mqtt-handler (which holds no `wss` reference) can fan
// out to subscribed clients.
let activeWss: WebSocketServer | null = null;

/**
 * Send a `{ type: 'chat_messages', sessionId, messages }` payload to every
 * connected WebSocket client subscribed to `sessionId`. Called by
 * mqtt-handler after normalize+insert and by HTTP routes (e.g. plan-response)
 * after an out-of-band row update.
 */
export function broadcastChatMessages(
  sessionId: string,
  messages: NormalizedMessage[],
): void {
  if (!activeWss || messages.length === 0) return;
  const payload = JSON.stringify({ type: "chat_messages", sessionId, messages });
  for (const client of activeWss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const state = clientStates.get(client);
    if (!state?.subscribedSessions.has(sessionId)) continue;
    client.send(payload);
  }
}

// Refcount MQTT subscriptions so we only subscribe/unsubscribe once per session
// regardless of how many WS clients are watching it
const mqttSubCounts = new Map<string, number>();

// In-flight streaming accumulator per session. Survives client unsubscribes so
// a user who navigates away mid-stream can resume from the current watermark
// instead of losing the prefix. Snapshot-replace pattern: on (re)subscribe we
// send the latest text and the client overwrites its streamingContent.
interface StreamSnapshot {
  uuid: string | null;
  text: string;
}
const streamSnapshots = new Map<string, StreamSnapshot>();

export function setupWebSocket(server: Server, mqttClient: MqttClient, db: Database): void {
  const wss = new WebSocketServer({ noServer: true });
  activeWss = wss;

  // Subscribe to manager_online so we can both cache state for isManagerOnline()
  // and push transitions to every connected client.
  mqttClient.subscribe(systemTopics.managerOnline, (err) => {
    if (err) logger.error("ws", "Failed to subscribe to manager_online", err);
  });
  // Wildcard subscription to every session's output topic — independent of
  // any individual client's subscribe lifecycle. This is what makes the
  // snapshot survive nav-away: deltas accumulate here regardless of WS subs.
  mqttClient.subscribe("vakka/sessions/+/output", (err) => {
    if (err) logger.error("ws", "Failed to subscribe to session output wildcard", err);
  });
  // Wildcard subscription for cross-process chat_messages broadcasts. The
  // mqtt-handler runs in the manager process, so it can't directly call
  // broadcastChatMessages here — it publishes to this topic instead and we
  // fan out to subscribed clients via the per-client handler below.
  mqttClient.subscribe("vakka/sessions/+/chat_messages", (err) => {
    if (err) logger.error("ws", "Failed to subscribe to chat_messages wildcard", err);
  });
  mqttClient.on("message", (topic, payload) => {
    const sid = extractSessionId(topic);
    const sub = extractSubtopic(topic);
    if (sid && sub === "output" && payload.length > 0) {
      try {
        const data = JSON.parse(payload.toString()) as any;
        updateStreamSnapshot(sid, data);
      } catch {
        /* malformed payload — ignore for snapshot purposes */
      }
    }
    if (topic !== systemTopics.managerOnline) return;
    if (payload.length === 0) return;
    try {
      const data = JSON.parse(payload.toString()) as ManagerOnlineState;
      lastManagerOnline = data;
      const broadcast = JSON.stringify({ type: "manager_online", ...data });
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(broadcast);
      }
      logger.info("ws", `manager_online → ${data.status}${data.startedAt ? ` (startedAt=${data.startedAt})` : ""}`);
    } catch (err) {
      logger.warn("ws", "Failed to parse manager_online payload", err);
    }
  });

  // Handle HTTP upgrade — authenticate via Sec-WebSocket-Protocol subprotocol
  // (preferred) or query string (deprecated, one-release fallback).
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const result = validateWsAuth(req);
    if (!result.ok) {
      const deviceId = url.searchParams.get("device") ?? "unknown";
      logger.warn("ws", `WebSocket auth rejected for device ${deviceId}`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // If auth came via subprotocol we must echo it back in the response —
    // browsers reject the handshake if the server doesn't pick one of the
    // offered subprotocols. The `ws` library picks the FIRST subprotocol
    // from the request's Sec-WebSocket-Protocol header, so rewrite the
    // header to contain only our matched value.
    if (result.subprotocol) {
      (req.headers as Record<string, string>)["sec-websocket-protocol"] =
        result.subprotocol;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    logger.info("ws", "Client connected");

    // Send a snapshot of manager_online so banners/health indicators render
    // without waiting for the next state transition.
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "manager_online", ...lastManagerOnline }));
    }

    const mqttHandler = (topic: string, payload: Buffer) => {
      const sessionId = extractSessionId(topic);
      const subtopic = extractSubtopic(topic);
      if (!sessionId || !subtopic) return;

      const state = clientStates.get(ws);
      if (!state?.subscribedSessions.has(sessionId)) return;

      let data: unknown;
      try {
        data = JSON.parse(payload.toString());
      } catch {
        data = payload.toString();
      }

      // Row-producing subtopics fold into a unified `chat_messages` broadcast
      // emitted by mqtt-handler after normalize+insert. Skip the raw-envelope
      // forward to avoid duplicate frontend rendering.
      //
      // EXCEPTION: streaming-delta envelopes inside the `output` subtopic
      // (text_delta, input_json_delta, message_start/stop, content_block_*,
      // stream_event) are NOT row-producing — the frontend's existing
      // streaming branches consume them via the raw forward. Detect by
      // peeking at data.type.
      if (
        subtopic === "permission" ||
        subtopic === "question" ||
        subtopic === "permission_response" ||
        subtopic === "question_response" ||
        subtopic === "input"
      ) {
        return;
      }
      if (subtopic === "chat_messages") {
        if (ws.readyState === WebSocket.OPEN) {
          const messages = Array.isArray(data) ? data : [];
          ws.send(JSON.stringify({ type: "chat_messages", sessionId, messages }));
        }
        return;
      }
      if (subtopic === "output") {
        const t = (data as any)?.type;
        // Suppress only the row-producing output kinds; pass deltas through.
        if (t === "assistant" || t === "user" || t === "system") {
          return;
        }
      }

      if (ws.readyState === WebSocket.OPEN) {
        const msg = JSON.stringify({ type: "mqtt", sessionId, subtopic, data });
        ws.send(msg);
        if (subtopic !== "context") {
          logger.debug("ws", `→ client: ${subtopic} (${msg.length} bytes)`);
        }
      }
    };

    const state: ClientState = {
      subscribedSessions: new Set(),
      mqttHandler,
    };
    clientStates.set(ws, state);

    // Attach a single MQTT listener for this client
    mqttClient.on("message", mqttHandler);

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
        return;
      }

      handleClientMessage(ws, msg, mqttClient, db);
    });

    ws.on("close", () => {
      logger.info("ws", "Client disconnected");
      cleanup(ws, mqttClient);
    });

    ws.on("error", (err) => {
      logger.error("ws", "WebSocket error", err);
      cleanup(ws, mqttClient);
    });
  });

  logger.info("ws", "WebSocket server initialized");
}

// Maintain the per-session streaming accumulator from raw output payloads.
// Mirrors the client-side handler in chat-view.tsx so a snapshot replays
// exactly what the client would have appended itself.
function updateStreamSnapshot(sessionId: string, data: any): void {
  if (!data || typeof data !== "object") return;
  // Turn complete or full assistant message landed → clear in-flight buffer.
  if (data.type === "result" || data.type === "assistant") {
    streamSnapshots.delete(sessionId);
    return;
  }
  if (data.type === "stream_event") {
    const event = data.event;
    if (!event) return;
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      const chunk = event.delta.text ?? "";
      if (!chunk) return;
      const incomingUuid = data.uuid ?? "streaming";
      const cur = streamSnapshots.get(sessionId);
      if (!cur || cur.uuid !== incomingUuid) {
        // New turn (or first chunk) — reset.
        streamSnapshots.set(sessionId, { uuid: incomingUuid, text: chunk });
      } else {
        cur.text += chunk;
      }
    }
  }
}

function handleClientMessage(
  ws: WebSocket,
  msg: any,
  mqttClient: MqttClient,
  db: Database,
): void {
  const state = clientStates.get(ws);
  if (!state) return;

  switch (msg.type) {
    case "subscribe": {
      const { sessionId } = msg;
      if (!sessionId) return;
      subscribeToSession(state, sessionId, mqttClient);
      // Replay the in-flight stream watermark so a client that navigated
      // away mid-stream can resume without losing the prefix.
      const snap = streamSnapshots.get(sessionId);
      if (snap && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "stream_snapshot",
          sessionId,
          uuid: snap.uuid,
          text: snap.text,
        }));
      }
      logger.info("ws", `Client subscribed to session ${sessionId}`);
      break;
    }

    case "unsubscribe": {
      const { sessionId } = msg;
      if (!sessionId) return;
      unsubscribeFromSession(state, sessionId, mqttClient);
      logger.info("ws", `Client unsubscribed from session ${sessionId}`);
      break;
    }

    case "message": {
      const { sessionId, text } = msg;
      if (!sessionId || !text) return;
      const t = topics(sessionId);
      mqttClient.publish(t.input, JSON.stringify({ text }));
      break;
    }

    case "permission_response": {
      const { sessionId, decision, tool, toolUseId, message } = msg;
      if (!sessionId || !decision || !tool) return;
      const t = topics(sessionId);
      mqttClient.publish(
        t.permissionResponse,
        JSON.stringify({ decision, tool, toolUseId, message }),
      );
      break;
    }

    case "question_response": {
      const { sessionId, answer, questionId } = msg;
      if (!sessionId || answer === undefined) return;
      const t = topics(sessionId);
      mqttClient.publish(
        t.questionResponse,
        JSON.stringify({ answer, questionId }),
      );
      break;
    }

    case "interrupt": {
      const { sessionId } = msg;
      if (!sessionId) return;
      const t = topics(sessionId);
      mqttClient.publish(t.interrupt, JSON.stringify({ reason: "user" }));
      logger.info("ws", `Interrupt sent for session ${sessionId}`);
      break;
    }

    case "ping": {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pong" }));
      }
      break;
    }

    case "catchup": {
      const { sessionId, afterMessageId } = msg;
      if (!sessionId) return;

      // Fetch missed messages from SQLite, project to NormalizedMessage[] so
      // the frontend's upsert reducer handles catchup the same way as live.
      const rows = getChatMessages(db, sessionId, {
        after: afterMessageId ?? 0,
        limit: 500,
      });
      const messages = rows.map(rowToNormalizedMessage);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: "catchup", sessionId, messages }),
        );
      }

      // Then subscribe to live updates
      subscribeToSession(state, sessionId, mqttClient);
      logger.info("ws", `Client caught up on session ${sessionId}, ${messages.length} messages`);
      break;
    }

    default:
      ws.send(JSON.stringify({ type: "error", error: `Unknown message type: ${msg.type}` }));
  }
}

function subscribeToSession(
  state: ClientState,
  sessionId: string,
  mqttClient: MqttClient,
): void {
  if (state.subscribedSessions.has(sessionId)) return;

  state.subscribedSessions.add(sessionId);

  const count = mqttSubCounts.get(sessionId) ?? 0;
  mqttSubCounts.set(sessionId, count + 1);

  // Only subscribe to MQTT if this is the first WS client watching this session.
  // NOTE: t.output is intentionally absent here — it's covered by the wildcard
  // `vakka/sessions/+/output` subscription set up at startup. With Mosquitto's
  // default `allow_duplicate_messages=false`, overlapping subscriptions on the
  // same client connection deliver one copy per matching subscription, so
  // adding t.output here would double every delta (both in the snapshot
  // accumulator and in the per-client forward), garbling streaming text.
  if (count === 0) {
    const t = topics(sessionId);
    const sessionTopics = [t.input, t.status, t.cost, t.permission, t.permissionResponse, t.question, t.questionResponse, t.context];
    for (const topic of sessionTopics) {
      mqttClient.subscribe(topic, (err) => {
        if (err) logger.error("ws", `Failed to subscribe to ${topic}`, err);
      });
    }
    logger.info("ws", `Subscribed to MQTT topics for session ${sessionId}`);
  } else {
    logger.debug("ws", `Session ${sessionId} already subscribed (${count + 1} clients)`);
  }
}

function unsubscribeFromSession(
  state: ClientState,
  sessionId: string,
  mqttClient: MqttClient,
): void {
  if (!state.subscribedSessions.has(sessionId)) return;

  state.subscribedSessions.delete(sessionId);

  const count = (mqttSubCounts.get(sessionId) ?? 1) - 1;
  if (count <= 0) {
    mqttSubCounts.delete(sessionId);
    const t = topics(sessionId);
    // t.output omitted to match subscribeToSession — covered by the wildcard.
    const sessionTopics = [t.input, t.status, t.cost, t.permission, t.permissionResponse, t.question, t.questionResponse, t.context];
    for (const topic of sessionTopics) {
      mqttClient.unsubscribe(topic);
    }
    logger.info("ws", `Unsubscribed from MQTT topics for session ${sessionId}`);
  } else {
    mqttSubCounts.set(sessionId, count);
  }
}

function cleanup(ws: WebSocket, mqttClient: MqttClient): void {
  const state = clientStates.get(ws);
  if (!state) return;

  // Remove the MQTT listener for this client
  mqttClient.removeListener("message", state.mqttHandler);

  // Unsubscribe from all sessions
  for (const sessionId of state.subscribedSessions) {
    unsubscribeFromSession(state, sessionId, mqttClient);
  }

  clientStates.delete(ws);
}
