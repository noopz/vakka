// CC Remote Control Relay (v0.1.B spike).
//
// Implements the worker-side endpoints that CC's bridge dials when its
// /v1/code/sessions/{cseId}/bridge response has had api_base_url rewritten to
// point here. Short-circuit variant — does NOT proxy worker events back upstream
// to Anthropic. Anthropic-side telemetry will diverge for sessions routed
// through this relay; ban-risk acknowledged in docs/cc-rc-protocol.md.
//
// Auth model: TOFU JWT pinning per cseId. The first request that carries an
// Authorization: Bearer <jwt> header registers that JWT against the session;
// subsequent requests for the same cseId must present the same JWT or get 401.
//
// Endpoints (all under /v1/code/sessions/:cseId/...):
//   POST  /bridge                    — short-circuit, mints a fake worker_jwt.
//   GET   /worker/events/stream      — SSE down. Sends :keepalive every 15s.
//   POST  /worker/events             — worker→server batch. 200 with {results}.
//   POST  /worker/events/delivery    — worker ACK of received SSE events. 200 {}.
//   POST  /worker/heartbeat          — periodic ping. 200 {}.
//   GET   /worker                    — worker poll. 200 {worker: {...}}.
//   PUT   /worker                    — worker status update. 200 {}.

import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Full-fidelity capture log. Every event payload, status PUT, and SSE push gets
// a line. Mine offline with jq / python to answer protocol-shape questions
// without re-running CC. Disable with VK_RC_NO_LOG=1.
const LOG_DIR = join(homedir(), ".vakka");
const LOG_PATH = join(LOG_DIR, "rc-relay-events.ndjson");
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const LOG_ENABLED = process.env.VK_RC_NO_LOG !== "1";

function ndjson(record: object): void {
  if (!LOG_ENABLED) return;
  try { appendFileSync(LOG_PATH, JSON.stringify(record) + "\n"); } catch {}
}

type SseClient = {
  res: Response;
  cseId: string;
  closed: boolean;
};

type SessionState = {
  cseId: string;
  workerEpoch: number;
  sequenceNum: number;
  sseClients: Set<SseClient>;
  lastWorkerStatus: string;
  events: Array<{ event_id: string; sequence_num: string; payload: unknown; ts: number }>;
  // TOFU JWT pin. Null until the first request with Authorization: Bearer.
  workerJwt: string | null;
};

export type RelayLogger = (line: string, extra?: unknown) => void;

// Fire-and-forget hook for downstream consumers (e.g. the rc-attached MQTT
// bridge). Called for every observable side-effect on a session — wraps the
// same data already written to the NDJSON capture log, but in-process so we
// don't need to tail a file.
export type RelayEventHook = (e: RelayEvent) => void;

export type RelayEvent =
  | { kind: "worker_event"; cseId: string; event_id: string; sequence_num: string; payload: unknown }
  | { kind: "worker_put"; cseId: string; body: { worker_status?: string; external_metadata?: unknown } }
  | { kind: "session_patch"; sessionId: string; body: unknown }
  | { kind: "sse_push"; cseId: string; event: string; data: Record<string, unknown> }
  | { kind: "sse_open"; cseId: string }
  | { kind: "sse_close"; cseId: string; remainingClients: number };

export type CcRcRelay = {
  router: Router;
  pushFrame: (cseId: string, frame: SseFrame) => number; // returns # delivered
  getState: (cseId: string) => SessionState | undefined;
  listSessions: () => string[];
};

export type SseFrame = {
  event?: string; // outer SSE `event:` name. Defaults to "client_event".
  // The inner JSON envelope. event_id + sequence_num auto-filled if absent.
  data: Record<string, unknown> & { event_id?: string; sequence_num?: string };
};

