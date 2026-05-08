// Server-only transcript (jsonl) decoder.
//
// Adapts CC's on-disk session jsonl records into the same NormalizedMessage[]
// wire format produced by `normalizeSdkEnvelope`. Replaces the legacy
// frontend-side `parseTranscriptRecord` so the bundle no longer carries
// SDK-shape decoding logic.
//
// Why this isn't just `normalizeSdkEnvelope` directly:
//   - jsonl records carry top-level `timestamp` / `uuid` / `parentUuid` /
//     `requestId` etc., whereas MQTT envelopes are wrapped in
//     `{ subtopic, data: { type, message, ... } }`.
//   - Records that aren't message rows (e.g. `attachment`, `permission-mode`,
//     `file-history-snapshot`, `summary`, `meta`) must be silently dropped.
//
// `transcriptRecordToEnvelope` does the trivial shape adaptation; the heavy
// lifting (text/tool_use/tool_result extraction, command-tag stripping, etc.)
// reuses the canonical `normalizeSdkEnvelope` implementation.

import type {
  NormalizedMessage,
  NormalizerContext,
  SdkEnvelope,
} from "../shared/message-types.js";
import {
  cleanCommandText as _cleanCommandText,
  normalizeSdkEnvelope,
  summarizeToolInput as _summarizeToolInput,
} from "./message-normalizer.js";

// Re-export for callers that want the same helpers (kept for parity with the
// normalizer's public surface; trivially tree-shakeable on the server).
export const cleanCommandText = _cleanCommandText;
export const summarizeToolInput = _summarizeToolInput;

/**
 * Convert a single jsonl record into the envelope shape `normalizeSdkEnvelope`
 * accepts. Returns `null` for non-message rows (these get skipped by the
 * caller; they have no NormalizedMessage representation).
 *
 * The on-disk shape mirrors the SDK MQTT `output` envelope's `data` payload
 * fairly closely:
 *   user record (tool_result):  { type:"user", message:{ role, content:[{type:"tool_result", ...}] } }
 *   user record (prompt):       { type:"user", message:{ role, content:"plain string" | [{type:"text"}] } }
 *   assistant record:           { type:"assistant", message:{ id, model, content, usage } }
 *
 * Routing:
 *   - assistant → subtopic:"output"
 *   - user with tool_result content → subtopic:"output"
 *   - user with plain-text content (string OR array of text blocks) →
 *     subtopic:"input" (synthesized as `{ text }` so `normalizeInput` runs
 *     the same caveat-stripping / compact-summary detection it does for live
 *     wrapper input envelopes).
 *
 * Anything else (`attachment`, `permission-mode`, `file-history-snapshot`,
 * `summary`, `meta`, …) → null. Records missing a `message` field also → null.
 */
export function transcriptRecordToEnvelope(record: any): any | null {
  if (!record || typeof record !== "object") return null;
  const t = record.type;
  if (t !== "user" && t !== "assistant") return null;
  if (!record.message || typeof record.message !== "object") return null;

  if (t === "assistant") {
    return {
      subtopic: "output",
      data: { type: "assistant", message: record.message },
    };
  }

  // user: distinguish tool_result batches from plain user prompts.
  const content = record.message.content;
  if (Array.isArray(content)) {
    const hasToolResult = content.some(
      (b) => b && typeof b === "object" && b.type === "tool_result",
    );
    if (hasToolResult) {
      return {
        subtopic: "output",
        data: { type: "user", message: record.message },
      };
    }
    // Array of text blocks (rare — usually a skill / hook injection that
    // got wrapped as a user turn). Concatenate text fields and treat as
    // a user prompt.
    const text = content
      .filter(
        (b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string",
      )
      .map((b) => b.text as string)
      .join("\n\n");
    if (!text) return null;
    return { subtopic: "input", data: { text } };
  }
  if (typeof content === "string") {
    if (!content) return null;
    return { subtopic: "input", data: { text: content } };
  }
  return null;
}

/**
 * Decode an array of jsonl records into a NormalizedMessage[].
 *
 * Two-pass: pass 1 walks every assistant record's tool_use blocks to populate
 * a name/summary map keyed by tool_use_id; pass 2 normalizes each record with
 * the populated map so tool_result rows (which may live in a different jsonl
 * record than their originating tool_use) carry the originating tool name +
 * input summary in the rendered output.
 *
 * `sessionId` is recorded on the per-record NormalizerContext (mostly for
 * future telemetry; the normalizer itself doesn't currently read it).
 */
export function decodeTranscript(
  records: any[],
  sessionId: string,
): NormalizedMessage[] {
  if (!Array.isArray(records) || records.length === 0) return [];

  const nameMap = new Map<string, string>();
  const summaryMap = new Map<string, string>();

  // Pass 1: collect tool_use id → name / summary across the whole batch so a
  // tool_result in record N can resolve a tool_use from record M < N.
  for (const rec of records) {
    if (!rec || rec.type !== "assistant") continue;
    const blocks = rec.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (!b || b.type !== "tool_use") continue;
      const id = typeof b.id === "string" ? b.id : "";
      if (!id) continue;
      const name = typeof b.name === "string" ? b.name : "Tool";
      nameMap.set(id, name);
      const summary = _summarizeToolInput(name, b.input);
      if (summary) summaryMap.set(id, summary);
    }
  }

  // Pass 2: normalize record by record. Each record gets its own timestamp
  // (parsed from the on-disk ISO string when present) but shares the
  // populated name/summary maps with all sibling records.
  const out: NormalizedMessage[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const envelope = transcriptRecordToEnvelope(rec) as SdkEnvelope | null;
    if (!envelope) continue;

    let ts = 0;
    if (typeof rec.timestamp === "string") {
      const parsed = Date.parse(rec.timestamp);
      if (Number.isFinite(parsed)) ts = parsed;
    } else if (typeof rec.timestamp === "number") {
      ts = rec.timestamp;
    }

    const recIndex = i;
    // Per-record counter — keeps fallback ids stable across re-decodes even
    // when prior records consumed fallbacks. A shared counter would cause
    // the same record to mint different ids on a second decode pass.
    let recFallbackSeq = 0;
    const ctx: NormalizerContext = {
      sessionId,
      nameMap,
      summaryMap,
      timestamp: ts,
      idFallback: () => `transcript-${recIndex}-${recFallbackSeq++}`,
    };
    const rows = normalizeSdkEnvelope(envelope, ctx);
    for (const row of rows) out.push(row);
  }
  // Ensure id uniqueness across the decoded set. The SDK reuses
  // `message.id` for every block within a single assistant envelope, so an
  // assistant text row and its sibling tool_use rows can share an id; the
  // frontend keys its render by id, which would collapse the duplicates.
  // Suffix collisions with `#n`. Tool pairing uses `toolUseId`, so this
  // doesn't affect correlation.
  const seen = new Map<string, number>();
  for (let i = 0; i < out.length; i++) {
    const baseId = out[i].id;
    const n = seen.get(baseId) ?? 0;
    if (n > 0) out[i] = { ...out[i], id: `${baseId}#${n}` } as NormalizedMessage;
    seen.set(baseId, n + 1);
  }
  return out;
}
