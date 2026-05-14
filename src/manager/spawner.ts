import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync, openSync, writeSync } from "node:fs";
import { logger } from "../shared/logger.js";
import { getActiveSessions, updateSessionStatus } from "../db/queries.js";
import { RC_ATTACHED_PROJECT_PATH } from "../shared/types.js";

const VAKKA_ROOT = import.meta.dir.replace("/src/manager", "");

// Spawn a new agent process as a detached child
export function spawnAgent(config: {
  sessionId: string;
  projectPath: string;
  mqttHost: string;
  model: string;
  resumeSessionId?: string;
  forkSession?: boolean;
}): { pid: number } {
  const args = [
    "run", "src/agent/wrapper.ts",
    "--session-id", config.sessionId,
    "--project-path", config.projectPath,
    "--mqtt-host", config.mqttHost,
    "--model", config.model,
  ];
  if (config.resumeSessionId) {
    args.push("--resume-session-id", config.resumeSessionId);
  }
  if (config.forkSession) {
    args.push("--fork-session");
  }

  // Log agent stdout/stderr to per-session log files
  const logDir = join(VAKKA_ROOT, "logs", "agents");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${config.sessionId}.log`);
  const logFd = openSync(logPath, "w");

  const proc = Bun.spawn(["bun", ...args], {
    cwd: VAKKA_ROOT,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });

  // Detach so the child survives parent exit
  proc.unref();

  const pid = proc.pid;
  logger.info("spawner", `Spawned agent for session ${config.sessionId} with PID ${pid} (log: ${logPath})`);

  return { pid };
}

// Spawn `claude --remote-control` in a real pty (Bun 1.3.5+ native terminal API)
// with cc-preload.js wired in so worker traffic is rewritten to the local relay.
// We own the resulting PID; the existing rc-attached observer (rc-attached.ts)
// picks up the session via the manifest at ~/.claude/sessions/<pid>.json once
// CC dials /bridge.
//
// Trust-dialog dismissal is the caller's responsibility (see handleSpawn in
// manager/index.ts) — the spike showed a fixed-time send is fragile, so the
// caller drives input based on observing the pty output.
export function spawnRcClaude(config: {
  projectPath: string;
  logPath: string;
  resumeSessionId?: string;
  forkSession?: boolean;
}): {
  pid: number;
  exited: Promise<number>;
  writeInput: (s: string) => void;
} {
  const PRELOAD = join(VAKKA_ROOT, "src", "agent", "cc-preload.js");
  const logFd = openSync(config.logPath, "w");
  const args = [
    "claude", "--remote-control",
    ...(config.resumeSessionId ? ["--resume", config.resumeSessionId] : []),
    ...(config.forkSession ? ["--fork-session"] : []),
  ];
  const proc = Bun.spawn(
    args,
    {
      cwd: config.projectPath,
      env: {
        ...process.env,
        BUN_OPTIONS: `--preload ${PRELOAD}`,
        TERM: "xterm-256color",
      },
      terminal: {
        cols: 120,
        rows: 40,
        name: "xterm-256color",
        data(_t: unknown, chunk: Uint8Array | string) {
          try {
            const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            writeSync(logFd, s);
          } catch {
            // swallow — log fd may have closed
          }
        },
      },
    } as Parameters<typeof Bun.spawn>[1],
  );

  const pid = proc.pid;
  logger.info("spawner", `Spawned rc-claude PID ${pid} cwd=${config.projectPath} (log: ${config.logPath})`);

  return {
    pid,
    exited: proc.exited as Promise<number>,
    writeInput: (s: string) => {
      try { (proc as { terminal?: { write: (s: string) => void } }).terminal?.write(s); } catch {}
    },
  };
}

// Check if a process is still alive (signal 0 = existence check)
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Send SIGTERM to an agent process
export function killAgent(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    logger.info("spawner", `Sent SIGTERM to PID ${pid}`);
    return true;
  } catch {
    logger.warn("spawner", `Failed to kill PID ${pid} (already dead?)`);
    return false;
  }
}

// Health check: find sessions marked as running whose PIDs are dead, and mark them failed
export function healthCheck(db: Database): number {
  const activeSessions = getActiveSessions(db);
  let markedFailed = 0;

  for (const session of activeSessions) {
    // rc-attached sessions are owned by an external CC process; Vakka never
    // spawns them and has no PID to track. Skip — their liveness is the
    // relay SSE connection, not a local process.
    if (session.control_mode === 'rc-attached') continue;
    if (session.pid == null) {
      // No PID recorded — treat as dead
      logger.warn("spawner", `Session ${session.id} has no PID, marking as failed`);
      updateSessionStatus(db, session.id, "failed");
      markedFailed++;
      continue;
    }

    if (!isProcessAlive(session.pid)) {
      logger.warn("spawner", `Session ${session.id} PID ${session.pid} is dead, marking as failed`);
      updateSessionStatus(db, session.id, "failed");
      markedFailed++;
    }
  }

  if (markedFailed > 0) {
    logger.info("spawner", `Health check: marked ${markedFailed} dead session(s) as failed`);
  }
  if (activeSessions.length > 0) {
    const details = activeSessions
      .filter((s) => !markedFailed || isProcessAlive(s.pid ?? -1))
      .map((s) => {
        const name = s.project_path.split("/").pop();
        return `${name} (${s.id.slice(0, 8)}… PID ${s.pid})`;
      })
      .join(", ");
    logger.debug("spawner", `Health check: ${activeSessions.length - markedFailed} alive: ${details}`);
  } else {
    logger.debug("spawner", "Health check: no active sessions");
  }

  return markedFailed;
}
