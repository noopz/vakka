import type { Database } from "bun:sqlite";
import type { ProjectRow, SessionRow, SessionStatus } from "../shared/types.js";
import type { NormalizedMessage } from "../shared/message-types.js";

// ── Projects ──────────────────────────────────────────────────────────

export function upsertProject(
  db: Database,
  project: { path: string; name: string } & Partial<ProjectRow>,
): void {
  db.query(
    `INSERT OR REPLACE INTO projects (path, name, discovered_at, last_file_activity, last_human_session, pinned, hidden)
     VALUES (?1, ?2, COALESCE(?3, datetime('now')), ?4, ?5, COALESCE(?6, 0), COALESCE(?7, 0))`,
  ).run(
    project.path,
    project.name,
    project.discovered_at ?? null,
    project.last_file_activity ?? null,
    project.last_human_session ?? null,
    project.pinned ?? 0,
    project.hidden ?? 0,
  );
}

export function getProjects(db: Database): ProjectRow[] {
  return db
    .query(
      `SELECT * FROM projects
       WHERE hidden = 0
       ORDER BY pinned DESC,
         CASE WHEN last_human_session IS NULL THEN 1 ELSE 0 END,
         last_human_session DESC,
         CASE WHEN last_file_activity IS NULL THEN 1 ELSE 0 END,
         last_file_activity DESC`,
    )
    .all() as ProjectRow[];
}

export function setProjectHidden(db: Database, path: string, hidden: boolean): void {
  db.query("UPDATE projects SET hidden = ?1 WHERE path = ?2").run(hidden ? 1 : 0, path);
}

export function getProject(db: Database, path: string): ProjectRow | null {
  return (db.query("SELECT * FROM projects WHERE path = ?1").get(path) as ProjectRow) ?? null;
}

export function updateProjectActivity(db: Database, path: string, lastFileActivity: string): void {
  db.query("UPDATE projects SET last_file_activity = ?1 WHERE path = ?2").run(
    lastFileActivity,
    path,
  );
}

export function pinProject(db: Database, path: string, pinned: boolean): void {
  db.query("UPDATE projects SET pinned = ?1 WHERE path = ?2").run(pinned ? 1 : 0, path);
}

// ── Sessions ──────────────────────────────────────────────────────────

