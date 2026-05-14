import { Router } from "express";
import type { Database } from "bun:sqlite";
import type { MqttClient } from "mqtt";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { topics, commandTopics } from "../shared/mqtt.js";
import * as queries from "../db/queries.js";
import { logger } from "../shared/logger.js";
import { isManagerOnline, broadcastChatMessages } from "./websocket.js";
import { rowToNormalizedMessage } from "../manager/chat-message-projection.js";
import type { NormalizedMessage } from "../shared/message-types.js";
import { RC_ATTACHED_PROJECT_PATH } from "../shared/types.js";
import { listExternalCandidates } from "../manager/external-transcripts.js";
import { decodeTranscript } from "../manager/transcript-decoder.js";
import { listProjectSessions } from "../manager/session-listing.js";
import { projectKeyForCwd } from "../manager/project-key.js";
import { buildSlugMap } from "../manager/project-slug.js";
import { findActiveProjectCwds } from "../manager/libproc-liveness.js";
import { getRcSessions, getRcSession, getRequestIdForToolUse, markToolUseResolved, logUnknown, dedupUserInput } from "../manager/rc-attached.js";
import { listLiveProcesses } from "../manager/live-processes.js";
import { buildLiveView } from "../manager/live-view.js";
import type { CcRcRelay } from "../relay/cc-rc-relay.js";

// Weak ETag from a JSON-serializable value. Bun.hash is non-cryptographic
// and may change across Bun versions — fine for ETag (a Bun upgrade busts
// caches once, harmless). Number() cast handles `number | bigint` typing.
function weakEtag(value: unknown): string {
  return `W/"${Number(Bun.hash(JSON.stringify(value))).toString(36)}"`;
}

function persistAndBroadcastUserText(db: Database, sessionId: string, text: string): void {
  if (typeof text !== "string") return;
  const msg: NormalizedMessage = {
    kind: "user",
    id: `user-${Date.now()}`,
    text,
    timestamp: Date.now(),
  };
  const dbId = queries.insertChatMessage(db, msg, sessionId);
  queries.updateSessionActivity(db, sessionId);
  broadcastChatMessages(sessionId, [{ ...msg, id: String(dbId) }]);
}

function managerOfflineGuard(res: any): boolean {
  if (!isManagerOnline()) {
    res.status(503).json({ error: "manager restarting", retryAfterMs: 3000 });
    return true;
  }
  return false;
}