export function createCcRcRelay(opts: { log?: RelayLogger; onEvent?: RelayEventHook } = {}): CcRcRelay {
  const router = Router();
  const sessions = new Map<string, SessionState>();
  const emit = opts.onEvent ?? (() => {});
  const log = opts.log ?? ((line: string, extra?: unknown) => {
    if (extra !== undefined) console.log(`[rc-relay] ${line}`, extra);
    else console.log(`[rc-relay] ${line}`);
  });

  function getOrCreate(cseId: string): SessionState {
    let s = sessions.get(cseId);
    if (!s) {
      s = {
        cseId,
        workerEpoch: 1,
        sequenceNum: 0,
        sseClients: new Set(),
        lastWorkerStatus: "WORKER_STATUS_UNSPECIFIED",
        events: [],
        workerJwt: null,
      };
      sessions.set(cseId, s);
      log(`session opened: ${cseId}`);
    }
    return s;
  }

  // Extract `Authorization: Bearer <jwt>` from the request. Returns null when
  // missing or malformed.
  function extractBearer(req: Request): string | null {
    const h = req.headers.authorization;
    if (!h || typeof h !== "string") return null;
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1].trim() : null;
  }

  // TOFU JWT pin. On first call for a session with a presented jwt, store it
  // and accept. Subsequent calls must present the same jwt. Missing/empty jwt
  // is rejected once a pin exists; the first call MAY pin with an empty value
  // (treated the same as no pin → still null) — practically the bridge ALWAYS
  // sends a bearer, so this is a non-issue.
  function pinOrCheckJwt(s: SessionState, req: Request): boolean {
    const presented = extractBearer(req);
    if (s.workerJwt === null) {
      if (!presented) return false;
      s.workerJwt = presented;
      log(`TOFU pin ${s.cseId} → jwt=${presented.slice(0, 8)}…`);
      return true;
    }
    return presented !== null && presented === s.workerJwt;
  }

  // ── GET /healthz ─────────────────────────────────────────────────────
  // Liveness probe for the cc-preload.js fetch hook. Mounted before the
  // catch-all logger so the high-frequency probe traffic stays out of the
  // ndjson capture file.
  router.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Catch-all logger — runs for every incoming request, including ones that
  // fall through to a 404 or get rejected with 401 by a handler. Mounted
  // BEFORE the route handlers so it always sees the request.
  router.use((req, _res, next) => {
    ndjson({
      ts: Date.now(), kind: "incoming",
      method: req.method, path: req.path, query: req.query, body: req.body,
    });
    next();
  });

  // ── POST /bridge ─────────────────────────────────────────────────────
  // Short-circuit — never reached when mitmproxy rewrites Anthropic's response,
  // but useful as a fallback if the shim points CC's bridge POST directly here.
  router.post("/v1/code/sessions/:cseId/bridge", (req, res) => {
    const { cseId } = req.params;
    const s = getOrCreate(cseId);
    if (!pinOrCheckJwt(s, req)) { res.status(401).end(); return; }
    const fakeJwt = "vk-relay-fake-jwt-" + randomUUID();
    log(`POST /bridge ${cseId} → mint fake jwt epoch=${s.workerEpoch}`);
    res.json({
      api_base_url: `http://${req.get("host")}`,
      expires_in: 14400,
      worker_epoch: String(s.workerEpoch),
      worker_jwt: fakeJwt,
    });
  });

  // ── GET /worker/events/stream ────────────────────────────────────────
  router.get("/v1/code/sessions/:cseId/worker/events/stream", (req, res) => {
    const { cseId } = req.params;
    const s = getOrCreate(cseId);
    if (!pinOrCheckJwt(s, req)) { res.status(401).end(); return; }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const client: SseClient = { res, cseId, closed: false };
    s.sseClients.add(client);
    log(`SSE open ${cseId} (clients=${s.sseClients.size})`);
    try { emit({ kind: "sse_open", cseId }); } catch (e) { log(`onEvent threw`, e); }

    // Initial keepalive so the client knows the stream is live.
    res.write(`:keepalive\n\n`);

    const ka = setInterval(() => {
      if (client.closed) return;
      try { res.write(`:keepalive\n\n`); } catch {}
    }, 15000);

    req.on("close", () => {
      client.closed = true;
      clearInterval(ka);
      s.sseClients.delete(client);
      log(`SSE close ${cseId} (clients=${s.sseClients.size})`);
      try { emit({ kind: "sse_close", cseId, remainingClients: s.sseClients.size }); } catch (e) { log(`onEvent threw`, e); }
    });
  });

  // ── POST /worker/events ──────────────────────────────────────────────
  router.post("/v1/code/sessions/:cseId/worker/events", (req, res) => {
    const { cseId } = req.params;
    const s = getOrCreate(cseId);
    if (!pinOrCheckJwt(s, req)) { res.status(401).end(); return; }
    const body = req.body as { worker_epoch?: number; events?: Array<{ payload: unknown }> };
    const evs = body?.events ?? [];

    const results = evs.map((ev) => {
      s.sequenceNum += 1;
      const event_id = randomUUID();
      const sequence_num = String(s.sequenceNum);
      s.events.push({ event_id, sequence_num, payload: ev.payload, ts: Date.now() });
      const payloadType = (ev.payload as { type?: string } | undefined)?.type ?? "?";
      log(`worker→server event ${cseId} type=${payloadType} seq=${sequence_num}`);
      ndjson({
        ts: Date.now(), kind: "worker_event", cseId, event_id, sequence_num,
        payload_type: payloadType, payload: ev.payload,
      });
      try { emit({ kind: "worker_event", cseId, event_id, sequence_num, payload: ev.payload }); } catch (e) { log(`onEvent threw`, e); }
      return { duplicate: false, event_id, sequence_num };
    });
    res.json({ results });
  });

  // ── POST /worker/events/delivery ─────────────────────────────────────
  router.post("/v1/code/sessions/:cseId/worker/events/delivery", (req, res) => {
    const { cseId } = req.params;
    const s = getOrCreate(cseId);
    if (!pinOrCheckJwt(s, req)) { res.status(401).end(); return; }
    const body = req.body as { updates?: Array<{ event_id: string; status: string }> };
    const updates = body?.updates ?? [];
    log(`worker delivery ack ${cseId} count=${updates.length}`, updates);
    ndjson({ ts: Date.now(), kind: "delivery_ack", cseId, body });
    res.json({});
  });

  // ── POST /worker/heartbeat ───────────────────────────────────────────
  router.post("/v1/code/sessions/:cseId/worker/heartbeat", (req, res) => {
    const { cseId } = req.params;
    const s = getOrCreate(cseId);
    if (!pinOrCheckJwt(s, req)) { res.status(401).end(); return; }
    ndjson({ ts: Date.now(), kind: "heartbeat", cseId, body: req.body });
    res.json({});
  });

  // ── GET /worker ──────────────────────────────────────────────────────
  router.get("/v1/code/sessions/:cseId/worker", (req, res) => {
    const { cseId } = req.params;
    const s = getOrCreate(cseId);
    if (!pinOrCheckJwt(s, req)) { res.status(401).end(); return; }
    res.json({
      worker: {
        session_id: cseId,
        worker_epoch: s.workerEpoch,
        worker_status: s.lastWorkerStatus,
      },
    });
  });

  // ── PUT /worker ──────────────────────────────────────────────────────
  router.put("/v1/code/sessions/:cseId/worker", (req, res) => {
    const { cseId } = req.params;
    const s = getOrCreate(cseId);
    if (!pinOrCheckJwt(s, req)) { res.status(401).end(); return; }
    const body = req.body as { worker_status?: string; external_metadata?: unknown };
    if (body?.worker_status) {
      s.lastWorkerStatus = body.worker_status;
      log(`worker status ${cseId} → ${body.worker_status}`);
    }
    ndjson({ ts: Date.now(), kind: "worker_put", cseId, body });
    try { emit({ kind: "worker_put", cseId, body }); } catch (e) { log(`onEvent threw`, e); }
    res.json({});
  });

  // ── client/presence (control plane, OAuth — but accept here too) ─────
  router.post("/v1/code/sessions/:cseId/client/presence", (req, res) => {
    const { cseId } = req.params;
    const s = getOrCreate(cseId);
    if (!pinOrCheckJwt(s, req)) { res.status(401).end(); return; }
    ndjson({ ts: Date.now(), kind: "presence", cseId, body: req.body });
    res.json({ refresh_after_seconds: 20 });
  });

  // ── PATCH /v1/sessions/:sessionId (autotitle) ────────────────────────
  router.patch("/v1/sessions/:sessionId", (req, res) => {
    const { sessionId } = req.params;
    const s = getOrCreate(sessionId);
    if (!pinOrCheckJwt(s, req)) { res.status(401).end(); return; }
    log(`PATCH /v1/sessions/${sessionId}`, req.body);
    ndjson({ ts: Date.now(), kind: "session_patch", sessionId, body: req.body });
    try { emit({ kind: "session_patch", sessionId, body: req.body }); } catch (e) { log(`onEvent threw`, e); }
    res.json({ id: sessionId, ...(req.body as object) });
  });

  // ── POST /v1/sessions/:sessionId/archive ─────────────────────────────
  router.post("/v1/sessions/:sessionId/archive", (req, res) => {
    const { sessionId } = req.params;
    const s = getOrCreate(sessionId);
    if (!pinOrCheckJwt(s, req)) { res.status(401).end(); return; }
    log(`archive /v1/sessions/${sessionId}`);
    ndjson({ ts: Date.now(), kind: "archive", sessionId, body: req.body });
    res.json({});
  });

  function pushFrame(cseId: string, frame: SseFrame): number {
    const s = getOrCreate(cseId);
    s.sequenceNum += 1;
    const data = {
      event_id: frame.data.event_id ?? randomUUID(),
      sequence_num: frame.data.sequence_num ?? String(s.sequenceNum),
      ...frame.data,
      created_at: (frame.data as { created_at?: string }).created_at ?? new Date().toISOString(),
    };
    const eventName = frame.event ?? "client_event";
    const wire =
      `event: ${eventName}\n` +
      `id: ${data.sequence_num}\n` +
      `data: ${JSON.stringify(data)}\n\n`;

    let delivered = 0;
    for (const c of s.sseClients) {
      if (c.closed) continue;
      try {
        c.res.write(wire);
        delivered += 1;
      } catch {
        c.closed = true;
      }
    }
    log(`pushFrame ${cseId} event=${eventName} seq=${data.sequence_num} delivered=${delivered}`);
    ndjson({ ts: Date.now(), kind: "sse_push", cseId, event: eventName, data, delivered });
    try { emit({ kind: "sse_push", cseId, event: eventName, data }); } catch (e) { log(`onEvent threw`, e); }
    return delivered;
  }

  return {
    router,
    pushFrame,
    getState: (cseId) => sessions.get(cseId),
    listSessions: () => [...sessions.keys()],
  };
}
