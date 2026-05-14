// rc-attached — third control mode, ADDITIVE.
//
// Maps CC RC relay events onto Vakka's existing MQTT envelope shape so that
// chat-view can render `controlMode: "rc-attached"` sessions through the
// SAME `vakka/sessions/<id>/{output,status,cost,permission,hello}` topics
// the SDK-spawn and CC-live-snoop modes already publish to.
//
// Strict additive: this module is the ONLY consumer of relay events. It does
// not edit the SDK wrapper, snoop pipeline, or any existing manager code.
// To remove this mode entirely, delete this file + the `case "rc-attached"`
// branch in src/manager/index.ts (when it lands) — nothing else.
//
// Topic mapping (from docs/cc-rc-protocol.md):
//   payload.type = "assistant"             → output (assistant message)
//   payload.type = "user" (string content) → input  (typed user message)
//   payload.type = "user" (tool_result[])  → output (SDK-shaped tool_result envelope)
//   payload.type = "user" (text[])         → output (system notice)
//   payload.type = "result"                → cost + status="completed" turn boundary
//   payload.type = "control_request"       → permission (subtype=can_use_tool)
//   payload.type = "control_response"      → permission_response
//   PUT /worker.worker_status              → status (idle/running/requires_action)
//   PUT /worker.requires_action_details    → permission (enriched metadata)

import type { MqttClient } from "mqtt";
import type { Database } from "bun:sqlite";
import type { CcRcRelay, RelayEvent } from "../relay/cc-rc-relay.js";
import { topics } from "../shared/mqtt.js";
import { findActiveProjectCwds } from "./libproc-liveness.js";
import { readFileSync, existsSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const CC_SESSIONS_DIR = join(homedir(), ".claude", "sessions");

// Strip the leading "cse_" or "session_" prefix; CC writes the manifest with
// `session_…` but our relay observes `cse_…` — same id underneath.
function bareSessionId(id: string): string {
  return id.replace(/^(?:cse_|session_)/, "");
}

// Authoritative cseId → PID lookup via CC's per-process manifest at
// ~/.claude/sessions/<PID>.json. Each file CC writes contains a
// `bridgeSessionId` field set to its current RC session id. We scan the
// directory, match by bare id, and verify the PID is alive (kill(0)) to
// guard against stale manifests left by crashed CCs whose PID got recycled.
//
// Strings in the CC binary at ~/.local/share/claude/versions/<ver> confirm
// `bridgeSessionId`/`bridgeSessionSeq` are CC's own field names.
function lookupRcWorkerFromManifest(
  cseId: string,
): { pid: number; cwd: string; sdkSessionId: string | null } | null {
  const target = bareSessionId(cseId);
  let entries: string[];
  try { entries = readdirSync(CC_SESSIONS_DIR); } catch { return null; }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(join(CC_SESSIONS_DIR, entry), "utf-8"));
    } catch { continue; }
    const bsid = data.bridgeSessionId as string | undefined;
    if (!bsid) continue;
    if (bareSessionId(bsid) !== target) continue;
    const pid = data.pid as number | undefined;
    const cwd = data.cwd as string | undefined;
    if (typeof pid !== "number" || !cwd) continue;
    // Stale-PID guard: if the manifest's PID is dead, ignore.
    try { process.kill(pid, 0); } catch { continue; }
    // `sessionId` is CC's conversation uuid (= Vekka's sdk_session_id);
    // distinct from `bridgeSessionId`. Best-effort — older CCs may omit it.
    const sdkSessionId = typeof data.sessionId === "string" ? data.sessionId : null;
    return { pid, cwd, sdkSessionId };
  }
  return null;
}

