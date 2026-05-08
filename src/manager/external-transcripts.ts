// Discover transcripts under ~/.claude/projects/<projectKey>/ that Vakka may
// not have created itself (e.g., started by Claude Code CLI, or from a
// pre-DB Vakka run). Read-only — we never modify these files. Resuming one
// goes through the SDK's `forkSession: true` option, which creates a brand-
// new session with a copy of the history; the source transcript is left
// untouched. See plan: ~/.claude/plans/rippling-soaring-treehouse.md
//
// Phase 0 spike (scripts/spike-fork.ts) confirmed forkSession works on the
// installed SDK 0.2.114 — new UUID assigned, source byte-identical, context
// retained.

import { open, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectKeyForCwd } from "./project-key.js";

export interface PendingToolUse {
  /** Tool name as written in the assistant block (Bash, Edit, …). */
  name: string;
  /** Compact one-line summary of input args (path, command, pattern). */
  summary: string;
}

export interface ExternalCandidate {
  sdk_session_id: string;
  file_path: string;
  file_size: number;
  mtime: string;
  live: boolean;
  message_count: number | null;
  last_user_text: string | null;
  last_assistant_text: string | null;
  /** Most recent tool_use block whose tool_use_id has no matching
      tool_result in the tail window. null when the agent is between
      turns or the most recent tool call has already completed. */
  pending_tool_use: PendingToolUse | null;
  cwd: string | null;
  slug: string | null;
}

interface CacheEntry {
  mtimeMs: number;
  preview: Pick<
    ExternalCandidate,
    | "last_user_text"
    | "last_assistant_text"
    | "message_count"
    | "pending_tool_use"
    | "cwd"
    | "slug"
  > | null;
}

const previewCache = new Map<string, CacheEntry>();

const TAIL_INITIAL_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 4 * 1024 * 1024;
const LIVE_THRESHOLD_MS = 60_000;
const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_AGE_DAYS = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ListOptions {
  limit?: number;
  maxAgeDays?: number;
  now?: number;
  /** Override `~/.claude/projects` for testing. */
  projectsRoot?: string;
}

export async function listExternalCandidates(
  projectPath: string,
  opts: ListOptions = {},
): Promise<ExternalCandidate[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const now = opts.now ?? Date.now();
  const cutoffMs = now - maxAgeDays * 24 * 60 * 60 * 1000;

  const projectsRoot = opts.projectsRoot ?? join(homedir(), ".claude/projects");
  const projectKey = projectKeyForCwd(projectPath);
  const dir = join(projectsRoot, projectKey);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const stats = await Promise.all(
    entries
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const full = join(dir, name);
        try {
          const st = await stat(full);
          return { name, full, mtimeMs: st.mtimeMs, size: st.size };
        } catch {
          return null;
        }
      }),
  );

  const sorted = stats
    .filter((s): s is NonNullable<typeof s> => s !== null && s.size > 0)
    .filter((s) => s.mtimeMs >= cutoffMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);

  const candidates: ExternalCandidate[] = [];
  for (const s of sorted) {
    const stem = s.name.replace(/\.jsonl$/, "");
    if (!UUID_RE.test(stem)) continue; // not an SDK session file
    const preview = await getOrLoadPreview(s.full, s.mtimeMs);
    if (!preview) continue;
    if (preview.cwd && preview.cwd !== projectPath) {
      console.warn(
        `[external-transcripts] skip ${s.full}: cwd mismatch ${preview.cwd} vs ${projectPath}`,
      );
      continue;
    }
    candidates.push({
      sdk_session_id: stem,
      file_path: s.full,
      file_size: s.size,
      mtime: new Date(s.mtimeMs).toISOString(),
      live: now - s.mtimeMs < LIVE_THRESHOLD_MS,
      message_count: preview.message_count,
      last_user_text: preview.last_user_text,
      last_assistant_text: preview.last_assistant_text,
      pending_tool_use: preview.pending_tool_use,
      cwd: preview.cwd,
      slug: preview.slug,
    });
  }
  return candidates;
}

async function getOrLoadPreview(
  filePath: string,
  mtimeMs: number,
): Promise<CacheEntry["preview"]> {
  const cached = previewCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.preview;

  const preview = await readPreview(filePath);
  previewCache.set(filePath, { mtimeMs, preview });
  return preview;
}

interface ParsedRecord {
  type?: string;
  cwd?: string;
  slug?: string;
  message?: { content?: unknown };
  [k: string]: unknown;
}

