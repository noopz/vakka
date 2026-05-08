// live-view — server-side join builder for GET /api/live.
//
// Replaces four separate frontend reconstructions of:
//   liveProcesses ⨝ activeSessions ⨝ external-jsonl
// with one authoritative LiveSessionView[] feed.
//
// v1 invariant (strict): origin === "vakka" ⇔ transport === "wrapper".
// CC manifests carry the `claude` child PID, not the Vakka wrapper Bun PID,
// so a pid-join cannot detect RC-on-Vakka. All RC rows emit origin:"external".
//
// See ~/.claude/plans/rippling-soaring-treehouse.md.

import { statSync } from "node:fs";
import { basename } from "node:path";
import type { Database } from "bun:sqlite";
import { RC_ATTACHED_PROJECT_PATH } from "../shared/types.js";
import type { LiveProcess } from "./live-processes.js";
import type { LiveSessionView, LiveStatusVerb, SessionRow, SessionStatus } from "../shared/types.js";
import { getActiveSessions } from "../db/queries.js";
import { listExternalCandidates, type ListOptions } from "./external-transcripts.js";
import { projectKeyForCwd } from "./project-key.js";

export interface ProjectLite {
  path: string;
  display_slug: string;
}

export interface BuildLiveViewArgs {
  db: Database;
  liveProcesses: LiveProcess[];
  projects: ProjectLite[];
  now?: number;
  /** Override `~/.claude/projects` for testing. Forwarded to listExternalCandidates. */
  projectsRoot?: string;
  /** Test seam: lets tests count how often the resolver is called. */
  resolveSdkId?: (cwd: string) => Promise<string | null>;
}

// Module-level resolution cache — keyed by cwd. Invalidates on dir mtime
// change; negative results (missing dir) cached briefly to dedupe poll bursts.
interface CacheEntry {
  sdk_session_id: string | null;
  dirMtimeMs: number;
  /** -1 means dir didn't exist at observation time. */
  cachedAt: number;
}
const NEGATIVE_TTL_MS = 2_000;
const sdkIdCache = new Map<string, CacheEntry>();

export function _clearLiveViewCache(): void {
  sdkIdCache.clear();
}

async function defaultResolveSdkId(
  cwd: string,
  projectsRoot: string | undefined,
  now: number,
): Promise<string | null> {
  // Two-level cache: a dir-mtime check is the cheap invalidation signal; a
  // miss falls through to a full listExternalCandidates scan.
  const opts: ListOptions = { limit: 1 };
  if (projectsRoot) opts.projectsRoot = projectsRoot;

  const projectsDir = projectsRoot ?? joinHome(".claude/projects");
  const dir = `${projectsDir}/${projectKeyForCwd(cwd)}`;

  let dirMtimeMs: number;
  let dirExists: boolean;
  try {
    dirMtimeMs = statSync(dir).mtimeMs;
    dirExists = true;
  } catch {
    dirMtimeMs = -1;
    dirExists = false;
  }

  const cached = sdkIdCache.get(cwd);
  if (cached) {
    if (dirExists && cached.dirMtimeMs === dirMtimeMs) {
      return cached.sdk_session_id;
    }
    if (!dirExists && cached.dirMtimeMs === -1 && now - cached.cachedAt < NEGATIVE_TTL_MS) {
      return cached.sdk_session_id;
    }
  }

  if (!dirExists) {
    sdkIdCache.set(cwd, { sdk_session_id: null, dirMtimeMs: -1, cachedAt: now });
    return null;
  }

  const candidates = await listExternalCandidates(cwd, opts);
  const sdkId = candidates[0]?.sdk_session_id ?? null;
  sdkIdCache.set(cwd, { sdk_session_id: sdkId, dirMtimeMs, cachedAt: now });
  return sdkId;
}

function joinHome(rel: string): string {
  // Avoid pulling node:os into the hot path; only used as a fallback display.
  const home = process.env.HOME ?? "";
  return `${home}/${rel}`;
}

function findProjectForCwd(
  cwd: string,
  projects: ProjectLite[],
): { path: string; slug: string } | null {
  let best: ProjectLite | null = null;
  for (const p of projects) {
    if (cwd === p.path || cwd.startsWith(p.path + "/")) {
      if (!best || p.path.length > best.path.length) best = p;
    }
  }
  return best ? { path: best.path, slug: best.display_slug } : null;
}