// Wait for CC to write its session manifest. CC writes ~/.claude/sessions/<pid>.json
// shortly after dialing /bridge — that file is what gives us the cseId we'll use
// as the Vekka session id. We poll every 200ms up to timeoutMs; if the spawned
// claude process exits first (via the `exited` promise), we bail with an error.
//
// The pid field IN the manifest must match the argument — a stale manifest from
// a recycled PID (claude crashed, OS reused the pid, our scan finds the old file)
// would otherwise return someone else's bridgeSessionId.
//
// We return the cseId in the `cse_…` form (the canonical Vekka session id, matching
// what the relay observes in URLs and what rc-attached's announce() uses for its
// row id). The manifest writes `session_…`; we normalize.
export async function awaitManifestForPid(
  pid: number,
  exited: Promise<unknown>,
  timeoutMs = 10_000,
): Promise<{ cseId: string; cwd: string; sdkSessionId: string } | { error: string }> {
  const manifestPath = join(CC_SESSIONS_DIR, `${pid}.json`);
  const deadline = Date.now() + timeoutMs;
  let exitedFlag = false;
  exited.then(() => { exitedFlag = true; }, () => { exitedFlag = true; });

  while (Date.now() < deadline) {
    if (exitedFlag) {
      return { error: "claude exited before manifest" };
    }
    try {
      const data = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      const manifestPid = data.pid as number | undefined;
      const bsid = data.bridgeSessionId as string | undefined;
      const cwd = data.cwd as string | undefined;
      const sdkSessionId = data.sessionId as string | undefined;
      if (typeof manifestPid === "number" && manifestPid === pid && bsid && cwd && sdkSessionId) {
        return { cseId: `cse_${bareSessionId(bsid)}`, cwd, sdkSessionId };
      }
    } catch {
      // file not present yet; keep polling
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { error: "manifest poll timed out" };
}

const RELAY_LOG = join(homedir(), ".vakka", "rc-relay-events.ndjson");
const UNKNOWNS_LOG = join(homedir(), ".vakka", "rc-unknowns.ndjson");

// Append a record to ~/.vakka/rc-unknowns.ndjson tagged with category + sample
// payload, so unmapped wire shapes (new control_request subtypes, untested
// permission decisions, the question tool, deny-with-reason, etc.) become
// trivially greppable. `tail -F ~/.vakka/rc-unknowns.ndjson` while exercising
// the feature shows exactly what shape needs handling next.
export function logUnknown(category: string, detail: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(UNKNOWNS_LOG), { recursive: true });
    appendFileSync(
      UNKNOWNS_LOG,
      JSON.stringify({ ts: Date.now(), category, ...detail }) + "\n",
    );
    console.log(`[rc-unknown] ${category}`, detail);
  } catch {
    // best-effort logging; never throw from a hot path
  }
}

// Replay the most recent unresolved `control_request` for a cseId by scanning
// the relay's NDJSON capture log. Used on SSE_open after a Vakka restart so
// permissions blocked mid-flight (CC waiting on a tool_use) become clickable
// again in the chat-view without requiring CC to re-emit on its own.
//
// "Unresolved" = no subsequent control_response or control_cancel_request
// for the same tool_use_id appears later in the log.
function findPendingPermission(cseId: string): { request: Record<string, unknown>; request_id?: string } | null {
  if (!existsSync(RELAY_LOG)) return null;
  let txt: string;
  try { txt = readFileSync(RELAY_LOG, "utf-8"); } catch { return null; }
  const lines = txt.split("\n").filter(Boolean);
  // Walk from newest to oldest so we find the latest pending request.
  let lastRequest: Record<string, unknown> | null = null;
  let lastRequestId: string | undefined;
  let lastToolUseId: string | undefined;
  const resolvedToolUseIds = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    let r: Record<string, unknown>;
    try { r = JSON.parse(lines[i]); } catch { continue; }
    if (r.cseId !== cseId) continue;
    if (r.kind !== "worker_event") continue;
    const payload = r.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    const ptype = payload.type as string | undefined;
    if (ptype === "control_response" || ptype === "control_cancel_request") {
      const resp = payload.response as Record<string, unknown> | undefined;
      const tu = (resp?.tool_use_id ?? resp?.toolUseId) as string | undefined;
      if (tu) resolvedToolUseIds.add(tu);
      continue;
    }
    if (ptype === "control_request") {
      const req = payload.request as Record<string, unknown> | undefined;
      if (!req || (req.subtype as string) !== "can_use_tool") continue;
      const tu = (req.tool_use_id ?? req.toolUseId) as string | undefined;
      if (!tu || resolvedToolUseIds.has(tu)) continue;
      lastRequest = req;
      lastRequestId = payload.request_id as string | undefined;
      lastToolUseId = tu;
      break;
    }
  }
  if (!lastRequest || !lastToolUseId) return null;
  return { request: lastRequest, request_id: lastRequestId };
}

type Json = Record<string, unknown>;

// In-memory registry of currently-attached RC sessions. Populated by the
// relay event handler; queried by GET /api/rc-sessions for the home card.
// Keyed by cseId (which we also use as Vakka session id for v0.1.B).
export interface RcSessionInfo {
  cseId: string;
  sessionId: string;
  startedAt: number;
  lastActivity: number;
  workerStatus: string;
  cumulativeCostUsd: number;
  lastAssistantPreview: string | null;
  // Resolved on sse_open via libproc: the local `claude` process backing this
  // RC session and its cwd. The wire payload doesn't carry this; we derive it
  // by matching unmapped claude PIDs at attach time.
  pid?: number;
  cwd?: string;
}

