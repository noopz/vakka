import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listExternalCandidates,
  _clearPreviewCache,
} from "../src/manager/external-transcripts.js";

// We can't easily intercept ~/.claude/projects/<key>/, so we build a fake
// HOME by copying jsonls into a temp dir whose layout mimics the real one,
// and exercise listExternalCandidates against it via projectKeyForCwd.

let tmpRoot: string;
let fakeProjectsDir: string;

const PROJECT_PATH = "/Users/test/proj";
const PROJECT_KEY = "-Users-test-proj";

function jsonl(records: object[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vakka-ext-"));
  fakeProjectsDir = join(tmpRoot, PROJECT_KEY);
  mkdirSync(fakeProjectsDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeJsonl(uuid: string, records: object[]): string {
  const path = join(fakeProjectsDir, `${uuid}.jsonl`);
  writeFileSync(path, jsonl(records));
  return path;
}

describe("listExternalCandidates", () => {
  test("returns candidates with correct user/assistant text and message_count", async () => {
    _clearPreviewCache();
    const uuid = "11111111-1111-4111-8111-111111111111";
    makeJsonl(uuid, [
      { type: "user", sessionId: uuid, cwd: PROJECT_PATH, message: { content: "hello there" } },
      {
        type: "assistant",
        sessionId: uuid,
        message: { content: [{ type: "text", text: "general kenobi" }] },
      },
    ]);

    const list = await listExternalCandidates(PROJECT_PATH, { projectsRoot: tmpRoot });
    expect(list).toHaveLength(1);
    const c = list[0];
    expect(c.sdk_session_id).toBe(uuid);
    expect(c.last_user_text).toBe("hello there");
    expect(c.last_assistant_text).toBe("general kenobi");
    expect(c.message_count).toBe(2);
    expect(c.cwd).toBe(PROJECT_PATH);
  });

  test("handles SDK-shape (block-array) user content", async () => {
    _clearPreviewCache();
    const uuid = "22222222-2222-4222-8222-222222222222";
    makeJsonl(uuid, [
      {
        type: "user",
        sessionId: uuid,
        cwd: PROJECT_PATH,
        message: { content: [{ type: "text", text: "block-shape user" }] },
      },
      {
        type: "assistant",
        sessionId: uuid,
        message: { content: [{ type: "text", text: "ack" }] },
      },
    ]);
    const list = await listExternalCandidates(PROJECT_PATH, { projectsRoot: tmpRoot });
    const c = list.find((x) => x.sdk_session_id === uuid)!;
    expect(c.last_user_text).toBe("block-shape user");
  });

  test("skips files whose embedded cwd disagrees with projectPath", async () => {
    _clearPreviewCache();
    const uuid = "33333333-3333-4333-8333-333333333333";
    makeJsonl(uuid, [
      { type: "user", sessionId: uuid, cwd: "/somewhere/else", message: { content: "wrong cwd" } },
      { type: "assistant", sessionId: uuid, message: { content: [{ type: "text", text: "x" }] } },
    ]);
    const list = await listExternalCandidates(PROJECT_PATH, { projectsRoot: tmpRoot });
    expect(list.find((c) => c.sdk_session_id === uuid)).toBeUndefined();
  });

  test("liveness flag set when mtime is recent", async () => {
    _clearPreviewCache();
    const uuid = "44444444-4444-4444-8444-444444444444";
    makeJsonl(uuid, [
      { type: "user", sessionId: uuid, cwd: PROJECT_PATH, message: { content: "live" } },
      { type: "assistant", sessionId: uuid, message: { content: [{ type: "text", text: "y" }] } },
    ]);
    const listLive = await listExternalCandidates(PROJECT_PATH, { projectsRoot: tmpRoot });
    expect(listLive.find((c) => c.sdk_session_id === uuid)?.live).toBe(true);
    const listStale = await listExternalCandidates(PROJECT_PATH, {
      projectsRoot: tmpRoot,
      now: Date.now() + 120_000,
    });
    expect(listStale.find((c) => c.sdk_session_id === uuid)?.live).toBe(false);
  });

  test("respects maxAgeDays cutoff via now override", async () => {
    _clearPreviewCache();
    const uuid = "55555555-5555-4555-8555-555555555555";
    makeJsonl(uuid, [
      { type: "user", sessionId: uuid, cwd: PROJECT_PATH, message: { content: "old" } },
      { type: "assistant", sessionId: uuid, message: { content: [{ type: "text", text: "z" }] } },
    ]);
    // Pretend "now" is 60 days in the future — file falls outside 30-day window.
    const list = await listExternalCandidates(PROJECT_PATH, {
      projectsRoot: tmpRoot,
      now: Date.now() + 60 * 24 * 60 * 60 * 1000,
    });
    expect(list.find((c) => c.sdk_session_id === uuid)).toBeUndefined();
  });

  test("tail expansion finds user/assistant pair in large file with leading attachments", async () => {
    _clearPreviewCache();
    const uuid = "66666666-6666-4666-8666-666666666666";
    // Build a ~200KB file: lots of attachment records up front, then a single
    // user/assistant pair near the end. The 64KB initial window won't reach
    // the user record at start, but expansion should.
    const records: object[] = [];
    for (let i = 0; i < 100; i++) {
      records.push({
        type: "attachment",
        sessionId: uuid,
        payload: "x".repeat(2000),
      });
    }
    records.push({
      type: "user",
      sessionId: uuid,
      cwd: PROJECT_PATH,
      message: { content: "needle in the tail" },
    });
    records.push({
      type: "assistant",
      sessionId: uuid,
      message: { content: [{ type: "text", text: "found it" }] },
    });
    makeJsonl(uuid, records);

    const list = await listExternalCandidates(PROJECT_PATH, { projectsRoot: tmpRoot });
    const c = list.find((x) => x.sdk_session_id === uuid)!;
    expect(c.last_user_text).toBe("needle in the tail");
    expect(c.last_assistant_text).toBe("found it");
  });

  test("limit caps the number of candidates returned", async () => {
    _clearPreviewCache();
    for (let i = 0; i < 5; i++) {
      const uuid = `7${i}777777-7777-4777-8777-777777777777`;
      makeJsonl(uuid, [
        { type: "user", sessionId: uuid, cwd: PROJECT_PATH, message: { content: `q${i}` } },
        { type: "assistant", sessionId: uuid, message: { content: [{ type: "text", text: "a" }] } },
      ]);
    }
    const list = await listExternalCandidates(PROJECT_PATH, { projectsRoot: tmpRoot, limit: 3 });
    expect(list.length).toBeLessThanOrEqual(3);
  });

  test("returns empty array when project dir does not exist", async () => {
    _clearPreviewCache();
    const list = await listExternalCandidates("/nonexistent/path/qwertyuiop", { projectsRoot: tmpRoot });
    expect(list).toEqual([]);
  });
});
