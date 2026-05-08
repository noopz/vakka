// Session status
export type SessionStatus = "starting" | "running" | "waiting_permission" | "waiting_input" | "requires_action" | "completed" | "failed" | "error";

// Session statuses where the agent is alive and the live ChatView should
// drive the route — running, blocked on user input, or blocked on a
// permission/question response. Anything else is terminal from the UI's POV.
export const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "waiting_permission",
  "waiting_input",
  "requires_action",
]);

// Sentinel project_path used by RC-attached sessions (no real project cwd).
export const RC_ATTACHED_PROJECT_PATH = "<rc-attached>";

// MQTT message schemas
export interface MQTTInputMessage {
  text: string;
  images?: { type: string; data: string }[];
}
export interface MQTTOutputMessage { type: string; [key: string]: any }
export interface MQTTStatusMessage { status: SessionStatus; error?: string }
export interface MQTTCostMessage { input_tokens: number; output_tokens: number; cost_usd: number; cumulative_cost_usd: number }
export interface MQTTPermissionRequest { tool: string; input: Record<string, any>; alwaysAsk?: boolean; description?: string }
export interface MQTTPermissionResponse { decision: "allow" | "deny" | "allow_always"; tool: string }
export interface MQTTQuestionMessage { question: string; options?: string[]; allowFreeText?: boolean; multiSelect?: boolean }
export interface MQTTQuestionResponse { answer: string | string[] }
export interface MQTTContextMessage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  model: string;
  categories: { name: string; tokens: number; color: string; isDeferred?: boolean }[];
  mcpTools: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[];
  agents: { agentType: string; source: string; tokens: number }[];
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
    skillFrontmatter: { name: string; source: string; tokens: number }[];
  };
  slashCommands?: { totalCommands: number; includedCommands: number; tokens: number };
  systemTools?: { name: string; tokens: number }[];
  deferredBuiltinTools?: { name: string; tokens: number; isLoaded: boolean }[];
  systemPromptSections?: { name: string; tokens: number }[];
  memoryFiles?: { path: string; type: string; tokens: number }[];
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
    redirectedContextTokens: number;
    unattributedTokens: number;
    toolCallsByType: { name: string; callTokens: number; resultTokens: number }[];
  };
  autoCompactThreshold?: number;
  isAutoCompactEnabled?: boolean;
}

// DB row types
export interface ProjectRow {
  path: string;
  name: string;
  discovered_at: string;
  last_file_activity: string | null;
  last_human_session: string | null;
  pinned: number;
  hidden: number;
}

export interface SessionRow {
  id: string;
  project_path: string;
  status: SessionStatus;
  jsonl_path: string | null;
  model: string;
  pid: number | null;
  start_time_ms: number | null;
  sdk_session_id: string | null;
  forked_from_sdk_id: string | null;
  cost_usd: number;
  created_at: string;
  last_activity: string;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

// ── Live view (GET /api/live) ────────────────────────────────────────
//
// Unified shape that consolidates the join over liveProcesses ⨝ activeSessions
// ⨝ external-jsonl that previously lived in four separate frontend sites.
// See ~/.claude/plans/rippling-soaring-treehouse.md.

export type LiveOrigin = "vakka" | "external";
export type LiveTransport = "wrapper" | "rc" | "cli";
export type LiveStatusVerb = "running" | "awaiting permission" | "awaiting input" | "starting";

export interface LiveSessionView {
  // Identity
  sdk_session_id: string | null;
  vakka_session_id: string | null;
  cse_id: string | null;

  // Classification — two orthogonal axes.
  // v1 invariant: origin === "vakka" ⇔ transport === "wrapper".
  origin: LiveOrigin;
  transport: LiveTransport;
  status: SessionStatus | string;
  status_verb: LiveStatusVerb;
  permission_pending: boolean;

  // Project (longest-prefix match, server-side)
  project_path: string | null;
  slug: string | null;
  cwd: string;
  cwd_basename: string;

  // Process
  pid: number | null;

  // Activity
  started_at: string | null;
  last_activity: string;
  cost_usd: number;
}

// Permissions config (loaded from project's permissions.json)
export interface PermissionsConfig {
  allowedTools?: string[];
  alwaysAskTools?: string[];
  disallowedTools?: string[];
  defaultMode?: string;
}