function vakkaStatusVerb(status: SessionStatus): LiveStatusVerb {
  switch (status) {
    case "starting":
      return "starting";
    case "waiting_permission":
      return "awaiting permission";
    case "waiting_input":
      return "awaiting input";
    default:
      return "running";
  }
}

function rcStatusVerb(workerStatus: string | undefined): LiveStatusVerb {
  switch (workerStatus) {
    case "waiting_permission":
      return "awaiting permission";
    case "waiting_input":
      return "awaiting input";
    case "starting":
      return "starting";
    default:
      return "running";
  }
}

function tiebreakerKey(v: LiveSessionView): string {
  return v.sdk_session_id ?? v.vakka_session_id ?? v.cse_id ?? String(v.pid ?? "");
}

export async function buildLiveView(args: BuildLiveViewArgs): Promise<LiveSessionView[]> {
  const { db, liveProcesses, projects } = args;
  const now = args.now ?? Date.now();
  const resolve = args.resolveSdkId ?? ((cwd) => defaultResolveSdkId(cwd, args.projectsRoot, now));

  const out: LiveSessionView[] = [];
  const wrapperPids = new Set<number>();

  // Vakka rows first. Set membership over wrapper PIDs powers cc-cli dedup.
  const active: SessionRow[] = getActiveSessions(db).filter(
    (s) => s.project_path !== RC_ATTACHED_PROJECT_PATH,
  );
  for (const s of active) {
    if (typeof s.pid === "number") wrapperPids.add(s.pid);
    const proj = projects.find((p) => p.path === s.project_path) ?? null;
    out.push({
      sdk_session_id: s.sdk_session_id,
      vakka_session_id: s.id,
      cse_id: null,
      origin: "vakka",
      transport: "wrapper",
      status: s.status,
      status_verb: vakkaStatusVerb(s.status),
      permission_pending: s.status === "waiting_permission",
      project_path: s.project_path,
      slug: proj?.display_slug ?? null,
      cwd: s.project_path,
      cwd_basename: basename(s.project_path),
      pid: s.pid,
      started_at: s.start_time_ms !== null ? new Date(s.start_time_ms).toISOString() : null,
      last_activity: s.last_activity,
      cost_usd: s.cost_usd,
    });
  }

  // Live processes (RC + cc-cli). Skip cc-cli rows whose PID matches a
  // Vakka wrapper. Do NOT dedup RC by wrapperPids (CC manifest pid for RC is
  // the `claude` child, never the wrapper Bun PID — equality unreachable).
  for (const lp of liveProcesses) {
    if (lp.kind === "cc-cli" && wrapperPids.has(lp.pid)) continue;

    const project = findProjectForCwd(lp.cwd, projects);
    // Prefer the SDK session id from CC's manifest (per-PID, authoritative).
    // Fall back to the cwd-newest-jsonl resolver only when the manifest lacks
    // it (older CC versions).
    const sdkId = lp.sdk_session_id ?? (await resolve(lp.cwd));

    if (lp.kind === "rc") {
      out.push({
        sdk_session_id: sdkId,
        vakka_session_id: null,
        cse_id: lp.cseFromRegistry ? (lp.cseId ?? null) : null,
        origin: "external",
        transport: "rc",
        status: lp.workerStatus ?? "running",
        status_verb: rcStatusVerb(lp.workerStatus),
        permission_pending: lp.workerStatus === "waiting_permission",
        project_path: project?.path ?? null,
        slug: project?.slug ?? null,
        cwd: lp.cwd,
        cwd_basename: basename(lp.cwd),
        pid: lp.pid,
        started_at: lp.manifest_mtime,
        last_activity: lp.lastActivity ?? lp.manifest_mtime,
        cost_usd: lp.cumulativeCostUsd ?? 0,
      });
    } else {
      out.push({
        sdk_session_id: sdkId,
        vakka_session_id: null,
        cse_id: null,
        origin: "external",
        transport: "cli",
        status: "running",
        status_verb: "running",
        permission_pending: false,
        project_path: project?.path ?? null,
        slug: project?.slug ?? null,
        cwd: lp.cwd,
        cwd_basename: basename(lp.cwd),
        pid: lp.pid,
        started_at: lp.manifest_mtime,
        last_activity: lp.manifest_mtime,
        cost_usd: 0,
      });
    }
  }

  out.sort((a, b) => {
    if (a.last_activity !== b.last_activity) {
      return a.last_activity < b.last_activity ? 1 : -1;
    }
    const ka = tiebreakerKey(a);
    const kb = tiebreakerKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return out;
}
