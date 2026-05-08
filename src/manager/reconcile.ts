import type { Database } from "bun:sqlite";
import type { MqttClient } from "mqtt";
import {
  getActiveSessions,
  updateSessionStatus,
} from "../db/queries.js";
import { isProcessAlive, killAgent } from "./spawner.js";
import { extractSessionId, extractSubtopic, systemTopics } from "../shared/mqtt.js";
import { logger } from "../shared/logger.js";
import type { SessionRow } from "../shared/types.js";

export interface ReconcileResult {
  reaped: number;
  pending: SessionRow[];
}

/**
 * Walk every session marked active in the DB. If its recorded PID is dead (or
 * absent), reap it immediately. Sessions whose PID is alive go into `pending`
 * to be confirmed by `awaitHello` — an alive PID alone is not enough because
 * the OS may have recycled it.
 */
export function reconcileOnStartup(db: Database): ReconcileResult {
  const active = getActiveSessions(db);
  const pending: SessionRow[] = [];
  let reaped = 0;

  for (const session of active) {
    if (session.pid == null || !isProcessAlive(session.pid)) {
      updateSessionStatus(db, session.id, "failed");
      reaped++;
      logger.info(
        "reconcile",
        `Session ${session.id.slice(0, 8)}: PID ${session.pid ?? "null"} not alive — reaped`,
      );
    } else {
      pending.push(session);
    }
  }

  logger.info(
    "reconcile",
    `Initial sweep: ${reaped} reaped, ${pending.length} pending hello`,
  );

  return { reaped, pending };
}

/**
 * Confirms each pending session by listening for a hello whose pid AND
 * start_time_ms match what's stored. Republishes hello_request a few times to
 * handle wrapper MQTT reconnect lag, then reaps any survivors that didn't
 * respond — including sending SIGTERM to the (alive but unresponsive) PID
 * since an alive process that won't talk to us is an orphan.
 */
export function awaitHello(
  mqttClient: MqttClient,
  db: Database,
  pending: SessionRow[],
  timeoutMs = 5000,
): Promise<{ confirmed: string[]; reaped: string[] }> {
  if (pending.length === 0) {
    return Promise.resolve({ confirmed: [], reaped: [] });
  }

  const remaining = new Map(pending.map((s) => [s.id, s]));
  const confirmed: string[] = [];

  return new Promise((resolve) => {
    const onMessage = (topic: string, payload: Buffer) => {
      const sid = extractSessionId(topic);
      if (!sid || extractSubtopic(topic) !== "hello") return;
      const s = remaining.get(sid);
      if (!s) return;
      if (payload.length === 0) return; // cleared retained value, ignore

      let data: any;
      try { data = JSON.parse(payload.toString()); } catch { return; }

      // PID-reuse guard: pid AND start_time_ms must match. If we never had a
      // start_time_ms for this session (legacy row), accept the first hello.
      const pidMatch = data.pid === s.pid;
      const startMatch = s.start_time_ms == null || data.startTime === s.start_time_ms;

      if (!pidMatch || !startMatch) {
        logger.warn(
          "reconcile",
          `Session ${sid.slice(0, 8)}: hello mismatch (pid ${data.pid} vs ${s.pid}, start ${data.startTime} vs ${s.start_time_ms}) — likely PID reuse`,
        );
        updateSessionStatus(db, sid, "failed");
        // If the PID actually points to something live, kill it — leaving it
        // running while the DB row says "failed" creates a permanent orphan.
        if (s.pid != null && isProcessAlive(s.pid)) {
          killAgent(s.pid);
        }
        remaining.delete(sid);
        return;
      }

      confirmed.push(sid);
      remaining.delete(sid);
      logger.info("reconcile", `Session ${sid.slice(0, 8)}: hello confirmed (pid ${data.pid})`);
    };

    mqttClient.on("message", onMessage);

    // Republish hello_request 3 times to handle wrapper MQTT reconnect lag.
    let attempt = 0;
    const requestInterval = setInterval(() => {
      attempt++;
      mqttClient.publish(
        systemTopics.managerHelloRequest,
        JSON.stringify({ since: Date.now(), attempt }),
      );
      if (attempt >= 3) clearInterval(requestInterval);
    }, 1000);

    // Initial request fires immediately.
    mqttClient.publish(
      systemTopics.managerHelloRequest,
      JSON.stringify({ since: Date.now(), attempt: 0 }),
    );

    setTimeout(() => {
      clearInterval(requestInterval);
      mqttClient.off("message", onMessage);

      const reaped: string[] = [];
      for (const [sid, s] of remaining) {
        logger.warn(
          "reconcile",
          `Session ${sid.slice(0, 8)}: no hello within ${timeoutMs}ms — reaping`,
        );
        updateSessionStatus(db, sid, "failed");
        // Alive-but-unresponsive PIDs are orphans (broken MQTT, stuck
        // wrapper, PID reuse). Kill rather than leak.
        if (s.pid != null && isProcessAlive(s.pid)) {
          killAgent(s.pid);
        }
        reaped.push(sid);
      }

      resolve({ confirmed, reaped });
    }, timeoutMs);
  });
}
