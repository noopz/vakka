import { signal, computed } from "@preact/signals";
import type { Message, ContextUsage } from "../types.js";
import type { ProjectSession, ProjectInfo as ApiProjectInfo, LiveSessionViewApi } from "../services/api.js";
import { LIVE_STATUSES } from "../../shared/types.js";

export interface SessionInfo {
  id: string;
  project_path: string;
  status: string;
  model: string;
  cost_usd: number;
  last_activity: string;
  created_at: string;
}

export type ProjectInfo = ApiProjectInfo;

export const sessions = signal<SessionInfo[]>([]);
export const projects = signal<ProjectInfo[]>([]);
export const projectsBySlug = computed(() => {
  const m = new Map<string, ProjectInfo>();
  for (const p of projects.value) {
    if (p.display_slug) m.set(p.display_slug, p);
  }
  return m;
});
export const activeSessions = computed(() =>
  sessions.value.filter((s) => LIVE_STATUSES.has(s.status))
);

export const currentSessionId = signal<string | null>(null);
export const messages = signal<Message[]>([]);
export const streamingContent = signal<string>("");
export const streamingMessageId = signal<string | null>(null);

export const wsState = signal<"disconnected" | "connecting" | "connected">(
  "disconnected"
);
export const isPhone = signal(false);
export const contextUsage = signal<ContextUsage | null>(null);
export const pendingActions = signal<Map<string, number>>(new Map());

// Manager hot-restart state
export const managerRestarting = signal<boolean>(false);
export const managerStartedAt = signal<number | null>(null);

// Unified per-project session listing — DB rows + external CC jsonls,
// mtime-sorted, with liveness annotations. Lazily hydrated.
export const projectSessions = signal<Map<string, ProjectSession[]>>(new Map());

// Lazy-resume preview (Phase 4a). When set, the chat view renders the jsonl
// content read-only — zero tokens, no wrapper spawn. The first user message
// "commits": we create a session via resumeFrom/resumeFromExternal, send the
// prompt as the first turn, then clear preview and switch to the live id.
export interface PreviewSession {
  candidate: ProjectSession;
  project_path: string;
}
export const previewSession = signal<PreviewSession | null>(null);
// Set to the sdkId once chat-route's preview-lookup loop has settled (found a
// candidate or exhausted all cwds). ChatView uses this to distinguish "still
// looking" from "looked, found nothing" before showing the stale pill.
export const previewLookupSettled = signal<string | null>(null);

// Unified live-view feed (GET /api/live) — server-side join over
// liveProcesses ⨝ activeSessions ⨝ external-jsonl.
export type LiveSessionView = LiveSessionViewApi;
export const liveView = signal<LiveSessionView[]>([]);
