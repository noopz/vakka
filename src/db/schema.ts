import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_file_activity TEXT,
  last_human_session TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'starting',
  jsonl_path TEXT,
  model TEXT NOT NULL DEFAULT 'opus',
  pid INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_path) REFERENCES projects(path)
);

-- chat_messages: single discriminated table for the chat row stream.
-- Each row is the wire-format NormalizedMessage. See src/shared/message-types.ts.
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- SDK message id of the assistant message that emitted this tool_use; null otherwise.
  parent_id TEXT,

  -- Common text body (user, assistant, system, compact_summary)
  text TEXT,

  -- tool_use / tool_result
  tool_use_id TEXT,
  tool_name TEXT,
  tool_summary TEXT,
  tool_input_json TEXT,
  output TEXT,
  is_error INTEGER,

  -- compact (kind='compact')
  pre_tokens INTEGER,
  post_tokens INTEGER,
  trigger TEXT,

  -- question lookup (kind='question')
  question_id TEXT,

  -- assistant-only: per-turn token usage
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  cache_read_input_tokens INTEGER,

  -- assistant-only: per-turn model id
  model TEXT,

  -- render gate. 1 = persisted but excluded from default reads.
  hidden_from_render INTEGER NOT NULL DEFAULT 0,

  -- permission_request / question / plan_proposal variable bits
  payload_json TEXT,

  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_kind ON chat_messages(session_id, kind, id DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_tool_use ON chat_messages(tool_use_id) WHERE tool_use_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_messages_question ON chat_messages(question_id) WHERE question_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_messages_parent ON chat_messages(parent_id) WHERE parent_id IS NOT NULL;
`;

export function initDatabase(dbPath: string): Database {
  // Ensure data directory exists (skip for in-memory DBs)
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  // Enable WAL mode for concurrent read access from web server
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA busy_timeout=5000");

  // Run schema
  db.exec(SCHEMA);

  // Idempotent column additions for forward migrations. SQLite raises if the
  // column already exists; the catch swallows that specific case.
  try { db.run("ALTER TABLE sessions ADD COLUMN start_time_ms INTEGER"); } catch {}
  try { db.run("ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT"); } catch {}
  try { db.run("ALTER TABLE sessions ADD COLUMN forked_from_sdk_id TEXT"); } catch {}
  try { db.run("ALTER TABLE sessions ADD COLUMN control_mode TEXT NOT NULL DEFAULT 'sdk-wrapper'"); } catch {}

  // One-time backfill: existing rc-attached rows (sentinel project_path) get the right mode.
  // Naturally idempotent — re-running just re-sets the same value.
  db.run("UPDATE sessions SET control_mode = 'rc-attached' WHERE project_path = '<rc-attached>'");

  return db;
}
