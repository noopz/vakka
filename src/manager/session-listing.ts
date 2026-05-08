// Unified session listing — one mtime-sorted list per project, blending
// Vakka-spawned sessions and external CC-CLI sessions. The DB stops being
// authoritative; jsonls in ~/.claude/projects/<projectKey>/ are the source of
// truth, and the DB only contributes annotations (cost, model, lineage).
//
// Liveness derivation:
//   - Vakka-owned (DB row exists) + status in ('starting','running','waiting_*')
//     → live=true (manager state is authoritative).
//   - External + a CC/node/bun process has its cwd set to projectPath AND this
//     is the freshest jsonl in the project dir → live=true (libproc-liveness
//     spike Phase 0.5 v2; SDK uses open-write-close so per-FD checks don't
//     work, but cwd-level detection does).
//   - Otherwise live=false.
//
// SDK forkSession is supported on @anthropic-ai/claude-agent-sdk 0.2.114.

import type { Database } from "bun:sqlite";
import {
  listExternalCandidates,
  type PendingToolUse,
} from "./external-transcripts.js";
import { findActiveProjectCwds, type LiveHolder } from "./libproc-liveness.js";
import * as queries from "../db/queries.js";

export interface SessionListing {
  sdk_session_id: string;
  file_path: string;
  file_size: number;
  mtime: string;
  message_count: number | null;
  last_user_text: string | null;
  last_assistant_text: string | null;
  pending_tool_use: PendingToolUse | null;
  slug: string | null;

  // Origin / lineage
  origin: "vakka" | "external";
  vakka_session_id: string | null;
  forked_from_sdk_id: string | null;

  // Annotations (DB-derived; null when no Vakka row)
  cost_usd: number | null;
  model: string | null;
  status: string | null;

  // Liveness
  live: boolean;
  live_holder: (LiveHolder & { origin: "vakka" | "external-cli" }) | null;
  /** True when there's an unresolved tool_use in the tail AND the writer is
      live but the file has gone stale (>5s since last append) — strong
      heuristic for "blocked on permission/approval." For Vakka-owned rows we
      use the authoritative status from MQTT instead. */
  blocked: boolean;
}

export interface ListProjectSessionsOptions {
  limit?: number;
  maxAgeDays?: number;
  /** Override `Date.now()` for tests. */
  now?: number;
  /** Override `~/.claude/projects` for tests. */
  projectsRoot?: string;
}

export async function listProjectSessions(
  db: Database,
  projectPath: string,
  opts: ListProjectSessionsOptions = {},
): Promise<SessionListing[]> {
  const limit = opts.limit ?? 20;

  // Tail-parsed jsonl candidates (mtime-sorted, age-filtered, cwd-validated).
  const candidates = await listExternalCandidates(projectPath, {
    limit,
    maxAgeDays: opts.maxAgeDays,
    now: opts.now,
    projectsRoot: opts.projectsRoot,
  });
  if (candidates.length === 0) return [];

  // Left-join DB annotations.
  const sdkIds = candidates.map((c) => c.sdk_session_id);
  const known = queries.getSessionsBySdkIds(db, sdkIds);

  // Liveness map. Empty on win32 / FFI failure — callers treat absence as
  // "not live" rather than "unknown."
  const activeCwds = findActiveProjectCwds();
  const externalHolders = activeCwds.get(projectPath) ?? [];
  const externalLiveActive = externalHolders.length > 0;

  // The freshest external candidate is the one CC is currently writing (CC
  // writes one jsonl at a time per project). All older externals are idle.
  let assignedExternalLive = false;

  const now = opts.now ?? Date.now();

  return candidates.map((c, _i): SessionListing => {
    const row = known.get(c.sdk_session_id);
    const origin: "vakka" | "external" = row ? "vakka" : "external";

    let live = false;
    let liveHolder: SessionListing["live_holder"] = null;
    let blocked = false;

    if (row && isLiveStatus(row.status)) {
      live = true;
      liveHolder = row.pid
        ? { pid: row.pid, exe: "bun", origin: "vakka" }
        : { pid: 0, exe: "bun", origin: "vakka" };
      blocked =
        row.status === "waiting_permission" || row.status === "waiting_input";
    } else if (
      origin === "external" &&
      externalLiveActive &&
      !assignedExternalLive
    ) {
      // Bless the freshest *external* candidate as live (mtime-sorted, so
      // first external we hit is most recent). Two reasons we can't pin to
      // i===0:
      //   1. After a fork, the new Vakka session writes more often than the
      //      original CLI — Vakka jsonl ends up freshest, CLI's at i=1+.
      //   2. Concurrent CLI + Vakka in same project — same shape.
      //
      // No recency gate: CC's open-write-close pattern + sparse user input
      // means a genuinely-live CLI can sit at hours-stale mtime (e.g., user
      // ran `claude` in the morning, came back at night). If libproc says
      // there's a CC process at this cwd AND an external jsonl exists, the
      // freshest external is its jsonl, full stop. The "no external jsonl
      // yet" case (truly fresh CLI startup) falls through to project-home's
      // external_live hint instead.
      live = true;
      liveHolder = { ...externalHolders[0], origin: "external-cli" };
      assignedExternalLive = true;
      // pending tool_use + writer alive + mtime stale > 5s
      // → CC is sitting at a permission/approval prompt.
      const ageMs = now - new Date(c.mtime).getTime();
      blocked = c.pending_tool_use !== null && ageMs > 5000;
    }

    return {
      sdk_session_id: c.sdk_session_id,
      file_path: c.file_path,
      file_size: c.file_size,
      mtime: c.mtime,
      message_count: c.message_count,
      last_user_text: c.last_user_text,
      last_assistant_text: c.last_assistant_text,
      pending_tool_use: c.pending_tool_use,
      slug: c.slug,

      origin,
      vakka_session_id: row?.id ?? null,
      forked_from_sdk_id: row?.forked_from_sdk_id ?? null,

      cost_usd: row?.cost_usd ?? null,
      model: row?.model ?? null,
      status: row?.status ?? null,

      live,
      live_holder: liveHolder,
      blocked,
    };
  });
}

function isLiveStatus(status: string | null | undefined): boolean {
  return (
    status === "starting" ||
    status === "running" ||
    status === "waiting_permission" ||
    status === "waiting_input"
  );
}