export function createApiRouter(db: Database, mqttClient: MqttClient, rcRelay?: CcRcRelay): Router {
  const router = Router();

  // ── Health ───────────────────────────────────────────────────────────

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // ── Projects ─────────────────────────────────────────────────────────

  router.get("/projects", (_req, res) => {
    try {
      const projects = queries.getProjects(db).filter(
        (p: any) => p.path !== RC_ATTACHED_PROJECT_PATH,
      );
      const slugMap = buildSlugMap(projects.map((p: any) => p.path));
      // Single libproc scan tells us which project cwds have a CC CLI process
      // attached right now. Folding this into /projects lets the sidebar paint
      // liveness on first render instead of flickering as N per-project
      // hydrations resolve one-at-a-time.
      //
      // We restrict the match to exe basename "claude" because the libproc
      // helper also surfaces node/bun for the richer session-listing path
      // (which conjoins with a fresh jsonl). Without this filter, an unrelated
      // bun/node dev server in the project dir would falsely flag the project
      // as live in the sidebar — Vakka-spawned sessions are already covered
      // by `sessions.value`, so claude-only is the right signal here.
      const liveCwds = findActiveProjectCwds();
      const augmented = projects.map((p: any) => ({
        ...p,
        display_slug: slugMap.get(p.path) ?? p.path,
        external_live: (liveCwds.get(p.path) ?? []).some(
          (h) => h.exe === "claude",
        ),
      }));
      res.json(augmented);
    } catch (err) {
      logger.error("api", "Failed to get projects", err);
      res.status(500).json({ error: "Failed to get projects" });
    }
  });

  router.get("/projects/by-slug/:slug", (req, res) => {
    try {
      const slug = req.params.slug;
      const projects = queries.getProjects(db);
      const slugMap = buildSlugMap(projects.map((p: any) => p.path));
      const match = projects.find((p: any) => slugMap.get(p.path) === slug);
      if (!match) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      res.json({ ...match, display_slug: slug });
    } catch (err) {
      logger.error("api", "Failed to resolve slug", err);
      res.status(500).json({ error: "Failed to resolve slug" });
    }
  });

  router.get("/projects/:path", (req, res) => {
    try {
      const projectPath = decodeURIComponent(req.params.path);
      const project = queries.getProject(db, projectPath);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      res.json(project);
    } catch (err) {
      logger.error("api", "Failed to get project", err);
      res.status(500).json({ error: "Failed to get project" });
    }
  });

  router.get("/projects/:path/resume-candidates", (req, res) => {
    try {
      const projectPath = decodeURIComponent(req.params.path);
      const limit = Math.min(Number(req.query.limit) || 10, 50);
      const candidates = queries.getResumeCandidates(db, projectPath, limit);
      res.json(candidates);
    } catch (err) {
      logger.error("api", "Failed to get resume candidates", err);
      res.status(500).json({ error: "Failed to get resume candidates" });
    }
  });

  router.get("/projects/:path/external-candidates", async (req, res) => {
    try {
      const projectPath = decodeURIComponent(req.params.path);
      const limit = Math.min(Number(req.query.limit) || 10, 50);
      const candidates = await listExternalCandidates(projectPath, { limit });

      // Enrich with DB-known sessions: if Vakka already owns a row whose
      // sdk_session_id matches a candidate's UUID, mark origin "vakka".
      const sdkIds = candidates.map((c) => c.sdk_session_id);
      const known = queries.getSessionsBySdkIds(db, sdkIds);
      const enriched = candidates.map((c) => {
        const row = known.get(c.sdk_session_id);
        return {
          ...c,
          origin: row ? ("vakka" as const) : ("external" as const),
          vakka_session_id: row?.id ?? null,
          cost_usd: row?.cost_usd ?? null,
          model: row?.model ?? null,
        };
      });
      res.json({ candidates: enriched });
    } catch (err) {
      logger.error("api", "Failed to get external candidates", err);
      res.status(500).json({ error: "Failed to get external candidates" });
    }
  });

  // Unified session listing — replaces resume-candidates + external-candidates.
  // Frontend cuts over in Phase 4; the older endpoints stay for now.
  router.get("/projects/:path/sessions", async (req, res) => {
    try {
      const projectPath = decodeURIComponent(req.params.path);
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const sessions = await listProjectSessions(db, projectPath, { limit });
      res.json({ sessions });
    } catch (err) {
      logger.error("api", "Failed to list project sessions", err);
      res.status(500).json({ error: "Failed to list project sessions" });
    }
  });

  router.post("/projects/:path/pin", (req, res) => {
    try {
      const projectPath = decodeURIComponent(req.params.path);
      const { pinned } = req.body as { pinned: boolean };
      queries.pinProject(db, projectPath, pinned);
      res.json({ ok: true });
    } catch (err) {
      logger.error("api", "Failed to pin project", err);
      res.status(500).json({ error: "Failed to pin project" });
    }
  });

  // Adopt a project — register a cwd discovered via a running CC process so
  // it shows up in the projects list. Idempotent (UPSERT). Disk untouched.
  router.post("/projects", (req, res) => {
    try {
      const { path: projectPath, name } = req.body as { path?: string; name?: string };
      if (!projectPath || typeof projectPath !== "string") {
        res.status(400).json({ error: "path is required" });
        return;
      }
      const finalName = (name && name.trim()) || projectPath.split("/").pop() || projectPath;
      queries.upsertProject(db, { path: projectPath, name: finalName });
      res.json({ ok: true, path: projectPath, name: finalName });
    } catch (err) {
      logger.error("api", "Failed to add project", err);
      res.status(500).json({ error: "Failed to add project" });
    }
  });

  // Hide a project from the listing — does not touch disk or session history.
  router.post("/projects/:path/hide", (req, res) => {
    try {
      const projectPath = decodeURIComponent(req.params.path);
      const { hidden } = req.body as { hidden: boolean };
      queries.setProjectHidden(db, projectPath, hidden);
      res.json({ ok: true });
    } catch (err) {
      logger.error("api", "Failed to hide project", err);
      res.status(500).json({ error: "Failed to hide project" });
    }
  });

  // ── Sessions ─────────────────────────────────────────────────────────

  router.get("/sessions", (_req, res) => {
    try {
      const sessions = queries.getAllSessions(db).filter(
        (s: any) => s.project_path !== RC_ATTACHED_PROJECT_PATH,
      );
      res.json(sessions);
    } catch (err) {
      logger.error("api", "Failed to get sessions", err);
      res.status(500).json({ error: "Failed to get sessions" });
    }
  });

  router.get("/sessions/active", (_req, res) => {
    try {
      const sessions = queries.getActiveSessions(db).filter(
        (s: any) => s.project_path !== RC_ATTACHED_PROJECT_PATH,
      );
      res.json(sessions);
    } catch (err) {
      logger.error("api", "Failed to get active sessions", err);
      res.status(500).json({ error: "Failed to get active sessions" });
    }
  });

  // RC-attached sessions: in-memory only, populated by the cc-rc-relay event
  // hook. Additive — does not touch the SDK-spawn or CC-live-snoop paths.
  router.get("/rc-sessions", (_req, res) => {
    try {
      res.json(getRcSessions());
    } catch (err) {
      logger.error("api", "Failed to get rc sessions", err);
      res.status(500).json({ error: "Failed to get rc sessions" });
    }
  });

  // Single source of truth for "live `claude` processes". Driven by
  // `~/.claude/sessions/<PID>.json` manifests, classified per-PID into
  // `rc` (manifest has bridgeSessionId) vs `cc-cli` (no bridge). Replaces the
  // ad-hoc dedup the home grid used to do across libproc + rc-registry +
  // jsonl-derived live flags. See src/manager/live-processes.ts.
  router.get("/live-processes", (_req, res) => {
    try {
      res.json(listLiveProcesses());
    } catch (err) {
      logger.error("api", "Failed to list live processes", err);
      res.status(500).json({ error: "Failed to list live processes" });
    }
  });

  // Unified live-view: server-side join of liveProcesses ⨝ activeSessions ⨝
  // external-jsonl, returning one flat LiveSessionView[]. Replaces four
  // independent frontend reconstructions of the same join. See
  // src/manager/live-view.ts and ~/.claude/plans/rippling-soaring-treehouse.md.
  router.get("/live", async (req, res) => {
    try {
      const liveProcesses = listLiveProcesses();
      const projectRows = queries.getProjects(db).filter(
        (p: any) => p.path !== RC_ATTACHED_PROJECT_PATH,
      );
      const slugMap = buildSlugMap(projectRows.map((p: any) => p.path));
      const projects = projectRows.map((p: any) => ({
        path: p.path,
        display_slug: slugMap.get(p.path) ?? p.name,
      }));
      const view = await buildLiveView({ db, liveProcesses, projects });
      const etag = weakEtag(view);
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }
      res.set("ETag", etag).json(view);
    } catch (err) {
      logger.error("api", "Failed to build live view", err);
      res.status(500).json({ error: "Failed to build live view" });
    }
  });

  router.get("/sessions/:id", (req, res) => {
    try {
      const session = queries.getSession(db, req.params.id);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      res.json(session);
    } catch (err) {
      logger.error("api", "Failed to get session", err);
      res.status(500).json({ error: "Failed to get session" });
    }
  });

  router.post("/sessions", (req, res) => {
    if (managerOfflineGuard(res)) return;
    const { projectPath, model, resumeFrom, resumeFromExternal, controlMode } = req.body as {
      projectPath: string;
      model?: string;
      resumeFrom?: string;
      resumeFromExternal?: string;
      controlMode?: "sdk-wrapper" | "rc-spawned";
    };
    if (!projectPath) {
      res.status(400).json({ error: "projectPath is required" });
      return;
    }
    if (resumeFrom && resumeFromExternal) {
      res.status(400).json({ error: "resumeFrom and resumeFromExternal are mutually exclusive" });
      return;
    }

    // If resuming, the SDK needs the prior wrapper's *SDK* session id (the
    // .jsonl filename stem) — not Vakka's session id. Resolve via DB and
    // enforce same-project (the SDK `cwd` must match).
    let resumeSessionId: string | undefined;
    let forkSession = false;
    let forkedFromSdkId: string | undefined;
    if (resumeFrom) {
      const prior = queries.getSession(db, resumeFrom);
      if (!prior) {
        res.status(400).json({ error: "resumeFrom: session not found" });
        return;
      }
      if (!prior.sdk_session_id) {
        res.status(400).json({ error: "resumeFrom: session has no SDK session id (pre-migration or never reached SDK init)" });
        return;
      }
      if (prior.project_path !== projectPath) {
        res.status(400).json({ error: "resumeFrom: project mismatch" });
        return;
      }
      resumeSessionId = prior.sdk_session_id;
    } else if (resumeFromExternal) {
      // External resume always forks: SDK creates a new jsonl with copied
      // history, leaving the source byte-identical (CC may still be writing).
      const projectKey = projectKeyForCwd(projectPath);
      const filePath = join(homedir(), ".claude", "projects", projectKey, `${resumeFromExternal}.jsonl`);
      if (!existsSync(filePath)) {
        res.status(400).json({ error: "resumeFromExternal: transcript not found" });
        return;
      }
      resumeSessionId = resumeFromExternal;
      forkSession = true;
      forkedFromSdkId = resumeFromExternal;
    }

    const commandId = crypto.randomUUID();
    const responseTopic = commandTopics.response;

    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      mqttClient.unsubscribe(responseTopic);
      mqttClient.removeListener("message", onMessage);
      res.status(504).json({ error: "Spawn command timed out" });
    }, 10_000);

    function onMessage(topic: string, payload: Buffer) {
      if (topic !== responseTopic) return;
      try {
        const data = JSON.parse(payload.toString());
        if (data.commandId !== commandId) return;
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        mqttClient.unsubscribe(responseTopic);
        mqttClient.removeListener("message", onMessage);
        res.json(data.session ?? data);
      } catch (err) {
        logger.error("api", "Failed to parse spawn response", err);
      }
    }

    mqttClient.subscribe(responseTopic, (err) => {
      if (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        logger.error("api", "Failed to subscribe to response topic", err);
        res.status(500).json({ error: "Failed to subscribe for spawn response" });
        return;
      }

      mqttClient.on("message", onMessage);

      mqttClient.publish(
        commandTopics.spawn,
        JSON.stringify({ commandId, projectPath, model, resumeSessionId, resumedFromVakkaId: resumeFrom, forkSession, forkedFromSdkId, ...(controlMode ? { controlMode } : {}) }),
      );

      logger.info("api", `Spawn command sent: ${commandId} for ${projectPath}`);
    });
  });

  router.post("/sessions/:id/kill", (req, res) => {
    if (managerOfflineGuard(res)) return;
    const commandId = crypto.randomUUID();
    mqttClient.publish(
      commandTopics.kill,
      JSON.stringify({ sessionId: req.params.id, commandId }),
    );
    logger.info("api", `Kill command sent for session ${req.params.id}`);
    res.json({ ok: true, commandId });
  });

  router.post("/sessions/:id/restart", (req, res) => {
    if (managerOfflineGuard(res)) return;
    const commandId = crypto.randomUUID();
    mqttClient.publish(
      commandTopics.restart,
      JSON.stringify({ sessionId: req.params.id, commandId }),
    );
    logger.info("api", `Restart command sent for session ${req.params.id}`);
    res.json({ ok: true, commandId });
  });

  router.post("/system/restart-manager", (_req, res) => {
    if (!mqttClient.connected) {
      res.status(503).json({ error: "broker disconnected" });
      return;
    }
    if (managerOfflineGuard(res)) return;
    const commandId = crypto.randomUUID();
    mqttClient.publish(
      commandTopics.restartManager,
      JSON.stringify({ commandId, requestedAt: Date.now(), source: "api" }),
    );
    logger.info("api", `Manager hot-restart requested (commandId=${commandId})`);
    res.json({ ok: true, commandId });
  });

  router.post("/sessions/:id/mode", (req, res) => {
    const { mode } = req.body as { mode: string };
    const sessionId = req.params.id;
    // SDK-wrapper transport: agent process subscribes and calls
    // activeQueryHandle.setPermissionMode(). See src/agent/wrapper.ts.
    mqttClient.publish(
      topics(sessionId).mode,
      JSON.stringify({ mode }),
    );

    // RC-attached transport: the SDK-wrapper subscriber doesn't run for these
    // sessions. Translate the mode change into a `set_permission_mode`
    // control_request SSE frame and push it to the CC worker. Wire shape
    // verified against ~/.vakka/rc-sse.ndjson:
    //   payload: { request: { mode, subtype: "set_permission_mode" },
    //              request_id, type: "control_request", uuid }
    // Mode mapping mirrors src/agent/wrapper.ts:312-318 — Vakka's UI labels
    // map onto SDK PermissionMode values that CC's worker understands.
    const rcInfo = getRcSession(sessionId);
    if (rcInfo && rcRelay) {
      const sdkMode =
        mode === "auto"
          ? "auto"
          : mode === "ask_always"
            ? "default"
            : mode;
      const requestId = `set-perm-mode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const uuid = crypto.randomUUID();
      rcRelay.pushFrame(rcInfo.cseId, {
        event: "client_event",
        data: {
          event_type: "control_request",
          source: "client",
          payload: {
            type: "control_request",
            request_id: requestId,
            request: { mode: sdkMode, subtype: "set_permission_mode" },
            uuid,
          },
        },
      });
      logger.info("api", `[${sessionId.slice(0, 8)}] rc-attached set_permission_mode: ${mode} → ${sdkMode}`);
    }

    logger.info("api", `Mode change sent for session ${sessionId}: ${mode}`);
    res.json({ ok: true });
  });

  // ── Context usage (request on-demand from agent via MQTT) ────────

  const pendingContextRequests = new Map<string, { res: any; timeout: NodeJS.Timeout }>();

  // Listen for context responses from agents
  mqttClient.subscribe("vakka/sessions/+/context");
  mqttClient.on("message", (topic, payload) => {
    const match = topic.match(/^vakka\/sessions\/([^/]+)\/context$/);
    if (!match) return;
    const sessionId = match[1];
    const pending = pendingContextRequests.get(sessionId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingContextRequests.delete(sessionId);
      try {
        pending.res.json(JSON.parse(payload.toString()));
      } catch {
        pending.res.status(500).json({ error: "Invalid context data" });
      }
    }
  });

  router.get("/sessions/:id/context", (req, res) => {
    const sessionId = req.params.id;
    // Request fresh context from agent by publishing to a request topic
    mqttClient.publish(`vakka/sessions/${sessionId}/context_request`, "{}");
    // Wait up to 5s for the agent to respond on the context topic
    const timeout = setTimeout(() => {
      pendingContextRequests.delete(sessionId);
      res.status(504).json({ error: "Context usage request timed out" });
    }, 5_000);
    pendingContextRequests.set(sessionId, { res, timeout });
  });

  // ── Transcript (lazy preview from jsonl on disk) ────────────────────
  // Reads the jsonl directly without spawning a wrapper. Used by the chat-
  // view "preview" mode (Phase 4a): clicking a session loads it into the
  // view at zero token cost; only sending a message commits to fork or
  // in-place resume.
  //
  // The :id is the SDK session id (jsonl filename stem). Caller must pass
  // ?projectPath=... so we can locate the file under the right projectKey
  // dir without scanning every project.

  router.get("/sessions/:id/transcript", (req, res) => {
    try {
      const sdkId = req.params.id;
      const projectPath = String(req.query.projectPath ?? "");
      if (!projectPath) {
        res.status(400).json({ error: "projectPath query param is required" });
        return;
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sdkId)) {
        res.status(400).json({ error: "invalid session id" });
        return;
      }
      // Pagination: `before` is the absolute record index that the client
      // already has as its oldest. We return up to `limit` records ending
      // just before it. Omitting `before` returns the tail (most recent N).
      // `total` is the full record count so the client knows when there's
      // nothing more to page.
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
      const beforeRaw = req.query.before;
      const before =
        beforeRaw != null && beforeRaw !== "" ? Number(beforeRaw) : null;

      const projectKey = projectKeyForCwd(projectPath);
      const filePath = join(homedir(), ".claude", "projects", projectKey, `${sdkId}.jsonl`);
      if (!existsSync(filePath)) {
        res.status(404).json({ error: "transcript not found" });
        return;
      }
      const text = readFileSync(filePath, "utf8");
      const allRecords: any[] = [];
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          allRecords.push(JSON.parse(line));
        } catch {
          // skip malformed
        }
      }
      const total = allRecords.length;
      const end = before != null && Number.isFinite(before)
        ? Math.max(0, Math.min(before, total))
        : total;
      const start = Math.max(0, end - limit);
      const records = allRecords.slice(start, end);
      // Decode server-side: the wire format is NormalizedMessage[], so the
      // frontend never has to re-implement SDK-shape parsing.
      const messages = decodeTranscript(records, sdkId);
      res.json({
        sdk_session_id: sdkId,
        file_path: filePath,
        messages,
        total,
        startIndex: start,
        endIndex: end,
      });
    } catch (err) {
      logger.error("api", "Failed to read transcript", err);
      res.status(500).json({ error: "Failed to read transcript" });
    }
  });

  // ── Messages ─────────────────────────────────────────────────────────

  router.get("/sessions/:id/messages/count", (req, res) => {
    try {
      const sessionId = req.params.id;
      const total = queries.getMessageCount(db, sessionId);
      res.json({ total });
    } catch (err) {
      logger.error("api", "Failed to count messages", err);
      res.status(500).json({ error: "Failed to count messages" });
    }
  });

  router.get("/sessions/:id/messages", (req, res) => {
    try {
      const sessionId = req.params.id;
      const before = req.query.before ? Number(req.query.before) : undefined;
      const after = req.query.after ? Number(req.query.after) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const includeHidden =
        req.query.includeHidden === "1" ||
        req.query.includeHidden === "true";

      const rows = queries.getChatMessages(db, sessionId, {
        before,
        after,
        limit: limit ?? (before != null || after != null ? 100 : 200),
        includeHidden,
      });
      const messages: NormalizedMessage[] = rows.map(rowToNormalizedMessage);
      res.json(messages);
    } catch (err) {
      logger.error("api", "Failed to get messages", err);
      res.status(500).json({ error: "Failed to get messages" });
    }
  });

  router.post("/sessions/:id/messages", (req, res) => {
    const { text, images } = req.body as { text: string; images?: { type: string; data: string }[] };
    const sessionId = req.params.id;

    // Resolve a delivery target BEFORE persisting. If nothing claims this
    // session id, returning 409 lets the frontend show "session not attached"
    // instead of silently storing a user message that never reaches CC. This
    // happens when a chat tab is pinned to a stale RC cseId (CC instance was
    // restarted) or to a wrapper session that has been reaped.
    const session = queries.getSession(db, sessionId);
    const live =
      session != null &&
      ["starting", "running", "waiting_permission", "waiting_input"].includes(session.status);
    const rcInfo = getRcSession(sessionId);
    const canAutoResume = !!(session && !live && session.sdk_session_id);
    const hasTarget = !!rcInfo || (session && live) || canAutoResume;
    if (!hasTarget) {
      logger.warn(
        "api",
        `[${sessionId.slice(0, 8)}] no delivery target — wrapper, RC, or resumable not found`,
      );
      res.status(409).json({ error: "session not attached", sessionId });
      return;
    }

    // Persist+broadcast only after we know a delivery path exists. The wrapper
    // does NOT echo input back from the SDK, so mqtt-handler skips the `input`
    // subtopic — this is the sole insertion site for user-typed messages.
    persistAndBroadcastUserText(db, sessionId, text);

    // Auto-resume: if the addressed Vakka session is no longer live (manager
    // restart, crash, terminal closed), revive it in place under the same id
    // by issuing a `resume` command. The wrapper spawns with --resume so the
    // SDK reattaches to the existing jsonl; the DB row keeps its id.
    if (canAutoResume && session) {
      if (managerOfflineGuard(res)) return;

      const commandId = crypto.randomUUID();
      const responseTopic = commandTopics.response;
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        mqttClient.unsubscribe(responseTopic);
        mqttClient.removeListener("message", onMessage);
        res.status(504).json({ error: "Auto-resume timed out" });
      }, 15_000);

      function onMessage(topic: string, payload: Buffer) {
        if (topic !== responseTopic) return;
        try {
          const data = JSON.parse(payload.toString());
          if (data.commandId !== commandId) return;
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          mqttClient.unsubscribe(responseTopic);
          mqttClient.removeListener("message", onMessage);
          if (!data.ok) {
            res.status(500).json({ error: data.error ?? "Auto-resume failed" });
            return;
          }
          // sdk-wrapper sessions resume in place under the same id. rc-spawned
          // sessions can't — CC mints a fresh cseId from its manifest, so the
          // manager replies with a different sessionId. data.sessionId tells
          // us which path ran.
          const resumedId: string = data.sessionId ?? sessionId;
          if (resumedId !== sessionId) {
            // rc-spawned resume: deliver the buffered input down the relay to
            // the new CC instance, then hand the new id back so the frontend
            // re-targets its chat tab.
            void (async () => {
              // The rc-attached observer registers the new cseId when it sees
              // the first worker frame. handleSpawnRcClaude already waited for
              // CC's manifest, so it's usually registered by now — poll briefly
              // to close the race.
              let rcInfo = getRcSession(resumedId);
              for (let i = 0; i < 20 && !rcInfo; i++) {
                await new Promise((r) => setTimeout(r, 100));
                rcInfo = getRcSession(resumedId);
              }
              if (rcInfo && rcRelay) {
                // Seed the dedup so CC's echo of this user turn doesn't
                // re-persist the row copyMessages already brought across.
                dedupUserInput(resumedId, text);
                rcRelay.pushFrame(rcInfo.cseId, {
                  event: "client_event",
                  data: {
                    event_type: "user",
                    source: "client",
                    payload: {
                      client_platform: "vakka",
                      message: { role: "user", content: text },
                      type: "user",
                      session_id: resumedId,
                    },
                  },
                });
                logger.info(
                  "api",
                  `[${sessionId.slice(0, 8)}] auto-resumed as rc-spawned ${resumedId.slice(0, 8)} — user: "${text.slice(0, 100)}"`,
                );
              } else {
                logger.warn(
                  "api",
                  `[${resumedId.slice(0, 8)}] rc-spawned resume is up but relay never registered it — first message not delivered`,
                );
              }
              res.json({ ok: true, sessionId: resumedId, resumed: true });
            })();
            return;
          }
          const t = topics(sessionId);
          mqttClient.publish(t.input, JSON.stringify({ text, images }));
          logger.info(
            "api",
            `[${sessionId.slice(0, 8)}] auto-resumed in place — user: "${text.slice(0, 100)}"`,
          );
          res.json({ ok: true, sessionId, resumed: true });
        } catch (err) {
          logger.error("api", "Failed to parse auto-resume response", err);
        }
      }

      mqttClient.subscribe(responseTopic, (err) => {
        if (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          res.status(500).json({ error: "Failed to subscribe for auto-resume response" });
          return;
        }
        mqttClient.on("message", onMessage);
        mqttClient.publish(
          commandTopics.resume,
          JSON.stringify({ commandId, sessionId }),
        );
        logger.info(
          "api",
          `Auto-resume (in-place) for dead session ${sessionId.slice(0, 8)} (sdk=${session.sdk_session_id?.slice(0, 8)})`,
        );
      });
      return;
    }

    // RC-attached sessions: route the user input down the SSE stream to CC
    // via the relay's pushFrame. CC's worker treats this as a controller-
    // initiated user turn. Echo to MQTT so the chat-view shows it immediately
    // (relay's onEvent also echoes via sse_push, so this is belt-and-braces).
    if (rcInfo && rcRelay) {
      // Seed the rc-attached dedup so when CC's worker echoes our user
      // turn back as a worker_event, rc-attached.ts:mapWorkerEvent suppresses
      // the redundant `input` publish. Without this, the user row gets
      // persisted twice: once by persistAndBroadcastUserText above and again
      // by the mqtt-handler `rc-attached-user` branch from the echo.
      dedupUserInput(sessionId, text);
      rcRelay.pushFrame(rcInfo.cseId, {
        event: "client_event",
        data: {
          event_type: "user",
          source: "client",
          payload: {
            client_platform: "vakka",
            message: { role: "user", content: text },
            type: "user",
            session_id: sessionId,
          },
        },
      });
      const t = topics(sessionId);
      mqttClient.publish(t.input, JSON.stringify({ text, images, source: "rc-attached" }));
      logger.info("api", `[${sessionId.slice(0, 8)}] rc-attached user: "${text.slice(0, 100)}"`);
      res.json({ ok: true, sessionId, rc: true });
      return;
    }

    const t = topics(sessionId);
    mqttClient.publish(t.input, JSON.stringify({ text, images }));
    logger.info("api", `[${sessionId.slice(0, 8)}] user: "${text.slice(0, 100)}"${images?.length ? ` (+${images.length} images)` : ""}`);
    res.json({ ok: true, sessionId });
  });

  // ── Permission & Question responses ──────────────────────────────────

  router.post("/sessions/:id/permission", (req, res) => {
    const { decision, tool, toolUseId, message, updatedInput, updatedPermissions } = req.body as {
      decision: string;
      tool: string;
      toolUseId?: string;
      message?: string;
      updatedInput?: unknown;
      updatedPermissions?: unknown;
    };
    const sessionId = req.params.id;
    const t = topics(sessionId);
    mqttClient.publish(
      t.permissionResponse,
      JSON.stringify({ decision, tool, toolUseId, message }),
    );

    // RC-attached: translate the permission response into a control_response
    // SSE frame back to CC's worker. Without this, CC stays blocked on the
    // tool_use indefinitely. Wire shape (verified against captured CC traffic
    // in ~/.vakka/rc-relay-events.ndjson):
    //   { type:"control_response", response:{ subtype:"success", request_id,
    //       response:{ behavior, updatedInput?, updatedPermissions?, message? }
    //     }, session_id }
    const rcInfo = getRcSession(sessionId);
    if (rcInfo && rcRelay) {
      const behavior =
        decision === "allow" ? "allow"
        : decision === "deny" ? "deny"
        : decision;
      // Surface untested decision vocab (e.g. "always_allow", "always_deny",
      // or deny-with-reason) so we know exactly what wire shape CC expects.
      if (decision !== "allow" && decision !== "deny") {
        logUnknown("permission_decision_vocab", {
          sessionId, cseId: rcInfo.cseId, decision, tool, toolUseId, message,
          updatedInput, updatedPermissions,
        });
      } else if (decision === "deny" && message) {
        logUnknown("permission_deny_with_reason", {
          sessionId, cseId: rcInfo.cseId, tool, toolUseId, message,
        });
      }
      const requestId = toolUseId ? getRequestIdForToolUse(toolUseId) : undefined;
      if (!requestId) {
        logger.warn("api", `[${sessionId.slice(0, 8)}] rc-attached: no request_id for toolUseId=${toolUseId} — CC will stay blocked`);
      }
      rcRelay.pushFrame(rcInfo.cseId, {
        event: "client_event",
        data: {
          event_type: "control_response",
          source: "client",
          payload: {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: requestId,
              response: {
                behavior,
                ...(updatedInput !== undefined ? { updatedInput } : {}),
                ...(updatedPermissions !== undefined ? { updatedPermissions } : {}),
                ...(message ? { message } : {}),
              },
            },
            session_id: rcInfo.cseId,
          },
        },
      });
      if (toolUseId) markToolUseResolved(toolUseId);
      logger.info("api", `[${sessionId.slice(0, 8)}] rc-attached permission: ${behavior} for ${tool} (request_id=${requestId?.slice(0, 8) ?? "missing"})`);
    } else {
      logger.info("api", `Permission response sent for session ${sessionId}: ${decision}`);
    }
    res.json({ ok: true });
  });

  router.post("/sessions/:id/plan-response", (req, res) => {
    const { approved, feedback, toolUseId } = req.body as {
      approved: boolean;
      feedback?: string;
      toolUseId: string;
    };
    const sessionId = req.params.id;
    if (typeof toolUseId !== "string" || !toolUseId) {
      res.status(400).json({ error: "toolUseId required" });
      return;
    }

    const status = approved ? "approved" : "rejected";
    const updatedId = queries.updateChatMessageStatus(
      db,
      sessionId,
      { toolUseId },
      { status, ...(typeof feedback === "string" ? { feedback } : {}) },
    );

    if (updatedId != null) {
      const rows = queries.getChatMessages(db, sessionId, {
        after: updatedId - 1,
        limit: 1,
        includeHidden: true,
      });
      const row = rows.find((r) => r.id === updatedId);
      if (row) broadcastChatMessages(sessionId, [rowToNormalizedMessage(row)]);
    }

    // Forward as a permission_response on MQTT so the manager can complete
    // the SDK's ExitPlanMode tool_use round-trip.
    const t = topics(sessionId);
    mqttClient.publish(
      t.permissionResponse,
      JSON.stringify({
        tool: "ExitPlanMode",
        toolUseId,
        decision: approved ? "allow" : "deny",
        message: feedback,
      }),
    );

    logger.info(
      "api",
      `[${sessionId.slice(0, 8)}] plan-response: ${status}${feedback ? ` (feedback ${feedback.length}c)` : ""}`,
    );
    res.json({ ok: true, updated: updatedId != null });
  });

  router.post("/sessions/:id/interrupt", (req, res) => {
    const sessionId = req.params.id;
    const t = topics(sessionId);
    mqttClient.publish(t.interrupt, JSON.stringify({ reason: "user" }));
    logger.info("api", `Interrupt sent for session ${sessionId}`);
    res.json({ ok: true });
  });

  router.post("/sessions/:id/question", (req, res) => {
    const { answer, questionId, toolUseId, questions, answersByQuestion, cancel } = req.body as {
      answer: string | string[];
      questionId?: string;
      toolUseId?: string;
      questions?: unknown[];
      answersByQuestion?: Record<string, string>;
      cancel?: boolean;
    };
    const sessionId = req.params.id;
    const t = topics(sessionId);
    mqttClient.publish(
      t.questionResponse,
      JSON.stringify({ answer: cancel ? "(cancelled)" : answer, questionId, toolUseId }),
    );

    // RC-attached: AskUserQuestion is delivered as a tool-permission control
    // request (subtype "can_use_tool", tool_name "AskUserQuestion"). The
    // response wire shape (verified against captured CC traffic) is a
    // control_response with behavior:"allow" and updatedInput echoing the
    // questions plus an `answers` map keyed by question text. Without this
    // CC stays blocked on the tool_use indefinitely.
    const rcInfoQ = getRcSession(sessionId);
    if (rcInfoQ && rcRelay && toolUseId) {
      const requestId = getRequestIdForToolUse(toolUseId);
      if (!requestId) {
        logger.warn("api", `[${sessionId.slice(0, 8)}] rc-attached question: no request_id for toolUseId=${toolUseId} — CC will stay blocked`);
      }
      const responseBody = cancel
        ? {
            behavior: "deny" as const,
            message: "User cancelled question — will respond via chat",
          }
        : {
            behavior: "allow" as const,
            updatedInput: {
              questions: questions ?? [],
              answers: answersByQuestion ?? {},
            },
            updatedPermissions: [],
          };
      rcRelay.pushFrame(rcInfoQ.cseId, {
        event: "client_event",
        data: {
          event_type: "control_response",
          source: "client",
          payload: {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: requestId,
              response: responseBody,
            },
            session_id: rcInfoQ.cseId,
          },
        },
      });
      markToolUseResolved(toolUseId);
      logger.info("api", `[${sessionId.slice(0, 8)}] rc-attached question: forwarded ${cancel ? "cancel" : "answer"} for ${toolUseId.slice(0, 12)} (request_id=${requestId?.slice(0, 8) ?? "missing"})`);
    } else if (rcInfoQ) {
      logUnknown("question_response_rc_attached_no_tool_use_id", {
        sessionId, cseId: rcInfoQ.cseId, answer, questionId, toolUseId,
      });
    }
    logger.info("api", `Question response sent for session ${sessionId}`);
    res.json({ ok: true });
  });

  // ── Filesystem browse ──────────────────────────────────────────────

  router.get("/fs/browse", (req, res) => {
    try {
      let target = (req.query.path as string) || homedir();
      if (target.startsWith("~/")) {
        target = resolve(homedir(), target.slice(2));
      }
      target = resolve(target);

      const entries = readdirSync(target, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

      // Show abbreviated path for display
      const home = homedir();
      const display = target.startsWith(home) ? "~" + target.slice(home.length) : target;

      res.json({ path: target, display, dirs });
    } catch (err: any) {
      res.status(400).json({ error: err.message || "Cannot read directory" });
    }
  });

  return router;
}
