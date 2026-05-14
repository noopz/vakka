import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { MqttClient } from "mqtt";

import { getConfig } from "../shared/config.js";
import { createMQTTClient, commandTopics, systemTopics } from "../shared/mqtt.js";
import { logger } from "../shared/logger.js";
import { initDatabase } from "../db/schema.js";
import {
  createSession,
  getSession,
  getProject,
  upsertProject,
  updateSessionPid,
  updateSessionStatus,
  copyMessages,
} from "../db/queries.js";
import { spawnAgent, spawnRcClaude, killAgent, healthCheck } from "./spawner.js";
import { awaitManifestForPid } from "./rc-attached.js";
import { setupManagerMQTTHandler } from "./mqtt-handler.js";
import { shutdown, setRestarting } from "./shutdown.js";
import { reconcileOnStartup, awaitHello } from "./reconcile.js";
import { ensureAuthConfig, loadAuthConfig } from "../web/auth.js";
import {
  notifyPermissionRequest,
  notifyQuestion,
  notifyCompletion,
  notifyFailure,
} from "./notifications.js";

// ── Bootstrap ────────────────────────────────────────────────────────

const config = getConfig();

// 1. Initialize SQLite
const db = initDatabase(config.dbPath);
logger.info("manager", `Database initialized at ${config.dbPath}`);

// 2. Ensure auth.json exists with token + MQTT creds + pairingMode (idempotent;
//    no-op if already present). Then load so createMQTTClient sees the creds.
ensureAuthConfig();
loadAuthConfig();

// 3. Connect to MQTT — configure LWT so an ungraceful exit publishes a "down"
//    beacon automatically. The graceful shutdown path overwrites this with
//    {graceful: true} before exiting.
const mqttClient: MqttClient = createMQTTClient("manager", {
  will: {
    topic: systemTopics.managerOnline,
    payload: JSON.stringify({ status: "down", graceful: false }),
    qos: 0,
    retain: true,
  },
});

mqttClient.on("connect", () => {
  logger.info("manager", `Connected to MQTT broker at ${config.mqttHost}`);
});

mqttClient.on("error", (err) => {
  logger.error("manager", "MQTT connection error", err);
});

// 5. Periodic health check — mark dead sessions as failed, run every 30s.
//    Initial sweep is replaced by reconcileOnStartup below (gated on subs).
const healthCheckTimer = setInterval(() => healthCheck(db), 30_000);

// ── Command handling ─────────────────────────────────────────────────

function publishResponse(commandId: string, payload: Record<string, unknown>): void {
  mqttClient.publish(commandTopics.response, JSON.stringify({ commandId, ...payload }));
}

// Subscribe-before-publish ordering: the "up" beacon and the reconcile
// hello_request only fire after BOTH the command subs and the wildcard
// session subs (owned by setupManagerMQTTHandler, including the new `hello`)
// have been ACK'd. Otherwise a client could see manager_online: "up" before
// we're listening, and reconcile could miss helloes that arrive before our
// wildcard sub is live.
const commandSubs = [
  commandTopics.spawn,
  commandTopics.kill,
  commandTopics.restart,
  commandTopics.restartManager,
  commandTopics.resume,
];
let subsRemaining = 2;
const announceReady = () => {
  mqttClient.publish(
    systemTopics.managerOnline,
    JSON.stringify({ status: "up", pid: process.pid, startedAt: Date.now() }),
    { retain: true },
  );
  logger.info("manager", "Published manager_online: up");

  // Reconcile surviving agents now that we're confirmed listening.
  const { pending } = reconcileOnStartup(db);
  awaitHello(mqttClient, db, pending).catch((err) =>
    logger.error("manager", "awaitHello failed", err),
  );
};
const onSubscribed = (label: string) => (err: Error | null) => {
  if (err) {
    logger.error("manager", `Failed to subscribe to ${label}`, err);
    return;
  }
  logger.info("manager", `Subscribed to ${label}`);
  if (--subsRemaining === 0) announceReady();
};

