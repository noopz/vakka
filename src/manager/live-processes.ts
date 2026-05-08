// live-processes — single source of truth for "which `claude` processes are
// alive on this machine, and what is each of them?".
//
// Background: liveness was previously computed in three independent pipelines
//   1. libproc scan → `external_live` boolean per project (no identity).
//   2. rc-attached registry → cseId-keyed RC sessions (no per-process scan).
//   3. jsonl mtime/livemark per ProjectSession.
// Each pipeline asked the same OS for an overlapping subset of facts and the
// frontend then had to dedup the results across pipelines. There is no clean
// dedup key across the three (libproc has no cseId, the registry has no PID
// at announce time, jsonl has neither directly), and every UI dedup attempt
// regressed something.
//
// New model: there is exactly one source of truth — `~/.claude/sessions/`.
// CC writes `<PID>.json` for every running CC and updates it as state changes.
// That set IS the set of live `claude` processes, and each manifest carries
// full identity (`pid`, `cwd`, `bridgeSessionId`?, `pluginPath` etc.). We read
// the directory once per request, drop dead PIDs, classify each surviving
// manifest, enrich RC rows from the rc-attached registry, return a flat list.
//
// Identity transitions are correctly handled: a `claude` started without
// `/remote-control` has no `bridgeSessionId` and reports `kind: "cc-cli"`. If
// the user runs `/remote-control` mid-session, CC rewrites the manifest with
// `bridgeSessionId` set; the next scan flips that PID to `kind: "rc"` without
// any other state changing. Same PID, classification reflects current truth.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getRcSession, getRcSessions } from "./rc-attached.js";

const CC_SESSIONS_DIR = join(homedir(), ".claude", "sessions");

export type LiveProcessKind = "rc" | "cc-cli";

export interface LiveProcess {
  pid: number;
  cwd: string;
  kind: LiveProcessKind;
  // SDK session id from CC's manifest (cc-cli only). Authoritative per-PID;
  // a cwd-based jsonl scan can't disambiguate sibling sessions.
  sdk_session_id?: string;
  // Manifest mtime — proxy for "last touched" when no other signal is fresher.
  manifest_mtime: string;
  // RC-only enrichment from the rc-attached registry. Present iff kind="rc"
  // AND we've seen sse_open for this cseId at least once.
  cseId?: string;
  // True when cseId came from a registry hit (sse_open observed). False when
  // cseId is the synthetic `cse_${bareTarget}` fallback derived from the
  // manifest alone. /api/live consumers should treat synthetic cseIds as
  // null on the wire (avoids phantom-id UI states).
  cseFromRegistry?: boolean;
  workerStatus?: string;
  cumulativeCostUsd?: number;
  lastActivity?: string;
  lastAssistantPreview?: string | null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listLiveProcesses(): LiveProcess[] {
  let entries: string[];
  try {
    entries = readdirSync(CC_SESSIONS_DIR);
  } catch {
    return [];
  }

  const out: LiveProcess[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(CC_SESSIONS_DIR, entry);
    let raw: string;
    let mtime: string;
    try {
      raw = readFileSync(path, "utf-8");
      mtime = statSync(path).mtime.toISOString();
    } catch {
      continue;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const pid = data.pid as number | undefined;
    const cwd = data.cwd as string | undefined;
    if (typeof pid !== "number" || typeof cwd !== "string") continue;
    if (!isAlive(pid)) continue;

    const bridgeSessionId = data.bridgeSessionId as string | undefined;
    if (bridgeSessionId) {
      // Match the rc-attached registry on the bare id (it stores cseId with
      // the `cse_` prefix; manifests carry `session_<bareId>` — same id).
      const bareTarget = bridgeSessionId.replace(/^(?:cse_|session_)/, "");
      const rc = getRcSessions().find(
        (r) => r.cseId.replace(/^cse_/, "") === bareTarget,
      );
      out.push({
        pid,
        cwd,
        kind: "rc",
        manifest_mtime: mtime,
        cseId: rc?.cseId ?? `cse_${bareTarget}`,
        cseFromRegistry: !!rc,
        workerStatus: rc?.workerStatus,
        cumulativeCostUsd: rc?.cumulativeCostUsd ?? 0,
        lastActivity: rc?.lastActivity
          ? new Date(rc.lastActivity).toISOString()
          : mtime,
        lastAssistantPreview: rc?.lastAssistantPreview ?? null,
      });
    } else {
      const sdkId = typeof data.sessionId === "string" ? data.sessionId : undefined;
      out.push({
        pid,
        cwd,
        kind: "cc-cli",
        sdk_session_id: sdkId,
        manifest_mtime: mtime,
      });
    }
  }
  return out;
}

// Re-export so callers don't need a second import.
export { getRcSession };