const registry = new Map<string, RcSessionInfo>();

// toolUseId → request_id. CC's control_response wire shape needs request_id,
// but chat-view only echoes toolUseId on permission allow/deny. We populate
// this map when a control_request arrives so api.ts can resolve it back.
const requestIdByToolUseId = new Map<string, string>();

// toolUseIds we've already responded to or replayed. The relay's NDJSON log
// only captures worker→server frames, so our outgoing control_response never
// appears there — without this in-memory set, every SSE reconnect would
// re-fire the permission card via findPendingPermission.
const resolvedToolUseIds = new Set<string>();
const replayedToolUseIds = new Set<string>();

// User-input dedup. The same typed message can reach us via three paths:
//   (a) worker_event with `payload.type === "user"` (string content)
//   (b) sse_push with `data.payload.type === "user"`
//   (c) replay of NDJSON-buffered frames on every SSE reconnect
// Without dedup, "what's 2+2?" appears 2-3× per turn. Key on sessionId+content;
// trimmed to last N entries to bound memory.
const recentUserInputs = new Set<string>();
const recentUserInputsOrder: string[] = [];
function findRegistryBySessionId(sessionId: string): RcSessionInfo | undefined {
  for (const v of registry.values()) if (v.sessionId === sessionId) return v;
  return undefined;
}

export function dedupUserInput(sessionId: string, content: string): boolean {
  const key = `${sessionId} ${content}`;
  if (recentUserInputs.has(key)) return true;
  recentUserInputs.add(key);
  recentUserInputsOrder.push(key);
  if (recentUserInputsOrder.length > 500) {
    const drop = recentUserInputsOrder.shift()!;
    recentUserInputs.delete(drop);
  }
  return false;
}

export function markToolUseResolved(toolUseId: string): void {
  resolvedToolUseIds.add(toolUseId);
  requestIdByToolUseId.delete(toolUseId);
}