// 4. Set up MQTT handler with notification callbacks (and use its ACK as one
//    of the gates for announceReady).
setupManagerMQTTHandler(
  mqttClient,
  db,
  {
    onPermissionRequest(sessionId, data) {
      const session = getSession(db, sessionId);
      const project = session ? getProject(db, session.project_path) : null;
      const projectName = project?.name ?? "unknown";
      notifyPermissionRequest(sessionId, projectName, data.tool ?? "unknown", data.description);
    },
    onQuestionRequest(sessionId, data) {
      const session = getSession(db, sessionId);
      const project = session ? getProject(db, session.project_path) : null;
      const projectName = project?.name ?? "unknown";
      notifyQuestion(sessionId, projectName, data.question ?? "");
    },
    onSessionComplete(sessionId, _data) {
      const session = getSession(db, sessionId);
      const project = session ? getProject(db, session.project_path) : null;
      const projectName = project?.name ?? "unknown";
      notifyCompletion(sessionId, projectName, session?.cost_usd ?? 0);
    },
    onSessionFailed(sessionId, data) {
      const session = getSession(db, sessionId);
      const project = session ? getProject(db, session.project_path) : null;
      const projectName = project?.name ?? "unknown";
      notifyFailure(sessionId, projectName, data.error);
    },
  },
  onSubscribed("session wildcard topics"),
);

mqttClient.subscribe(commandSubs, onSubscribed("command topics"));

// Reject commands that have been sitting in MQTT buffers for too long. Without
// this, a queued `restart_manager` could fire hours after the user clicked.
const STALE_COMMAND_MS = 30_000;

mqttClient.on("message", (topic, payload) => {
  // Only handle command topics here; session topics are handled by mqtt-handler
  if (!topic.startsWith("vakka/commands/")) return;
  // Ignore response topic echoes
  if (topic === commandTopics.response) return;

  let data: Record<string, any>;
  try {
    data = JSON.parse(payload.toString());
  } catch {
    logger.warn("manager", `Invalid JSON on ${topic}`);
    return;
  }

  if (typeof data.requestedAt === "number" && Date.now() - data.requestedAt > STALE_COMMAND_MS) {
    logger.warn("manager", `Ignoring stale command (${Date.now() - data.requestedAt}ms old) on ${topic}`);
    return;
  }

  const commandId: string = data.commandId ?? crypto.randomUUID();
  logger.info("manager", `Received command: ${topic.split("/").pop()}`, data);

  try {
    if (topic === commandTopics.spawn) {
      handleSpawn(commandId, data);
    } else if (topic === commandTopics.kill) {
      handleKill(commandId, data);
    } else if (topic === commandTopics.restart) {
      handleRestart(commandId, data);
    } else if (topic === commandTopics.restartManager) {
      handleRestartManager(commandId, data);
    } else if (topic === commandTopics.resume) {
      handleResume(commandId, data);
    }
  } catch (err: any) {
    logger.error("manager", `Error handling command on ${topic}`, err);
    publishResponse(commandId, { ok: false, error: err.message ?? String(err) });
  }
});

function handleSpawn(commandId: string, data: Record<string, any>): void {
  const projectPath: string = data.projectPath;
  const model: string = data.model ?? "opus";
  const resumeSessionId: string | undefined = data.resumeSessionId;
  const resumedFromVakkaId: string | undefined = data.resumedFromVakkaId;
  const forkSession: boolean = data.forkSession === true;
  const forkedFromSdkId: string | undefined = data.forkedFromSdkId;

  if (!projectPath) {
    publishResponse(commandId, { ok: false, error: "Missing projectPath" });
    return;
  }

  // Resolve ~ to home directory
  let resolvedPath = projectPath.startsWith("~/")
    ? resolve(homedir(), projectPath.slice(2))
    : projectPath;

  // Auto-create project if directory exists but isn't in DB yet
  const project = getProject(db, resolvedPath);
  if (!project) {
    // Check the directory actually exists on disk
    if (!existsSync(resolvedPath)) {
      publishResponse(commandId, { ok: false, error: `Directory not found: ${resolvedPath}` });
      return;
    }
    const name = resolvedPath.split("/").pop() || resolvedPath;
    upsertProject(db, { path: resolvedPath, name });
    logger.info("manager", `Auto-created project entry for ${resolvedPath}`);
  }

  const controlMode: string = data.controlMode ?? "sdk-wrapper";

  if (controlMode === "rc-spawned") {
    handleSpawnRcClaude(commandId, resolvedPath, model, data).catch((err) => {
      logger.error("manager", `rc-spawned spawn failed`, err);
      publishResponse(commandId, { ok: false, error: err?.message ?? String(err) });
    });
    return;
  }

  const sessionId = crypto.randomUUID();
  const _session = createSession(db, {
    id: sessionId,
    project_path: resolvedPath,
    model,
    forked_from_sdk_id: forkedFromSdkId,
  });

  // For resumed sessions, copy the prior conversation's messages so the chat
  // view has display continuity. The SDK has the real transcript via `resume:`;
  // these rows are pure UI state.
  if (resumedFromVakkaId) {
    try {
      const copied = copyMessages(db, resumedFromVakkaId, sessionId);
      logger.info("manager", `Copied ${copied} messages from ${resumedFromVakkaId.slice(0, 8)} → ${sessionId.slice(0, 8)}`);
    } catch (err) {
      logger.warn("manager", `Failed to copy messages from ${resumedFromVakkaId}`, err);
    }
  }

  const { pid } = spawnAgent({
    sessionId,
    projectPath: resolvedPath,
    mqttHost: config.mqttHost,
    model,
    resumeSessionId,
    forkSession,
  });

  updateSessionPid(db, sessionId, pid);

  // Don't publish the spawn response until the wrapper has actually subscribed
  // to its MQTT topics — otherwise the API caller's followup `sendMessage`
  // (input topic, QoS 0) races the wrapper's subscription and gets dropped,
  // leaving the SDK awaiting input that never arrives. The wrapper publishes
  // hello (retain=true) *after* subscribe completes; that's our ready signal.
  awaitWrapperReady(sessionId, pid)
    .then(() => {
      publishResponse(commandId, { ok: true, sessionId, pid });
      logger.info("manager", `Spawned session ${sessionId} for ${resolvedPath} (PID ${pid})`);
    })
    .catch((err) => {
      logger.error("manager", `Wrapper ready timeout for ${sessionId}`, err);
      publishResponse(commandId, { ok: false, error: "Wrapper failed to come online" });
    });
}

