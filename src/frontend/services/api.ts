import { getAuthHeader } from "./auth.js";
import type { NormalizedMessage } from "../../shared/message-types.js";

const BASE = "";

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const auth = getAuthHeader();
  if (auth) h["Authorization"] = auth;
  return h;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers(), ...init?.headers },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

// Projects
export interface ProjectInfo {
  path: string;
  name: string;
  last_file_activity: string | null;
  pinned: number;
  display_slug: string;
  external_live?: boolean;
}
export function fetchProjects() {
  return request<ProjectInfo[]>("/api/projects");
}
export function fetchProjectBySlug(slug: string) {
  return request<ProjectInfo>(`/api/projects/by-slug/${encodeURIComponent(slug)}`);
}

export function setPinned(projectPath: string, pinned: boolean) {
  return request<{ ok: boolean }>(
    `/api/projects/${encodeURIComponent(projectPath)}/pin`,
    { method: "POST", body: JSON.stringify({ pinned }) },
  );
}

export function addProject(path: string, name?: string) {
  return request<{ ok: boolean; path: string; name: string }>(
    `/api/projects`,
    { method: "POST", body: JSON.stringify({ path, name }) },
  );
}

export function setHidden(projectPath: string, hidden: boolean) {
  return request<{ ok: boolean }>(
    `/api/projects/${encodeURIComponent(projectPath)}/hide`,
    { method: "POST", body: JSON.stringify({ hidden }) },
  );
}

// Sessions
export function fetchSessions() {
  return request<any[]>("/api/sessions");
}

export function fetchActiveSessions() {
  return request<any[]>("/api/sessions/active");
}

export interface RcSessionApi {
  cseId: string;
  sessionId: string;
  startedAt: number;
  lastActivity: number;
  workerStatus: string;
  cumulativeCostUsd: number;
  lastAssistantPreview: string | null;
}
export function fetchRcSessions() {
  return request<RcSessionApi[]>("/api/rc-sessions");
}

// Mirrors LiveSessionView in src/shared/types.ts. Server-side join: one
// row per running session, regardless of origin/transport.
export interface LiveSessionViewApi {
  sdk_session_id: string | null;
  vakka_session_id: string | null;
  cse_id: string | null;
  origin: "vakka" | "external";
  transport: "wrapper" | "rc" | "cli";
  status: string;
  status_verb: "running" | "awaiting permission" | "awaiting input" | "starting";
  permission_pending: boolean;
  project_path: string | null;
  slug: string | null;
  cwd: string;
  cwd_basename: string;
  pid: number | null;
  started_at: string | null;
  last_activity: string;
  cost_usd: number;
}

export function fetchLiveView() {
  return request<LiveSessionViewApi[]>("/api/live");
}

export function fetchMessageCount(sessionId: string) {
  return request<{ total: number }>(`/api/sessions/${sessionId}/messages/count`);
}

export function fetchMessages(
  sessionId: string,
  opts?: { afterId?: number; beforeId?: number; limit?: number },
) {
  const params = new URLSearchParams();
  if (opts?.afterId != null) params.set("after", String(opts.afterId));
  if (opts?.beforeId != null) params.set("before", String(opts.beforeId));
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request<NormalizedMessage[]>(`/api/sessions/${sessionId}/messages${qs ? `?${qs}` : ""}`);
}

export function createSession(
  projectPath: string,
  model?: string,
  resumeFrom?: string,
  resumeFromExternal?: string,
  controlMode?: string,
) {
  return request<any>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ projectPath, model, resumeFrom, resumeFromExternal, controlMode }),
  });
}

// Unified per-project session listing (Phase 3.5/4). Blends Vakka-spawned and
// external Claude Code CLI jsonls into one mtime-sorted feed. Replaces the
// older ResumeCandidate / fetchResumeCandidates pair.
export interface ProjectSession {
  sdk_session_id: string;
  file_path: string;
  file_size: number;
  mtime: string;
  message_count: number | null;
  last_user_text: string | null;
  last_assistant_text: string | null;
  pending_tool_use: { name: string; summary: string } | null;
  slug: string | null;
  origin: "vakka" | "external";
  vakka_session_id: string | null;
  forked_from_sdk_id: string | null;
  cost_usd: number | null;
  model: string | null;
  status: string | null;
  live: boolean;
  live_holder:
    | { pid: number; exe: string; origin: "vakka" | "external-cli" }
    | null;
  blocked: boolean;
}