// Read an expanding tail window until we have a complete user/assistant pair
// (or hit the cap). Returns null if we couldn't extract anything useful.
async function readPreview(filePath: string): Promise<CacheEntry["preview"]> {
  let fh: FileHandle | null = null;
  try {
    fh = await open(filePath, "r");
    const st = await fh.stat();
    const fileSize = st.size;

    let windowSize = Math.min(TAIL_INITIAL_BYTES, fileSize);
    let lines: ParsedRecord[] = [];
    let coversWholeFile = windowSize >= fileSize;

    while (true) {
      const start = Math.max(0, fileSize - windowSize);
      const buf = Buffer.alloc(windowSize);
      const { bytesRead } = await fh.read(buf, 0, windowSize, start);
      const text = buf.subarray(0, bytesRead).toString("utf8");
      // If we didn't start at offset 0, the first partial line is junk.
      const usable = start === 0 ? text : text.slice(text.indexOf("\n") + 1);
      coversWholeFile = start === 0;
      lines = parseJsonLines(usable);

      if (hasUserAssistantPair(lines)) break;
      if (windowSize >= TAIL_MAX_BYTES || windowSize >= fileSize) break;
      windowSize = Math.min(windowSize * 2, TAIL_MAX_BYTES, fileSize);
    }

    if (lines.length === 0) {
      console.warn(`[external-transcripts] no parseable records in ${filePath}`);
      return null;
    }

    const lastUser = findLast(lines, (r) => r.type === "user");
    const lastAssistant = findLast(lines, (r) => r.type === "assistant");
    const cwd = findLast(lines, (r) => typeof r.cwd === "string")?.cwd ?? null;
    const slug = findLast(lines, (r) => typeof r.slug === "string")?.slug ?? null;

    return {
      last_user_text: extractUserText(lastUser),
      last_assistant_text: extractAssistantText(lastAssistant),
      pending_tool_use: extractPendingToolUse(lines),
      message_count: coversWholeFile ? lines.length : null,
      cwd,
      slug,
    };
  } catch (err) {
    console.warn(`[external-transcripts] read failed for ${filePath}:`, err);
    return null;
  } finally {
    await fh?.close();
  }
}

function parseJsonLines(text: string): ParsedRecord[] {
  const out: ParsedRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function hasUserAssistantPair(lines: ParsedRecord[]): boolean {
  let sawUser = false;
  for (const r of lines) {
    if (r.type === "user") sawUser = true;
    else if (r.type === "assistant" && sawUser) return true;
  }
  return false;
}

function findLast<T>(arr: T[], pred: (v: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return arr[i];
  }
  return undefined;
}

// CC writes user.message.content as a plain string; SDK writes it as a block
// array. Handle both.
function extractUserText(rec: ParsedRecord | undefined): string | null {
  if (!rec) return null;
  const content = rec.message && (rec.message as any).content;
  if (typeof content === "string") {
    return cleanUserText(content);
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join(" ")
      .trim();
    return cleanUserText(text);
  }
  return null;
}

// CC wraps slash commands like `/clear` as
//   <command-name>/clear</command-name> <command-message>clear</command-message> <command-args></command-args>
// Collapse that to just the command name. Other XML-ish wrappers
// (system-reminder, etc.) get stripped to their text content.
function cleanUserText(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^<local-command-caveat>/i.test(trimmed)) return null;
  if (/^<system-reminder>/i.test(trimmed)) return null;
  const cmd = trimmed.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) {
    const name = cmd[1].trim();
    const args = trimmed.match(/<command-args>([^<]*)<\/command-args>/)?.[1].trim() ?? "";
    const out = args ? `${name} ${args}` : name;
    return out.slice(0, 200) || null;
  }
  const stripped = trimmed.replace(/<\/?[a-z][^>]*>/gi, " ").replace(/\s+/g, " ").trim();
  return stripped ? stripped.slice(0, 200) : null;
}

function extractAssistantText(rec: ParsedRecord | undefined): string | null {
  if (!rec) return null;
  const blocks = rec.message && (rec.message as any).content;
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join(" ")
    .trim();
  return text ? text.slice(0, 200) : null;
}

// Find the most recent tool_use block whose id has no matching tool_result
// later in the tail window. That's the call the agent is either currently
// running, or blocked on (waiting for permission/approval). When the most
// recent tool_use has been answered with a tool_result, returns null —
// agent is between calls.
function extractPendingToolUse(lines: ParsedRecord[]): PendingToolUse | null {
  const resolvedIds = new Set<string>();
  for (const r of lines) {
    if (r.type !== "user") continue;
    const content = r.message && (r.message as any).content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        resolvedIds.add(b.tool_use_id);
      }
    }
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const r = lines[i];
    if (r.type !== "assistant") continue;
    const blocks = r.message && (r.message as any).content;
    if (!Array.isArray(blocks)) continue;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b?.type !== "tool_use" || typeof b.id !== "string") continue;
      if (resolvedIds.has(b.id)) return null; // most-recent call is resolved
      return {
        name: typeof b.name === "string" ? b.name : "tool",
        summary: summarizeToolInput(b.name, b.input),
      };
    }
  }
  return null;
}

function summarizeToolInput(name: unknown, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  if (name === "Bash") return String(i.command ?? "").slice(0, 160);
  if (name === "Read" || name === "Write") return String(i.file_path ?? "");
  if (name === "Edit" || name === "MultiEdit") {
    const op = i.replace_all ? " (replace_all)" : "";
    return `${i.file_path ?? ""}${op}`;
  }
  if (name === "Glob" || name === "Grep") return String(i.pattern ?? "");
  if (name === "TodoWrite") {
    const todos = Array.isArray(i.todos) ? i.todos.length : 0;
    return `${todos} todo${todos === 1 ? "" : "s"}`;
  }
  if (name === "WebFetch") return String(i.url ?? "");
  try {
    return JSON.stringify(i).slice(0, 140);
  } catch {
    return "";
  }
}

// Test seam.
export function _clearPreviewCache(): void {
  previewCache.clear();
}