// VAKKA_ROOT for the rc-spawned log path (mirrors the derivation in spawner.ts
// so we don't have to plumb a constant across modules). import.meta.dir is
// `<vakka>/src/manager` at runtime.
const VAKKA_ROOT = import.meta.dir.replace("/src/manager", "");

// rc-spawned end-to-end flow: spawn CC in a pty, optionally dismiss the trust
// dialog, poll for the manifest CC writes once it dials the bridge, then INSERT
// the session row keyed by the cseId the relay observed. The existing
// rc-attached observer's announce() will SELECT and skip its own INSERT
// thanks to commit 5, so the project_path we store here wins.
async function handleSpawnRcClaude(
  commandId: string,
  projectPath: string,
  model: string,
  data: Record<string, any>,
): Promise<void> {
  const resumeSessionId: string | undefined = data.resumeSessionId;
  const forkSession: boolean = data.forkSession === true;
  const resumedFromVakkaId: string | undefined = data.resumedFromVakkaId;
  const forkedFromSdkId: string | undefined = data.forkedFromSdkId;

  // Trust-dialog pre-check (read-only). If ~/.claude.json already records
  // hasTrustDialogAccepted=true for this directory, skip the dismissal step;
  // otherwise we'll watch the pty log for the dialog marker post-spawn.
  const trustAccepted = checkTrustAccepted(projectPath);

  const logDir = join(VAKKA_ROOT, "logs", "agents");
  mkdirSync(logDir, { recursive: true });
  const startTimeMs = Date.now();
  const logPath = join(logDir, `rc-${startTimeMs}.log`);

  const { pid, exited, writeInput } = spawnRcClaude({ projectPath, logPath, resumeSessionId, forkSession });
  logger.info(
    "manager",
    `Spawned rc-claude PID ${pid} for ${projectPath} (log: ${logPath})`,
  );

  if (!trustAccepted) {
    void dismissTrustDialog(logPath, writeInput);
  }

  const result = await awaitManifestForPid(pid, exited, 10_000);
  if ("error" in result) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    publishResponse(commandId, { ok: false, error: `rc-spawned failed: ${result.error}` });
    return;
  }

  const { cseId, sdkSessionId } = result;

  // Upsert the session row now that we know the cseId. Both rc-attached's
  // announce() and this handler race to write the row — whichever arrives
  // first wins INSERT, the loser must UPDATE. Commit 5 guards the
  // observer-loses direction (SELECT-then-skip); this ON CONFLICT clause
  // guards the observer-wins direction (overwrite the `<rc-attached>`
  // sentinel with the real path/mode/pid). The WHERE guard ensures we
  // only ever rewrite the sentinel — a non-sentinel project_path means
  // some other flow owns this row and we must not stomp it.
  db.query(
    `INSERT INTO sessions (id, project_path, model, pid, control_mode, start_time_ms, sdk_session_id, forked_from_sdk_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET
       project_path = excluded.project_path,
       model = excluded.model,
       pid = excluded.pid,
       control_mode = excluded.control_mode,
       start_time_ms = excluded.start_time_ms,
       sdk_session_id = excluded.sdk_session_id,
       forked_from_sdk_id = excluded.forked_from_sdk_id
     WHERE sessions.project_path = '<rc-attached>'`,
  ).run(cseId, projectPath, model, pid, "rc-spawned", startTimeMs, sdkSessionId, forkedFromSdkId ?? null);

  // For resumed sessions, copy the prior conversation's messages so the chat
  // view has display continuity. CC has the real transcript via resume/fork;
  // these rows are pure UI state.
  if (resumedFromVakkaId) {
    try {
      const copied = copyMessages(db, resumedFromVakkaId, cseId);
      logger.info("manager", `Copied ${copied} messages from ${resumedFromVakkaId.slice(0, 8)} → ${cseId.slice(0, 8)}`);
    } catch (err) {
      logger.warn("manager", `Failed to copy messages from ${resumedFromVakkaId}`, err);
    }
  }

  publishResponse(commandId, { ok: true, sessionId: cseId, pid });
  logger.info(
    "manager",
    `rc-spawned session ${cseId} for ${projectPath} (PID ${pid})`,
  );
}