export function fetchProjectSessions(projectPath: string, limit = 20) {
  return request<{ sessions: ProjectSession[] }>(
    `/api/projects/${encodeURIComponent(projectPath)}/sessions?limit=${limit}`,
  ).then((r) => r.sessions);
}

export interface TranscriptResponse {
  sdk_session_id: string;
  file_path: string;
  messages: NormalizedMessage[];
  total: number;
  startIndex: number;
  endIndex: number;
}
export function fetchTranscript(
  sdkSessionId: string,
  projectPath: string,
  opts?: { before?: number; limit?: number },
) {
  const params = new URLSearchParams({ projectPath });
  if (opts?.before != null) params.set("before", String(opts.before));
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  return request<TranscriptResponse>(
    `/api/sessions/${sdkSessionId}/transcript?${params.toString()}`,
  );
}

export function killSession(id: string) {
  return request<any>(`/api/sessions/${id}/kill`, { method: "POST" });
}

export function interruptSession(id: string) {
  return request<any>(`/api/sessions/${id}/interrupt`, { method: "POST" });
}

export function restartSession(id: string) {
  return request<any>(`/api/sessions/${id}/restart`, { method: "POST" });
}

export function sendMessage(sessionId: string, text: string, images?: { type: string; data: string }[]) {
  return request<any>(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, images }),
  });
}

export function respondPermission(
  sessionId: string,
  decision: "allow" | "deny" | "allow_always",
  tool: string,
  toolUseId?: string,
  message?: string
) {
  return request<any>(`/api/sessions/${sessionId}/permission`, {
    method: "POST",
    body: JSON.stringify({ decision, tool, toolUseId, message }),
  });
}

export function respondQuestion(
  sessionId: string,
  answer: string | string[],
  questionId?: string,
  rc?: {
    toolUseId?: string;
    questions: unknown[];
    answersByQuestion: Record<string, string>;
    cancel?: boolean;
  }
) {
  return request<any>(`/api/sessions/${sessionId}/question`, {
    method: "POST",
    body: JSON.stringify({ answer, questionId, ...(rc ?? {}) }),
  });
}

export function respondPlan(
  sessionId: string,
  body: { approved: boolean; feedback?: string; toolUseId: string }
) {
  return request<any>(`/api/sessions/${sessionId}/plan-response`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function setPermissionMode(sessionId: string, mode: string) {
  return request<any>(`/api/sessions/${sessionId}/mode`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

export function fetchContextUsage(sessionId: string) {
  return request<any>(`/api/sessions/${sessionId}/context`);
}

export function browseDirectory(path?: string) {
  const params = path ? `?path=${encodeURIComponent(path)}` : "";
  return request<{ path: string; display: string; dirs: string[] }>(`/api/fs/browse${params}`);
}

export function restartManager() {
  return request<{ ok: boolean; commandId: string }>("/api/system/restart-manager", {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Device auth (these bypass the normal request() helper — no auth needed)
// ---------------------------------------------------------------------------

export async function registerDevice(name: string): Promise<{ deviceId: string; secret: string; status: string }> {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return res.json();
}

export async function verifyDevice(deviceId: string, secret: string): Promise<{ status: string }> {
  const res = await fetch(`${BASE}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, secret }),
  });
  return res.json();
}

export function fetchDevices() {
  return request<{ devices: Record<string, any> }>("/api/auth/devices");
}

export function fetchPendingDevices() {
  return request<{ devices: Record<string, any> }>("/api/auth/devices/pending");
}

export function approveDevice(id: string) {
  return request<{ ok: boolean }>(`/api/auth/devices/${id}/approve`, { method: "POST" });
}

export function removeDevice(id: string) {
  return request<{ ok: boolean }>(`/api/auth/devices/${id}`, { method: "DELETE" });
}
