import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeTranscript,
  transcriptRecordToEnvelope,
} from "../src/manager/transcript-decoder.js";
import type { NormalizedMessage } from "../src/shared/message-types.js";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "transcript-jsonl");

function loadSampleRecords(): any[] {
  const text = readFileSync(join(FIXTURE_DIR, "sample.jsonl"), "utf8");
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    out.push(JSON.parse(line));
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
describe("transcriptRecordToEnvelope", () => {
  test("user record (plain string content) → input envelope", () => {
    // Plain user prompts route through the `input` subtopic so they pick up
    // the same caveat-stripping / compact-summary detection live wrapper
    // input envelopes get.
    const env = transcriptRecordToEnvelope({
      type: "user",
      message: { role: "user", content: "hi" },
      uuid: "u1",
    });
    expect(env).toEqual({ subtopic: "input", data: { text: "hi" } });
  });

  test("user record (tool_result content) → output envelope", () => {
    const env = transcriptRecordToEnvelope({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "ok" }],
      },
    });
    expect(env?.subtopic).toBe("output");
    expect(env?.data?.type).toBe("user");
  });

  test("user record (text-block array) → input envelope concatenated", () => {
    const env = transcriptRecordToEnvelope({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      },
    });
    expect(env).toEqual({
      subtopic: "input",
      data: { text: "hello\n\nworld" },
    });
  });

  test("assistant record → output envelope", () => {
    const env = transcriptRecordToEnvelope({
      type: "assistant",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    });
    expect(env?.subtopic).toBe("output");
    expect(env?.data?.type).toBe("assistant");
    expect(env?.data?.message?.id).toBe("msg_1");
  });

  test("non-message rows → null", () => {
    expect(transcriptRecordToEnvelope({ type: "attachment" })).toBeNull();
    expect(transcriptRecordToEnvelope({ type: "permission-mode" })).toBeNull();
    expect(
      transcriptRecordToEnvelope({ type: "file-history-snapshot" }),
    ).toBeNull();
    expect(transcriptRecordToEnvelope({ type: "summary" })).toBeNull();
    expect(transcriptRecordToEnvelope({ type: "meta" })).toBeNull();
  });

  test("user record without message → null", () => {
    expect(transcriptRecordToEnvelope({ type: "user" })).toBeNull();
    expect(
      transcriptRecordToEnvelope({ type: "user", message: null }),
    ).toBeNull();
  });

  test("garbage inputs → null", () => {
    expect(transcriptRecordToEnvelope(null)).toBeNull();
    expect(transcriptRecordToEnvelope(undefined)).toBeNull();
    expect(transcriptRecordToEnvelope("string")).toBeNull();
    expect(transcriptRecordToEnvelope(42)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("decodeTranscript", () => {
  test("empty / non-array input → []", () => {
    expect(decodeTranscript([], "sess")).toEqual([]);
    // @ts-expect-error — testing runtime guard
    expect(decodeTranscript(null, "sess")).toEqual([]);
    // @ts-expect-error — testing runtime guard
    expect(decodeTranscript(undefined, "sess")).toEqual([]);
  });

  test("skips non-message rows entirely", () => {
    const rows = decodeTranscript(
      [
        { type: "permission-mode", permissionMode: "plan" },
        { type: "attachment", attachment: {} },
        { type: "file-history-snapshot" },
        { type: "summary" },
      ],
      "sess",
    );
    expect(rows).toEqual([]);
  });

  test("two-pass tool_use → tool_result resolution across records", () => {
    // tool_use lives in record 0, tool_result lives in record 1. Decoder
    // must populate the tool name + summary for the result row even though
    // they're in different records.
    const rows = decodeTranscript(
      [
        {
          type: "assistant",
          message: {
            id: "m1",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_x",
                name: "Read",
                input: { file_path: "/tmp/a.txt" },
              },
            ],
          },
          timestamp: "2026-04-11T00:00:01.000Z",
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_x",
                content: "ok",
              },
            ],
          },
          timestamp: "2026-04-11T00:00:02.000Z",
        },
      ],
      "sess",
    );
    const result = rows.find(
      (r): r is Extract<NormalizedMessage, { kind: "tool_result" }> =>
        r.kind === "tool_result",
    );
    expect(result).toBeDefined();
    expect(result?.toolName).toBe("Read");
    expect(result?.toolSummary).toBe("/tmp/a.txt");
    expect(result?.toolUseId).toBe("toolu_x");
  });

  test("timestamps parsed from ISO record.timestamp", () => {
    const rows = decodeTranscript(
      [
        {
          type: "user",
          message: { role: "user", content: "hi" },
          timestamp: "2026-04-11T17:55:15.440Z",
        },
      ],
      "sess",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].timestamp).toBe(Date.parse("2026-04-11T17:55:15.440Z"));
  });

  test("malformed timestamp → 0 fallback", () => {
    const rows = decodeTranscript(
      [
        {
          type: "user",
          message: { role: "user", content: "hi" },
          timestamp: "not-a-date",
        },
      ],
      "sess",
    );
    expect(rows[0]?.timestamp).toBe(0);
  });

  test("decodes the captured sample.jsonl fixture", () => {
    const records = loadSampleRecords();
    expect(records.length).toBe(30);

    const rows = decodeTranscript(records, "45d81f08-7d17-42fb-b3b2-a971d81923d8");

    // At least the user / assistant records should yield rows.
    expect(rows.length).toBeGreaterThan(0);

    const kinds = new Set(rows.map((r) => r.kind));
    expect(kinds.has("user")).toBe(true);
    expect(kinds.has("assistant")).toBe(true);

    // Every tool_result row in the fixture should resolve to a real tool name
    // (not the "Tool" fallback) — every result has a matching tool_use earlier
    // in the same jsonl. Exercises the cross-record map.
    const toolResults = rows.filter((r) => r.kind === "tool_result");
    expect(toolResults.length).toBeGreaterThan(0);
    for (const tr of toolResults) {
      if (tr.kind !== "tool_result") continue;
      expect(tr.toolName).not.toBe("Tool");
      expect(tr.toolName.length).toBeGreaterThan(0);
    }

    // Row ids must be unique so the frontend's keyed render works.
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Timestamps must be ascending (jsonl is append-only) — at least
    // non-decreasing, since records may carry the same wall-clock ms.
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].timestamp === 0 || rows[i - 1].timestamp === 0) continue;
      expect(rows[i].timestamp).toBeGreaterThanOrEqual(rows[i - 1].timestamp);
    }
  });

  test("re-decoding the same input is deterministic", () => {
    const records = loadSampleRecords();
    const a = decodeTranscript(records, "sess");
    const b = decodeTranscript(records, "sess");
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].id).toBe(b[i].id);
      expect(a[i].kind).toBe(b[i].kind);
    }
  });
});