function checkTrustAccepted(projectPath: string): boolean {
  try {
    const raw = readFileSync(join(homedir(), ".claude.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const projects = parsed.projects as
      | Record<string, Record<string, unknown>>
      | undefined;
    return projects?.[projectPath]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
}

// Poll the pty log for the trust-dialog marker; on hit, send "1\r" to dismiss.
// If the marker doesn't appear within 4s, send "1\r" blind — harmless if the
// dialog wasn't actually present (just an extra char at the REPL prompt).
async function dismissTrustDialog(
  logPath: string,
  writeInput: (s: string) => void,
): Promise<void> {
  const TRIGGER = "Quick safety check";
  const start = Date.now();
  while (Date.now() - start < 4000) {
    try {
      const txt = readFileSync(logPath, "utf-8");
      if (txt.includes(TRIGGER)) {
        writeInput("1\r");
        return;
      }
    } catch {
      // log may not exist yet; keep polling
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  writeInput("1\r");
}

// Wait up to 5s for the wrapper to publish its hello on
// vakka/sessions/<id>/hello with a matching pid. Hello is published after the
// wrapper has subscribed to its session topics, so receipt = "safe to publish
// input." We're already subscribed to the wildcard hello topic via
// setupManagerMQTTHandler, so we just attach a one-shot filter.
function awaitWrapperReady(
  sessionId: string,
  expectedPid: number,
  timeoutMs = 5000,
): Promise<void> {
  const helloTopic = `vakka/sessions/${sessionId}/hello`;
  return new Promise((resolve, reject) => {
    const onMessage = (topic: string, payload: Buffer) => {
      if (topic !== helloTopic) return;
      if (payload.length === 0) return; // cleared retained value
      try {
        const data = JSON.parse(payload.toString());
        if (data.pid !== expectedPid) return;
      } catch {
        return;
      }
      mqttClient.off("message", onMessage);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      mqttClient.off("message", onMessage);
      reject(new Error(`Hello not received within ${timeoutMs}ms`));
    }, timeoutMs);
    mqttClient.on("message", onMessage);
  });
}

// In-place resume: revive a non-live Vakka session under its existing id by
// spawning a fresh wrapper with `--resume <sdk_session_id>`. The DB row keeps
// the same Vakka id (no message copy, no new row); the wrapper's hello updates
// pid/start_time_ms via the standard handler.
function handleResume(commandId: string, data: Record<string, any>): void {
  const sessionId: string = data.sessionId;
  if (!sessionId) {
    publishResponse(commandId, { ok: false, error: "Missing sessionId" });
    return;
  }

  const session = getSession(db, sessionId);
  if (!session) {
    publishResponse(commandId, { ok: false, error: `Session not found: ${sessionId}` });
    return;
  }

  if (!session.sdk_session_id) {
    publishResponse(commandId, { ok: false, error: "Session has no sdk_session_id to resume from" });
    return;
  }

  const liveStatuses = ["starting", "running", "waiting_permission", "waiting_input"];
  if (liveStatuses.includes(session.status)) {
    publishResponse(commandId, { ok: true, sessionId, alreadyLive: true });
    return;
  }

  updateSessionStatus(db, sessionId, "starting");

  const { pid } = spawnAgent({
    sessionId,
    projectPath: session.project_path,
    mqttHost: config.mqttHost,
    model: session.model,
    resumeSessionId: session.sdk_session_id,
  });

  updateSessionPid(db, sessionId, pid);

  awaitWrapperReady(sessionId, pid)
    .then(() => {
      publishResponse(commandId, { ok: true, sessionId, pid });
      logger.info("manager", `Resumed session ${sessionId} in-place (PID ${pid}, sdk=${session.sdk_session_id?.slice(0, 8)})`);
    })
    .catch((err) => {
      logger.error("manager", `Wrapper ready timeout for in-place resume of ${sessionId}`, err);
      updateSessionStatus(db, sessionId, "failed");
      publishResponse(commandId, { ok: false, error: "Wrapper failed to come online" });
    });
}

function handleKill(commandId: string, data: Record<string, any>): void {
  const sessionId: string = data.sessionId;
  if (!sessionId) {
    publishResponse(commandId, { ok: false, error: "Missing sessionId" });
    return;
  }

  const session = getSession(db, sessionId);
  if (!session) {
    publishResponse(commandId, { ok: false, error: `Session not found: ${sessionId}` });
    return;
  }

  if (session.pid != null) {
    killAgent(session.pid);
  }
  updateSessionStatus(db, sessionId, "completed");

  publishResponse(commandId, { ok: true, sessionId });
  logger.info("manager", `Killed session ${sessionId}`);
}

function handleRestart(commandId: string, data: Record<string, any>): void {
  const sessionId: string = data.sessionId;
  if (!sessionId) {
    publishResponse(commandId, { ok: false, error: "Missing sessionId" });
    return;
  }

  const session = getSession(db, sessionId);
  if (!session) {
    publishResponse(commandId, { ok: false, error: `Session not found: ${sessionId}` });
    return;
  }

  // Kill existing process
  if (session.pid != null) {
    killAgent(session.pid);
  }
  updateSessionStatus(db, sessionId, "completed");

  // Spawn a new session with the same project
  const newSessionId = crypto.randomUUID();
  const model = data.model ?? session.model;

  createSession(db, {
    id: newSessionId,
    project_path: session.project_path,
    model,
  });

  const { pid } = spawnAgent({
    sessionId: newSessionId,
    projectPath: session.project_path,
    mqttHost: config.mqttHost,
    model,
  });

  updateSessionPid(db, newSessionId, pid);

  // Same race as handleSpawn/handleResume: don't publish until wrapper hello.
  awaitWrapperReady(newSessionId, pid)
    .then(() => {
      publishResponse(commandId, { ok: true, oldSessionId: sessionId, sessionId: newSessionId, pid });
      logger.info("manager", `Restarted session ${sessionId} -> ${newSessionId} (PID ${pid})`);
    })
    .catch((err) => {
      logger.error("manager", `Wrapper ready timeout for restart ${newSessionId}`, err);
      publishResponse(commandId, { ok: false, error: "Wrapper failed to come online" });
    });
}

function handleRestartManager(commandId: string, _data: Record<string, any>): void {
  // The ONLY path that preserves agents on shutdown. SIGTERM/SIGINT always
  // kill agents; this MQTT command is the explicit hot-restart channel.
  setRestarting(true);
  logger.info("manager", "restart_manager command received — beginning hot restart");
  let dispatched = false;
  const begin = () => {
    if (dispatched) return;
    dispatched = true;
    shutdown("RESTART", { db, mqttClient, healthCheckTimer });
  };
  mqttClient.publish(
    commandTopics.response,
    JSON.stringify({ commandId, ok: true, accepted: true }),
    {},
    () => begin(),
  );
  // Defensive: shut down anyway if the publish callback never fires.
  setTimeout(begin, 500).unref();
}

// ── Graceful shutdown ────────────────────────────────────────────────

const shutdownDeps = { db, mqttClient, healthCheckTimer };

process.on("SIGTERM", () => shutdown("SIGTERM", shutdownDeps));
process.on("SIGINT", () => shutdown("SIGINT", shutdownDeps));

logger.info("manager", "Agent manager started");
