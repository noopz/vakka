import type { Database } from "bun:sqlite";
import type { MqttClient } from "mqtt";
import { systemTopics } from "../shared/mqtt.js";
import { getActiveSessions, updateSessionStatus } from "../db/queries.js";
import { killAgent } from "./spawner.js";
import { logger } from "../shared/logger.js";

// Set ONLY by the MQTT restart_manager handler. Signals always preserve their
// kill-agents semantics; this flag is the only path to skip the kill loop.
let restarting = false;
// Guards against re-entrant shutdown() calls. Common case: SIGINT and SIGTERM
// arrive within ms when run.ts forwards Ctrl-C and the tty pgroup also fires.
// Without this, the second call hits a DB query after the first closed it.
let shuttingDown = false;

export function isRestarting(): boolean {
  return restarting;
}

export function setRestarting(v: boolean): void {
  restarting = v;
}

// Test-only: clear the re-entrance guard between cases. The flag is module-
// scoped so successive test cases would otherwise inherit it.
export function _resetShuttingDownForTests(): void {
  shuttingDown = false;
}

export interface ShutdownDeps {
  db: Database;
  mqttClient: MqttClient;
  healthCheckTimer?: ReturnType<typeof setInterval>;
}

export function shutdown(signal: string, deps: ShutdownDeps): void {
  logger.info("manager", `${signal} received (restarting=${restarting})`);

  if (shuttingDown) {
    logger.info("manager", `Ignoring duplicate ${signal} — shutdown already in progress`);
    return;
  }
  shuttingDown = true;

  if (!restarting) {
    // SIGTERM/SIGINT path → intentional shutdown. Always kill agents to avoid orphans.
    const active = getActiveSessions(deps.db);
    for (const session of active) {
      if (session.pid != null) {
        killAgent(session.pid);
        updateSessionStatus(deps.db, session.id, "completed");
      }
    }
    logger.info("manager", `Killed ${active.length} active agents on shutdown`);
  } else {
    const active = getActiveSessions(deps.db);
    logger.info("manager", `Hot-restart: preserving ${active.length} active agents`);
  }

  if (deps.healthCheckTimer) clearInterval(deps.healthCheckTimer);

  // Publish the "down" beacon and wait for the network to confirm before exiting.
  let exited = false;
  const finalExit = () => {
    if (exited) return;
    exited = true;
    try { deps.db.close(); } catch { /* already closed */ }
    deps.mqttClient.end(false, {}, () => process.exit(restarting ? 42 : 0));
  };

  deps.mqttClient.publish(
    systemTopics.managerOnline,
    JSON.stringify({ status: "down", graceful: true, restarting }),
    { retain: true },
    (err) => {
      if (err) logger.warn("manager", "down-beacon publish failed", err);
      finalExit();
    },
  );

  // Belt-and-suspenders: hard-exit after 1s if MQTT.end never calls back.
  setTimeout(() => process.exit(restarting ? 42 : 0), 1000).unref();
}