export function createSession(
  db: Database,
  session: {
    id: string;
    project_path: string;
    model: string;
    pid?: number;
    forked_from_sdk_id?: string;
    control_mode?: string;
    start_time_ms?: number;
  },
): SessionRow {
  db.query(
    `INSERT INTO sessions (id, project_path, model, pid, forked_from_sdk_id, control_mode, start_time_ms)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).run(
    session.id,
    session.project_path,
    session.model,
    session.pid ?? null,
    session.forked_from_sdk_id ?? null,
    session.control_mode ?? "sdk-wrapper",
    session.start_time_ms ?? null,
  );

  return getSession(db, session.id)!;
}

/** For external-candidate enrichment: which of these SDK ids does Vakka know? */
export function getSessionsBySdkIds(
  db: Database,
  sdkIds: string[],
): Map<string, SessionRow> {
  const out = new Map<string, SessionRow>();
  if (sdkIds.length === 0) return out;
  const placeholders = sdkIds.map((_, i) => `?${i + 1}`).join(",");
  const rows = db
    .query(`SELECT * FROM sessions WHERE sdk_session_id IN (${placeholders})`)
    .all(...sdkIds) as SessionRow[];
  for (const r of rows) {
    if (r.sdk_session_id) out.set(r.sdk_session_id, r);
  }
  return out;
}

export function getSession(db: Database, id: string): SessionRow | null {
  return (db.query("SELECT * FROM sessions WHERE id = ?1").get(id) as SessionRow) ?? null;
}

export function getSessionsForProject(db: Database, projectPath: string): SessionRow[] {
  return db
    .query("SELECT * FROM sessions WHERE project_path = ?1 ORDER BY last_activity DESC")
    .all(projectPath) as SessionRow[];
}

export function getActiveSessions(db: Database): SessionRow[] {
  // Includes 'starting': a session whose wrapper is alive but hasn't yet
  // published its first status. Without this, a SIGTERM during the boot
  // window would skip the just-spawned agent and orphan it.
  return db
    .query(
      "SELECT * FROM sessions WHERE status IN ('starting', 'running', 'waiting_permission', 'waiting_input') ORDER BY last_activity DESC",
    )
    .all() as SessionRow[];
}

export function getAllSessions(db: Database): SessionRow[] {
  return db.query("SELECT * FROM sessions ORDER BY last_activity DESC").all() as SessionRow[];
}

export function updateSessionStatus(db: Database, id: string, status: SessionStatus): void {
  db.query(
    "UPDATE sessions SET status = ?1, last_activity = datetime('now') WHERE id = ?2",
  ).run(status, id);
}

export function updateSessionPid(db: Database, id: string, pid: number): void {
  db.query("UPDATE sessions SET pid = ?1 WHERE id = ?2").run(pid, id);
}

export function updateSessionStartTime(db: Database, id: string, startTimeMs: number): void {
  db.query("UPDATE sessions SET start_time_ms = ?1 WHERE id = ?2").run(startTimeMs, id);
}

export function updateSessionSdkId(db: Database, id: string, sdkSessionId: string): void {
  db.query("UPDATE sessions SET sdk_session_id = ?1 WHERE id = ?2").run(sdkSessionId, id);
}

export function updateSessionCost(db: Database, id: string, costUsd: number): void {
  db.query(
    "UPDATE sessions SET cost_usd = ?1, last_activity = datetime('now') WHERE id = ?2",
  ).run(costUsd, id);
}

export function updateSessionActivity(db: Database, id: string): void {
  db.query("UPDATE sessions SET last_activity = datetime('now') WHERE id = ?1").run(id);
}

// ── Chat messages ─────────────────────────────────────────────────────
//
// Single discriminated table; each row IS the wire-format NormalizedMessage.
// See src/shared/message-types.ts and the plan at
// /Users/example/.claude/plans/rippling-soaring-treehouse.md.

export interface ChatMessageRow {
  id: number;
  session_id: string;
  kind: string;
  created_at: string;
  parent_id: string | null;
  text: string | null;
  tool_use_id: string | null;
  tool_name: string | null;
  tool_summary: string | null;
  tool_input_json: string | null;
  output: string | null;
  is_error: number | null;
  pre_tokens: number | null;
  post_tokens: number | null;
  trigger: string | null;
  question_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  model: string | null;
  hidden_from_render: number;
  payload_json: string | null;
}

/**
 * Insert a NormalizedMessage as a chat_messages row.
 *
 * For `tool_result` kind, `tool_name`/`tool_summary`/`tool_input_json` are
 * pulled from a sibling `tool_use` lookup (`getToolUseByCorrelationId`).
 * On miss we fall back to `tool_name='Tool', tool_summary=null` — same
 * degraded state as today.
 *
 * For `permission_request` / `question` / `plan_proposal`, the variant-
 * specific bits go into `payload_json` AND `tool_use_id` / `question_id`
 * are populated for fast indexed lookups.
 *
 * Returns the inserted row id.
 */
export function insertChatMessage(
  db: Database,
  msg: NormalizedMessage,
  sessionId: string,
): number {
  type Cols = {
    kind: string;
    parent_id: string | null;
    text: string | null;
    tool_use_id: string | null;
    tool_name: string | null;
    tool_summary: string | null;
    tool_input_json: string | null;
    output: string | null;
    is_error: number | null;
    pre_tokens: number | null;
    post_tokens: number | null;
    trigger: string | null;
    question_id: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
    model: string | null;
    hidden_from_render: number;
    payload_json: string | null;
  };

  const base: Cols = {
    kind: msg.kind,
    parent_id: null,
    text: null,
    tool_use_id: null,
    tool_name: null,
    tool_summary: null,
    tool_input_json: null,
    output: null,
    is_error: null,
    pre_tokens: null,
    post_tokens: null,
    trigger: null,
    question_id: null,
    input_tokens: null,
    output_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    model: null,
    hidden_from_render: 0,
    payload_json: null,
  };

  switch (msg.kind) {
    case "user": {
      base.text = msg.text;
      // Empty/null cleaned text → keep auditable but hide from default reads.
      if (!msg.text) base.hidden_from_render = 1;
      break;
    }
    case "assistant": {
      base.text = msg.text;
      base.model = msg.model ?? null;
      if (msg.usage) {
        base.input_tokens = msg.usage.inputTokens;
        base.output_tokens = msg.usage.outputTokens;
        base.cache_creation_input_tokens = msg.usage.cacheCreationInputTokens;
        base.cache_read_input_tokens = msg.usage.cacheReadInputTokens;
      }
      break;
    }
    case "tool_use": {
      base.tool_use_id = msg.toolUseId;
      base.tool_name = msg.toolName;
      base.tool_summary = msg.toolSummary;
      base.tool_input_json = JSON.stringify(msg.toolInput ?? {});
      // parentId is the SDK message id of the assistant row that emitted this
      // tool_use. Stored as TEXT (no FK); see schema.ts.
      base.parent_id = msg.parentId || null;
      break;
    }
    case "tool_result": {
      base.tool_use_id = msg.toolUseId;
      base.output = msg.output;
      base.is_error = msg.isError ? 1 : 0;
      // Denormalize tool_name/tool_summary from the prior tool_use row.
      const prior = getToolUseByCorrelationId(db, msg.toolUseId, sessionId);
      base.tool_name = prior?.tool_name || msg.toolName || "Tool";
      base.tool_summary = prior?.tool_summary || msg.toolSummary || null;
      break;
    }
    case "system": {
      base.text = msg.text;
      break;
    }
    case "compact": {
      base.pre_tokens = msg.preTokens;
      base.post_tokens = msg.postTokens;
      base.trigger = msg.trigger;
      break;
    }
    case "compact_summary": {
      base.text = msg.text;
      break;
    }
    case "permission_request": {
      base.tool_use_id = msg.toolUseId ?? null;
      base.tool_name = msg.tool;
      base.payload_json = JSON.stringify({
        tool: msg.tool,
        input: msg.input,
        alwaysAsk: msg.alwaysAsk,
        status: msg.status,
      });
      break;
    }
    case "question": {
      base.question_id = msg.questionId ?? null;
      base.tool_use_id = msg.toolUseId ?? null;
      base.payload_json = JSON.stringify({
        questions: msg.questions,
        status: msg.status,
        answers: msg.answers,
      });
      break;
    }
    case "plan_proposal": {
      base.tool_use_id = msg.toolUseId ?? null;
      base.text = msg.plan;
      base.payload_json = JSON.stringify({
        plan: msg.plan,
        status: msg.status,
        feedback: msg.feedback,
      });
      break;
    }
  }

  const result = db
    .query(
      `INSERT INTO chat_messages (
         session_id, kind, parent_id, text,
         tool_use_id, tool_name, tool_summary, tool_input_json,
         output, is_error,
         pre_tokens, post_tokens, trigger,
         question_id,
         input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
         model, hidden_from_render, payload_json
       ) VALUES (
         ?1, ?2, ?3, ?4,
         ?5, ?6, ?7, ?8,
         ?9, ?10,
         ?11, ?12, ?13,
         ?14,
         ?15, ?16, ?17, ?18,
         ?19, ?20, ?21
       ) RETURNING id`,
    )
    .get(
      sessionId,
      base.kind,
      base.parent_id,
      base.text,
      base.tool_use_id,
      base.tool_name,
      base.tool_summary,
      base.tool_input_json,
      base.output,
      base.is_error,
      base.pre_tokens,
      base.post_tokens,
      base.trigger,
      base.question_id,
      base.input_tokens,
      base.output_tokens,
      base.cache_creation_input_tokens,
      base.cache_read_input_tokens,
      base.model,
      base.hidden_from_render,
      base.payload_json,
    ) as { id: number };
  return result.id;
}

/** Cursor-paginated read of `chat_messages` for a session. */
export function getChatMessages(
  db: Database,
  sessionId: string,
  opts?: { before?: number; after?: number; limit?: number; includeHidden?: boolean },
): ChatMessageRow[] {
  const limit = opts?.limit ?? 200;
  const includeHidden = opts?.includeHidden === true;
  const hiddenClause = includeHidden ? "" : "AND hidden_from_render = 0";

  if (opts?.before != null) {
    return db
      .query(
        `SELECT * FROM chat_messages
         WHERE session_id = ?1 AND id < ?2 ${hiddenClause}
         AND id IN (
           SELECT id FROM chat_messages
           WHERE session_id = ?1 AND id < ?2 ${hiddenClause}
           ORDER BY id DESC LIMIT ?3
         )
         ORDER BY id ASC`,
      )
      .all(sessionId, opts.before, limit) as ChatMessageRow[];
  }
  if (opts?.after != null) {
    return db
      .query(
        `SELECT * FROM chat_messages
         WHERE session_id = ?1 AND id > ?2 ${hiddenClause}
         ORDER BY id ASC LIMIT ?3`,
      )
      .all(sessionId, opts.after, limit) as ChatMessageRow[];
  }
  return db
    .query(
      `SELECT * FROM chat_messages
       WHERE session_id = ?1 ${hiddenClause}
       ORDER BY id ASC LIMIT ?2`,
    )
    .all(sessionId, limit) as ChatMessageRow[];
}

/** Convenience wrapper: N rows before a cursor, chronological order. */
export function getChatMessagesBefore(
  db: Database,
  sessionId: string,
  before: number,
  limit?: number,
): ChatMessageRow[] {
  return getChatMessages(db, sessionId, { before, limit });
}

/**
 * Look up a tool_use row by its correlation id. Used by `insertChatMessage`
 * when persisting a tool_result to denormalize `tool_name`/`tool_summary`,
 * and by tests/projection code.
 */
/**
 * Look up an existing prompt-card row (question / permission_request / plan_proposal)
 * by its tool_use_id correlation. Used by mqtt-handler to dedupe duplicate
 * inserts when the rc-relay's SSE replays an unresolved control_request after
 * a manager restart. Returns the row id or null.
 */
export function getPromptCardIdByToolUseId(
  db: Database,
  sessionId: string,
  toolUseId: string,
): number | null {
  const row = db
    .query(
      `SELECT id FROM chat_messages
       WHERE session_id = ?1 AND tool_use_id = ?2
         AND kind IN ('question', 'permission_request', 'plan_proposal')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(sessionId, toolUseId) as { id: number } | null;
  return row?.id ?? null;
}

export function getToolUseByCorrelationId(
  db: Database,
  toolUseId: string,
  sessionId: string,
): { tool_name: string | null; tool_summary: string | null; tool_input_json: string | null } | null {
  const row = db
    .query(
      `SELECT tool_name, tool_summary, tool_input_json FROM chat_messages
       WHERE tool_use_id = ?1 AND kind = 'tool_use' AND session_id = ?2
       LIMIT 1`,
    )
    .get(toolUseId, sessionId) as
    | { tool_name: string | null; tool_summary: string | null; tool_input_json: string | null }
    | null;
  return row ?? null;
}

/**
 * Update the variant-specific bits stored in `payload_json` for a
 * permission_request / question / plan_proposal row, located either by
 * tool_use_id or question_id.
 *
 * Used by the response-merge paths (`permission_response`, `question_response`,
 * `plan_response`) that land in commit 3.
 *
 * Returns the updated row's id, or null if no row matched.
 */
export function updateChatMessageStatus(
  db: Database,
  sessionId: string,
  lookup: { toolUseId?: string; questionId?: string },
  payload: Partial<{
    status: string;
    answers: string[];
    feedback: string;
  }>,
): number | null {
  let row: { id: number; payload_json: string | null } | null = null;
  let updateKindClause = "";
  if (lookup.toolUseId != null) {
    row = db
      .query(
        `SELECT id, payload_json FROM chat_messages
         WHERE session_id = ?1 AND tool_use_id = ?2
           AND kind IN ('permission_request', 'question', 'plan_proposal')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId, lookup.toolUseId) as
      | { id: number; payload_json: string | null }
      | null;
    updateKindClause = " AND kind IN ('permission_request', 'question', 'plan_proposal')";
  } else if (lookup.questionId != null) {
    row = db
      .query(
        `SELECT id, payload_json FROM chat_messages
         WHERE session_id = ?1 AND question_id = ?2 AND kind = 'question'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId, lookup.questionId) as
      | { id: number; payload_json: string | null }
      | null;
    updateKindClause = " AND kind = 'question'";
  }
  if (!row) return null;

  let merged: Record<string, unknown> = {};
  if (row.payload_json) {
    try {
      merged = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      merged = {};
    }
  }
  if (payload.status !== undefined) merged.status = payload.status;
  if (payload.answers !== undefined) merged.answers = payload.answers;
  if (payload.feedback !== undefined) merged.feedback = payload.feedback;

  db.query(`UPDATE chat_messages SET payload_json = ?1 WHERE id = ?2${updateKindClause}`).run(
    JSON.stringify(merged),
    row.id,
  );
  return row.id;
}

export interface ResumeCandidate {
  id: string;
  status: SessionStatus;
  model: string;
  cost_usd: number;
  last_activity: string;
  created_at: string;
  message_count: number;
  last_user_text: string | null;
  last_assistant_text: string | null;
  resumable: boolean;
}

/** Last N terminal sessions for a project, with previews for resume cards. */
export function getResumeCandidates(
  db: Database,
  projectPath: string,
  limit = 10,
): ResumeCandidate[] {
  const sessions = db
    .query(
      `SELECT id, status, model, cost_usd, last_activity, created_at, sdk_session_id
       FROM sessions
       WHERE project_path = ?1 AND status IN ('completed', 'failed')
       ORDER BY last_activity DESC
       LIMIT ?2`,
    )
    .all(projectPath, limit) as Array<{
      id: string;
      status: SessionStatus;
      model: string;
      cost_usd: number;
      last_activity: string;
      created_at: string;
      sdk_session_id: string | null;
    }>;

  if (sessions.length === 0) return [];

  const countStmt = db.query(
    "SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?1 AND kind IN ('user', 'assistant') AND hidden_from_render = 0",
  );
  const lastByKindStmt = db.query(
    `SELECT text FROM chat_messages
     WHERE session_id = ?1 AND kind = ?2 AND hidden_from_render = 0
     ORDER BY id DESC LIMIT 1`,
  );

  return sessions.map((s) => {
    const { n } = countStmt.get(s.id) as { n: number };
    const userRow = lastByKindStmt.get(s.id, "user") as { text: string | null } | null;
    const asstRow = lastByKindStmt.get(s.id, "assistant") as { text: string | null } | null;
    const userText = userRow?.text ?? null;
    const asstText = asstRow?.text ?? null;
    return {
      id: s.id,
      status: s.status,
      model: s.model,
      cost_usd: s.cost_usd,
      last_activity: s.last_activity,
      created_at: s.created_at,
      message_count: n,
      last_user_text: userText ? userText.slice(0, 200) : null,
      last_assistant_text: asstText ? asstText.slice(0, 200) : null,
      resumable: s.sdk_session_id != null,
    };
  });
}

/**
 * Copy all chat_messages rows from one session into another, preserving
 * column values verbatim with two adjustments:
 *   (a) `session_id` is rewritten to the target.
 *   (b) `parent_id` is set to NULL on copied rows (option (ii) in the plan):
 *       the source parent_id points to row ids in a different range; nulling
 *       avoids dangling pointers, and the chat view groups tool_use rows by
 *       tool_use_id correlation, not by parent_id.
 *
 * `tool_use_id` correlation between copied tool_use and tool_result rows is
 * preserved verbatim so post-copy `getToolUseByCorrelationId` still resolves.
 */
export function copyMessages(db: Database, fromSessionId: string, toSessionId: string): number {
  const result = db
    .query(
      `INSERT INTO chat_messages (
         session_id, kind, created_at, parent_id, text,
         tool_use_id, tool_name, tool_summary, tool_input_json,
         output, is_error,
         pre_tokens, post_tokens, trigger,
         question_id,
         input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
         model, hidden_from_render, payload_json
       )
       SELECT
         ?1, kind, created_at, NULL, text,
         tool_use_id, tool_name, tool_summary, tool_input_json,
         output, is_error,
         pre_tokens, post_tokens, trigger,
         question_id,
         input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
         model, hidden_from_render, payload_json
       FROM chat_messages WHERE session_id = ?2 ORDER BY id ASC`,
    )
    .run(toSessionId, fromSessionId);
  return Number(result.changes ?? 0);
}

export function getLatestMessageId(db: Database, sessionId: string): number | null {
  const row = db
    .query("SELECT MAX(id) as max_id FROM chat_messages WHERE session_id = ?1")
    .get(sessionId) as { max_id: number | null } | null;
  return row?.max_id ?? null;
}

export function getMessageCount(db: Database, sessionId: string): number {
  const row = db
    .query("SELECT COUNT(*) as n FROM chat_messages WHERE session_id = ?1")
    .get(sessionId) as { n: number } | null;
  return row?.n ?? 0;
}