export function getRcSessions(): RcSessionInfo[] {
  return [...registry.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}

export function getRcSession(cseId: string): RcSessionInfo | undefined {
  return registry.get(cseId);
}

export function getRequestIdForToolUse(toolUseId: string): string | undefined {
  return requestIdByToolUseId.get(toolUseId);
}

export interface RcAttachedBridgeOpts {
  relay: CcRcRelay;
  mqttClient: MqttClient;
  // When provided, rc-attached announces will INSERT OR IGNORE a `sessions`
  // row keyed by cseId so mqtt-handler's FK constraint on `messages` is
  // satisfied. Without this, every assistant/user/permission envelope on a
  // new cseId errors with SQLITE_CONSTRAINT_FOREIGNKEY.
  db?: Database;
  // Map cseId → Vakka sessionId. RC-attached uses cseId directly as the
  // Vakka session id for v0.1.B; Phase v0.1.C may map them through `/shim/register`.
  sessionIdFor?: (cseId: string) => string;
  log?: (line: string, extra?: unknown) => void;
}

export function startRcAttachedBridge(opts: RcAttachedBridgeOpts): { stop: () => void } {
  const { relay, mqttClient } = opts;
  const sessionIdFor = opts.sessionIdFor ?? ((cseId) => cseId);
  const log = opts.log ?? ((line, extra) => {
    if (extra !== undefined) console.log(`[rc-attached] ${line}`, extra);
    else console.log(`[rc-attached] ${line}`);
  });

  // Track which sessions we've already announced so we publish a one-time
  // `hello` envelope per session — chat-view uses this to discover them.
  const announced = new Set<string>();

  function pub(sessionId: string, subtopic: keyof ReturnType<typeof topics>, payload: Json): void {
    const topic = topics(sessionId)[subtopic];
    try {
      mqttClient.publish(topic, JSON.stringify(payload), { qos: 0 });
    } catch (e) {
      log(`publish failed ${topic}`, e);
    }
  }

  function announce(sessionId: string, cseId: string): void {
    if (announced.has(sessionId)) return;
    announced.add(sessionId);
    // hello: minimal — RC-attached sessions have no PID we can claim, so we
    // publish origin + cseId so chat-view can render an `RC` badge.
    pub(sessionId, "hello", {
      origin: "rc-attached",
      cseId,
      startTime: Date.now(),
    });
    pub(sessionId, "status", { status: "running" });
  }

  function _handle(e: RelayEvent): void {
    if (e.kind === "worker_event") {
      const sessionId = sessionIdFor(e.cseId);
      announce(sessionId, e.cseId);
      mapWorkerEvent(sessionId, e.payload, pub, log);
      return;
    }
    if (e.kind === "worker_put") {
      const sessionId = sessionIdFor(e.cseId);
      announce(sessionId, e.cseId);
      mapWorkerPut(sessionId, e.body, pub);
      return;
    }
    if (e.kind === "sse_push") {
      // Controller→worker frames. Echo the user-typed text back as `input`
      // so chat-view shows what the controller (Vakka itself) just sent.
      const sessionId = sessionIdFor(e.cseId);
      const data = e.data as Json;
      const payload = data.payload as Json | undefined;
      if (payload?.type === "user" && (payload as Json).message) {
        const message = (payload as Json).message as Json;
        const content = message.content;
        if (typeof content === "string") {
          pub(sessionId, "input", { text: content, source: "rc-attached" });
        }
      }
    }
  }

  // Hot-swap the relay's event hook. The relay was created with whatever
  // (or no) hook it has now; we wrap it so we don't clobber an existing one.
  // For v0.1.B-alpha the spike doesn't set one, but be defensive.
  relay.router; // (no-op; documents the dependency)

  // The relay only exposes onEvent through its constructor. For an existing
  // instance we'd need a `setOnEvent` method — add one in the relay if
  // mounting after construction. For now this bridge is wired by passing
  // its `handle` as `onEvent` at relay-construction time.
  return {
    stop: () => {
      // No persistent timers. If we add subscriptions later (e.g. listening
      // for permission_response on MQTT to drive `pushFrame`), unhook here.
    },
  };
}

// Exported for the construction-time wiring path: pass this as
// `createCcRcRelay({ onEvent: makeRelayEventHandler({...}) })`.
export function makeRelayEventHandler(opts: Omit<RcAttachedBridgeOpts, "relay">): (e: RelayEvent) => void {
  const sessionIdFor = opts.sessionIdFor ?? ((cseId) => cseId);
  const log = opts.log ?? ((line, extra) => {
    if (extra !== undefined) console.log(`[rc-attached] ${line}`, extra);
    else console.log(`[rc-attached] ${line}`);
  });
  const announced = new Set<string>();
  // Debounced purge timers per cseId. SSE may close + reopen rapidly across
  // network blips; we only drop the registry entry if no reconnect arrives
  // within a grace window.
  const purgeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const PURGE_GRACE_MS = 5000;
  const { mqttClient, db } = opts;

  function pub(sessionId: string, subtopic: keyof ReturnType<typeof topics>, payload: Json): void {
    const topic = topics(sessionId)[subtopic];
    try { mqttClient.publish(topic, JSON.stringify(payload), { qos: 0 }); }
    catch (e) { log(`publish failed ${topic}`, e); }
  }

  function announce(sessionId: string, cseId: string): void {
    if (announced.has(sessionId)) return;
    announced.add(sessionId);
    const now = Date.now();
    registry.set(cseId, {
      cseId,
      sessionId,
      startedAt: now,
      lastActivity: now,
      workerStatus: "WORKER_STATUS_UNSPECIFIED",
      cumulativeCostUsd: 0,
      lastAssistantPreview: null,
    });
    if (db) {
      try {
        // announce() is shared between two flows:
        //   1. True rc-attached: the user spawned `claude --remote-control`
        //      themselves; no Vekka-side row exists yet, so we INSERT the
        //      sentinel project_path and control_mode='rc-attached'.
        //   2. rc-spawned: Vekka spawned CC itself and already created a
        //      session row with the real project_path and
        //      control_mode='rc-spawned'. We must NOT clobber that row.
        // The SELECT below distinguishes the two cases.
        const existing = db.query(
          `SELECT 1 FROM sessions WHERE id = ?1`,
        ).get(sessionId);
        if (!existing) {
          // sessions.project_path FK → projects.path. Ensure the sentinel
          // project exists before inserting the session row.
          db.query(
            `INSERT OR IGNORE INTO projects (path, name, discovered_at, pinned)
             VALUES (?1, ?2, datetime('now'), 0)`,
          ).run("<rc-attached>", "RC Attached");
          // Capture CC's conversation uuid so this externally-attached session
          // is itself resumable later. Best-effort: the manifest may not be
          // written yet at first announce — sdk_session_id stays NULL then.
          const sdkSessionId =
            lookupRcWorkerFromManifest(cseId)?.sdkSessionId ?? null;
          db.query(
            `INSERT INTO sessions (id, project_path, model, control_mode, sdk_session_id)
             VALUES (?1, ?2, ?3, ?4, ?5)`,
          ).run(sessionId, "<rc-attached>", "rc-attached", "rc-attached", sdkSessionId);
        }
      } catch (e) { log(`db insert failed`, e); }
    }
    pub(sessionId, "hello", { origin: "rc-attached", cseId, startTime: now });
    pub(sessionId, "status", { status: "running" });
  }

  function touchRegistry(cseId: string, mut: (s: RcSessionInfo) => void): void {
    const s = registry.get(cseId);
    if (!s) return;
    s.lastActivity = Date.now();
    mut(s);
  }

  // Authoritative cseId → PID resolution via CC's own per-PID manifest at
  // ~/.claude/sessions/<PID>.json (field `bridgeSessionId`). Zero ambiguity
  // even with N RC + M non-RC same-cwd `claude` procs — the file *is* CC
  // telling us the mapping. Falls back to "exactly one unmapped claude" via
  // libproc only if the manifest lookup misses (e.g. an older CC version
  // that doesn't write the field).
  function resolvePid(cseId: string): void {
    const info = registry.get(cseId);
    if (!info || info.pid != null) return;
    const fromManifest = lookupRcWorkerFromManifest(cseId);
    if (fromManifest) {
      info.pid = fromManifest.pid;
      info.cwd = fromManifest.cwd;
      log(`resolvePid ${cseId} → pid=${fromManifest.pid} cwd=${fromManifest.cwd} (manifest)`);
      return;
    }
    // Fallback: libproc singleton. Only assigns when there's exactly one
    // unmapped claude — refuses to guess in ambiguous cases.
    const cwds = findActiveProjectCwds();
    const candidates: { pid: number; cwd: string }[] = [];
    for (const [cwd, holders] of cwds) {
      for (const h of holders) {
        if (h.exe === "claude") candidates.push({ pid: h.pid, cwd });
      }
    }
    const mappedPids = new Set<number>();
    for (const v of registry.values()) if (v.pid != null) mappedPids.add(v.pid);
    const unmapped = candidates.filter((c) => !mappedPids.has(c.pid));
    if (unmapped.length !== 1) {
      logUnknown("rc_pid_unresolved", {
        cseId, manifestMiss: true, unmappedCount: unmapped.length, candidates: unmapped,
      });
      return;
    }
    const pick = unmapped[0];
    info.pid = pick.pid;
    info.cwd = pick.cwd;
    log(`resolvePid ${cseId} → pid=${pick.pid} cwd=${pick.cwd} (libproc-fallback)`);
  }

  return (e: RelayEvent) => {
    if (e.kind === "sse_close") {
      if (e.remainingClients === 0) {
        const t = setTimeout(() => {
          purgeTimers.delete(e.cseId);
          const info = registry.get(e.cseId);
          if (!info) return;
          log(`purging registry entry for ${e.cseId} after grace period`);
          registry.delete(e.cseId);
          announced.delete(info.sessionId);
          pub(info.sessionId, "status", { status: "ended" });
        }, PURGE_GRACE_MS);
        purgeTimers.set(e.cseId, t);
      }
      return;
    }
    if (e.kind === "sse_open") {
      // CC's worker just (re-)attached. Make sure the session shows in the
      // home card even if CC stays silent (e.g. blocked on a permission
      // across a Vakka restart).
      const pendingPurge = purgeTimers.get(e.cseId);
      if (pendingPurge) {
        clearTimeout(pendingPurge);
        purgeTimers.delete(e.cseId);
      }
      const sessionId = sessionIdFor(e.cseId);
      announce(sessionId, e.cseId);
      resolvePid(e.cseId);
      const pending = findPendingPermission(e.cseId);
      if (pending) {
        const req = pending.request;
        const tu = (req.tool_use_id ?? req.toolUseId) as string | undefined;
        if (tu && (resolvedToolUseIds.has(tu) || replayedToolUseIds.has(tu))) {
          return;
        }
        log(`replaying pending permission for ${e.cseId}`, { tool: req.tool_name, request_id: pending.request_id });
        if (tu && pending.request_id) requestIdByToolUseId.set(tu, pending.request_id);
        if (tu) replayedToolUseIds.add(tu);
        pub(sessionId, "permission", {
          toolUseId: req.tool_use_id ?? req.toolUseId,
          tool: req.tool_name ?? req.display_name ?? req.tool,
          input: req.input,
          description: req.description,
          permission_suggestions: req.permission_suggestions,
          blocked_path: req.blocked_path,
          request_id: pending.request_id,
          source: "rc-attached-replay",
        });
      }
      return;
    }
    if (e.kind === "worker_event") {
      const sessionId = sessionIdFor(e.cseId);
      announce(sessionId, e.cseId);
      // Manifest may not have been written by CC at sse_open time; retry now.
      if (registry.get(e.cseId)?.pid == null) resolvePid(e.cseId);
      const p = e.payload as Json;
      const ptype = p?.type as string | undefined;
      touchRegistry(e.cseId, (s) => {
        if (ptype === "result" && typeof (p as Json).total_cost_usd === "number") {
          s.cumulativeCostUsd = (p as Json).total_cost_usd as number;
        }
        if (ptype === "assistant") {
          const blocks = ((p as Json).message as Json | undefined)?.content as unknown[] | undefined;
          if (Array.isArray(blocks)) {
            const text = blocks
              .filter((b) => (b as Json)?.type === "text")
              .map((b) => (b as Json).text as string)
              .join(" ");
            // Skip CC's "Remote Control connecting…" attach banner — same
            // filter mapWorkerEvent applies before publishing to MQTT.
            if (text && !/^Remote Control connecting/i.test(text)) {
              s.lastAssistantPreview = text.slice(0, 140);
            }
          }
        }
      });
      mapWorkerEvent(sessionId, e.payload, pub, log);
    } else if (e.kind === "worker_put") {
      const sessionId = sessionIdFor(e.cseId);
      announce(sessionId, e.cseId);
      if (e.body.worker_status) {
        touchRegistry(e.cseId, (s) => { s.workerStatus = e.body.worker_status!; });
      }
      mapWorkerPut(sessionId, e.body, pub);
    } else if (e.kind === "sse_push") {
      // Intentionally noop: the worker_event "user" case in mapWorkerEvent
      // already publishes user input. Publishing here as well caused user
      // bubbles to render 2-3× per turn.
    }
  };
}

// ── Payload mappers ──────────────────────────────────────────────────────

type Pub = (sessionId: string, subtopic: keyof ReturnType<typeof topics>, payload: Json) => void;
type Log = (line: string, extra?: unknown) => void;

function mapWorkerEvent(sessionId: string, payload: unknown, pub: Pub, log: Log): void {
  const p = payload as Json;
  const type = p?.type as string | undefined;
  if (!type) return;

  switch (type) {
    case "assistant": {
      // Already SDK-shaped: `{type:"assistant", message:{role:"assistant", content:[...]}}`.
      // Drop synthetic frames — CC emits these for local TUI events that
      // never hit the model: RC-attach banner ("Remote Control connecting…"),
      // slash-dialog dismissals ("Skills dialog dismissed"), etc. They carry
      // model:"<synthetic>" + all-zero usage and are pure noise downstream.
      const msg = (p as Json).message as Json | undefined;
      if (msg && msg.model === "<synthetic>") return;
      // Replay suppression: when CC resumes a non-empty jsonl, it re-emits
      // every historical assistant turn through worker_events. Those replays
      // carry the original model name but all-zero usage (no model call
      // happened). Drop them — they pollute the chat with duplicated rows on
      // every reattach. Live turns always have non-zero output_tokens (or
      // at least one input/cache field set).
      const replayUsage = msg?.usage as Json | undefined;
      if (replayUsage) {
        const tokenSum =
          ((replayUsage.input_tokens as number | undefined) ?? 0) +
          ((replayUsage.output_tokens as number | undefined) ?? 0) +
          ((replayUsage.cache_creation_input_tokens as number | undefined) ?? 0) +
          ((replayUsage.cache_read_input_tokens as number | undefined) ?? 0);
        if (tokenSum === 0) {
          log(`replay assistant suppressed (zero usage) for ${sessionId}`);
          return;
        }
      }
      pub(sessionId, "output", p);
      // Derive context occupancy from the assistant envelope's `usage` block.
      // The three input-token fields partition the prompt; output is response,
      // not prompt, so it does not count toward context occupancy.
      const usage = msg?.usage as Json | undefined;
      const model = (msg?.model as string | undefined) ?? "";
      if (usage && model) {
        const inputTokens = (usage.input_tokens as number | undefined) ?? 0;
        const cacheCreate = (usage.cache_creation_input_tokens as number | undefined) ?? 0;
        const cacheRead = (usage.cache_read_input_tokens as number | undefined) ?? 0;
        const totalTokens = inputTokens + cacheCreate + cacheRead;
        // Opus/Sonnet 4.x: 1M; Haiku 4.x: 200k. Default to 1M.
        const maxTokens = /haiku/i.test(model) ? 200_000 : 1_000_000;
        const percentage = maxTokens > 0 ? (totalTokens / maxTokens) * 100 : 0;
        pub(sessionId, "context", {
          totalTokens,
          maxTokens,
          percentage,
          model,
          categories: [],
          mcpTools: [],
          agents: [],
        });
      }
      return;
    }
    case "result": {
      // Turn boundary + cost. SDK envelope publishes both `output` (for
      // mqtt-handler logging) and `cost`/`status` for sidebar.
      pub(sessionId, "output", p);
      const cost = (p as Json).total_cost_usd;
      if (typeof cost === "number") {
        pub(sessionId, "cost", { cumulative_cost_usd: cost });
      }
      // Don't emit status="completed" — RC sessions stay attached across turns.
      // worker_status PUT will drive the running/idle transitions.
      return;
    }
    case "user": {
      const message = (p as Json).message as Json | undefined;
      const content = message?.content;
      if (typeof content === "string") {
        // CC injects internal bookkeeping into the user content stream — these
        // are not user-typed text and shouldn't render as "YOU" bubbles. Drop
        // or transform per category:
        //   <system-reminder>          → drop (internal)
        //   <command-name>             → render as system notice "/cmd args"
        //   <local-command-stdout>     → drop (slash-command output we already render)
        //   <local-command-caveat>     → drop (boilerplate preamble)
        //   <bash-input>cmd</…>        → render as system notice "$ cmd"
        //   <bash-stdout>…</…>         → render as system notice (output)
        //   <bash-stderr>…</…>         → render as system notice (output)
        //   The "! cmd" shortcut produces the bash-* trio in three separate
        //   user frames; we render each as its own notice.
        const trimmed = content.trimStart();
        if (
          trimmed.startsWith("<system-reminder>") ||
          trimmed.startsWith("<local-command-stdout>") ||
          trimmed.startsWith("<local-command-caveat>")
        ) {
          return;
        }
        if (trimmed.startsWith("<command-name>")) {
          const name = trimmed.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim() ?? "";
          const args = trimmed.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? "";
          const text = args ? `${name} ${args}` : name;
          pub(sessionId, "output", {
            type: "system",
            subtype: "notice",
            message: { role: "user", content: text },
          });
          return;
        }
        const bashInput = trimmed.match(/^<bash-input>([\s\S]*?)<\/bash-input>/);
        if (bashInput) {
          pub(sessionId, "output", {
            type: "system",
            subtype: "notice",
            message: { role: "user", content: `$ ${bashInput[1]}` },
          });
          return;
        }
        const bashOut = trimmed.match(/^<bash-stdout>([\s\S]*?)<\/bash-stdout>(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?/);
        if (bashOut) {
          const out = (bashOut[1] ?? "").trim();
          const err = (bashOut[2] ?? "").trim();
          const text = err ? `${out}\n[stderr] ${err}`.trim() : out;
          // Opportunistic cwd capture: `! pwd` echoes the working directory.
          // This is authoritative — override any prior libproc-derived cwd,
          // since libproc matches by "leftover unmapped claude" which is wrong
          // when other claude processes are running outside our relay.
          const info = registry.get(sessionId);
          if (info && /^\/(?:Users|home|var|tmp|opt|private)\//.test(out) && !out.includes("\n")) {
            if (info.cwd !== out) {
              log(`cwd updated for ${sessionId} via ! pwd: ${info.cwd ?? "(none)"} → ${out}`);
              info.cwd = out;
            }
            // Also re-attribute the PID by matching this cwd in libproc.
            try {
              const cwds = findActiveProjectCwds();
              const match = cwds.get(out)?.find((h) => h.exe === "claude");
              if (match && info.pid !== match.pid) info.pid = match.pid;
            } catch { /* best effort */ }
          }
          pub(sessionId, "output", {
            type: "system",
            subtype: "notice",
            message: { role: "user", content: text || "(no output)" },
          });
          return;
        }
        // Typed user message. SDK-spawn echoes user input via `input`; do the same.
        // Dedup: worker_event arrives via both live SSE AND every NDJSON replay
        // on reconnect. Without this guard the same "what's 2+2?" gets stored
        // 2-3× into the messages table.
        if (dedupUserInput(sessionId, content)) return;
        // Replay window: when CC resumes a jsonl with prior history, the
        // worker re-emits every historical user turn within ~1s of attach.
        // Suppress user envelopes for the first 3s after the registry opened
        // UNLESS the controller (api.ts) already seeded dedupUserInput for
        // this exact text — that case is handled above. Trade-off: a user
        // typing into the TUI within 3s of attach would be silently dropped;
        // rare and recoverable by retyping.
        const sessionInfo = findRegistryBySessionId(sessionId);
        if (sessionInfo && Date.now() - sessionInfo.startedAt < 3000) {
          log(`replay user suppressed (within open window) for ${sessionId}: ${content.slice(0, 40)}`);
          return;
        }
        pub(sessionId, "input", { text: content, source: "rc-attached-user" });
        return;
      }
      if (Array.isArray(content)) {
        const hasToolResult = content.some((b) => (b as Json)?.type === "tool_result");
        if (hasToolResult) {
          // SDK-shaped tool_result envelope — mqtt-handler already understands this.
          pub(sessionId, "output", p);
          return;
        }
        // System notice (e.g. "[Request interrupted by user for tool use]").
        pub(sessionId, "output", { type: "system", subtype: "notice", message });
        return;
      }
      logUnknown("user_payload_shape", { sessionId, payload: p });
      return;
    }
    case "control_request": {
      // Permission card. subtype="can_use_tool" → SDK permission shape.
      // Wire shape: { type:"control_request", request_id, request:{subtype, tool_name, tool_use_id, input, description, permission_suggestions, ...}, session_id }
      const request = (p as Json).request as Json | undefined;
      if (request && (request.subtype as string) === "can_use_tool") {
        const tu = (request.tool_use_id ?? request.toolUseId) as string | undefined;
        const rid = (p as Json).request_id as string | undefined;
        if (tu && rid) requestIdByToolUseId.set(tu, rid);
        pub(sessionId, "permission", {
          toolUseId: request.tool_use_id ?? request.toolUseId,
          tool: request.tool_name ?? request.display_name ?? request.tool,
          input: request.input,
          description: request.description,
          permission_suggestions: request.permission_suggestions,
          blocked_path: request.blocked_path,
          request_id: (p as Json).request_id,
          source: "rc-attached",
        });
        return;
      }
      // Other control_request subtypes (e.g. question/ask, mcp_initialize) —
      // not yet mapped. Surface so we can wire them.
      logUnknown("control_request_subtype", {
        sessionId,
        subtype: request?.subtype,
        request,
        request_id: (p as Json).request_id,
      });
      pub(sessionId, "output", p);
      return;
    }
    case "control_response": {
      const response = (p as Json).response as Json | undefined;
      // doubly-nested: response.response.response.{behavior, updatedInput, ...}
      const inner = (response?.response as Json | undefined)?.response as Json | undefined;
      const tu = (response?.tool_use_id ?? response?.toolUseId) as string | undefined;
      if (tu) markToolUseResolved(tu);
      pub(sessionId, "permissionResponse", {
        toolUseId: response?.tool_use_id ?? response?.toolUseId,
        decision: inner?.behavior,
        updatedInput: inner?.updatedInput,
        updatedPermissions: inner?.updatedPermissions,
        message: inner?.message,
        source: "rc-attached",
      });
      return;
    }
    case "control_cancel_request": {
      // No-op for chat-view; cleanup signal only.
      return;
    }
    default:
      logUnknown("worker_event_type", { sessionId, type, payload: p });
  }
}

function mapWorkerPut(sessionId: string, body: { worker_status?: string; external_metadata?: unknown }, pub: Pub): void {
  if (body.worker_status) {
    // CC's enum → Vakka's status vocab.
    const status =
      body.worker_status === "WORKER_STATUS_RUNNING" || body.worker_status === "running" ? "running"
      : body.worker_status === "WORKER_STATUS_IDLE" || body.worker_status === "idle" ? "idle"
      : body.worker_status === "WORKER_STATUS_REQUIRES_ACTION" || body.worker_status === "requires_action" ? "requires_action"
      : "unknown";
    pub(sessionId, "status", { status, worker_status: body.worker_status });
  }
}
