import { initDatabase } from "../src/db/schema.js";
import {
  upsertProject,
  getProjects,
  getProject,
  updateProjectActivity,
  pinProject,
  createSession,
  getSession,
  getSessionsForProject,
  getActiveSessions,
  getAllSessions,
  updateSessionStatus,
  updateSessionPid,
  updateSessionCost,
  updateSessionActivity,
  insertMessage,
  getMessages,
  getLatestMessageId,
} from "../src/db/queries.js";

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// ── Setup ─────────────────────────────────────────────────────────────

const db = initDatabase(":memory:");

// ── Project CRUD ──────────────────────────────────────────────────────

// Insert projects
upsertProject(db, { path: "/home/user/proj-a", name: "Project A" });
upsertProject(db, { path: "/home/user/proj-b", name: "Project B", last_file_activity: "2026-01-02T00:00:00" });
upsertProject(db, { path: "/home/user/proj-c", name: "Project C", last_human_session: "2026-01-03T00:00:00" });

// getProject
const projA = getProject(db, "/home/user/proj-a");
assert(projA !== null, "getProject should find proj-a");
assert(projA!.name === "Project A", "project name should match");
assert(projA!.pinned === 0, "default pinned should be 0");

// getProject returns null for missing
assert(getProject(db, "/nonexistent") === null, "missing project should return null");

// Upsert overwrites
upsertProject(db, { path: "/home/user/proj-a", name: "Project A Updated" });
const projAUpdated = getProject(db, "/home/user/proj-a");
assert(projAUpdated!.name === "Project A Updated", "upsert should update name");

// updateProjectActivity
updateProjectActivity(db, "/home/user/proj-a", "2026-01-05T00:00:00");
const projAActivity = getProject(db, "/home/user/proj-a");
assert(projAActivity!.last_file_activity === "2026-01-05T00:00:00", "activity should be updated");

// pinProject
pinProject(db, "/home/user/proj-b", true);
const projBPinned = getProject(db, "/home/user/proj-b");
assert(projBPinned!.pinned === 1, "project should be pinned");

// ── Project ordering ─────────────────────────────────────────────────

const projects = getProjects(db);
assert(projects.length === 3, "should have 3 projects");
// proj-b is pinned, should be first
assert(projects[0].path === "/home/user/proj-b", "pinned project should be first");
// proj-c has last_human_session, should be second
assert(projects[1].path === "/home/user/proj-c", "project with human session should be second");
// proj-a has last_file_activity but no human session, should be third
assert(projects[2].path === "/home/user/proj-a", "project with only file activity should be third");

console.log("  Projects: OK");

// ── Session CRUD ──────────────────────────────────────────────────────

const sess1 = createSession(db, {
  id: "sess-001",
  project_path: "/home/user/proj-a",
  model: "sonnet",
  pid: 1234,
});
assert(sess1.id === "sess-001", "session id should match");
assert(sess1.status === "starting", "default status should be starting");
assert(sess1.pid === 1234, "pid should match");
assert(sess1.cost_usd === 0, "default cost should be 0");

const sess2 = createSession(db, {
  id: "sess-002",
  project_path: "/home/user/proj-a",
  model: "opus",
});
assert(sess2.pid === null, "pid should be null when not provided");

// getSession
assert(getSession(db, "sess-001") !== null, "should find session");
assert(getSession(db, "nonexistent") === null, "missing session should return null");

// getSessionsForProject
const projASessions = getSessionsForProject(db, "/home/user/proj-a");
assert(projASessions.length === 2, "proj-a should have 2 sessions");

// updateSessionStatus
updateSessionStatus(db, "sess-001", "running");
const sess1Running = getSession(db, "sess-001")!;
assert(sess1Running.status === "running", "status should be running");

// getActiveSessions
updateSessionStatus(db, "sess-002", "waiting_input");
const active = getActiveSessions(db);
assert(active.length === 2, "should have 2 active sessions");

// updateSessionPid
updateSessionPid(db, "sess-002", 5678);
assert(getSession(db, "sess-002")!.pid === 5678, "pid should be updated");

// updateSessionCost
updateSessionCost(db, "sess-001", 0.042);
assert(getSession(db, "sess-001")!.cost_usd === 0.042, "cost should be updated");

// updateSessionActivity
const beforeActivity = getSession(db, "sess-002")!.last_activity;
// Small delay to ensure timestamp difference
updateSessionActivity(db, "sess-002");
// Can't reliably test timestamp change in-memory with datetime('now'), just verify no error

// Complete a session and check active count
updateSessionStatus(db, "sess-001", "completed");
const activeAfter = getActiveSessions(db);
assert(activeAfter.length === 1, "should have 1 active session after completing one");

// getAllSessions
const allSessions = getAllSessions(db);
assert(allSessions.length === 2, "should have 2 total sessions");

console.log("  Sessions: OK");

// ── Message CRUD ──────────────────────────────────────────────────────

const msgId1 = insertMessage(db, { session_id: "sess-001", role: "user", content: "Hello" });
const msgId2 = insertMessage(db, { session_id: "sess-001", role: "assistant", content: "Hi there" });
const msgId3 = insertMessage(db, { session_id: "sess-001", role: "user", content: "How are you?" });

assert(msgId1 < msgId2, "message ids should be ascending");
assert(msgId2 < msgId3, "message ids should be ascending");

// getMessages - basic
const msgs = getMessages(db, "sess-001");
assert(msgs.length === 3, "should have 3 messages");
assert(msgs[0].role === "user", "first message role should be user");
assert(msgs[0].content === "Hello", "first message content should match");
assert(msgs[2].content === "How are you?", "third message content should match");

// getMessages - ordered by id ASC
assert(msgs[0].id < msgs[1].id, "messages should be ordered by id ASC");
assert(msgs[1].id < msgs[2].id, "messages should be ordered by id ASC");

// getMessages - pagination with afterId
const msgsAfter = getMessages(db, "sess-001", msgId1);
assert(msgsAfter.length === 2, "should have 2 messages after first");
assert(msgsAfter[0].id === msgId2, "first message after should be msgId2");

// getMessages - pagination with limit
const msgsLimited = getMessages(db, "sess-001", undefined, 2);
assert(msgsLimited.length === 2, "should have 2 messages with limit 2");

// getMessages - afterId + limit combined
const msgsAfterLimited = getMessages(db, "sess-001", msgId1, 1);
assert(msgsAfterLimited.length === 1, "should have 1 message with afterId+limit");
assert(msgsAfterLimited[0].id === msgId2, "should be the second message");

// getMessages - empty session
const msgsEmpty = getMessages(db, "sess-002");
assert(msgsEmpty.length === 0, "should have 0 messages for sess-002");

// getLatestMessageId
const latestId = getLatestMessageId(db, "sess-001");
assert(latestId === msgId3, "latest message id should be msgId3");

// getLatestMessageId - empty session
const latestEmpty = getLatestMessageId(db, "sess-002");
assert(latestEmpty === null, "latest message id for empty session should be null");

// Insert more messages to test pagination thoroughly
for (let i = 0; i < 10; i++) {
  insertMessage(db, { session_id: "sess-002", role: "user", content: `Message ${i}` });
}
const paginatedMsgs = getMessages(db, "sess-002", undefined, 5);
assert(paginatedMsgs.length === 5, "paginated should return exactly 5");
assert(paginatedMsgs[0].content === "Message 0", "first paginated message should be Message 0");
assert(paginatedMsgs[4].content === "Message 4", "last paginated message should be Message 4");

// Get next page
const page2 = getMessages(db, "sess-002", paginatedMsgs[4].id, 5);
assert(page2.length === 5, "second page should have 5 messages");
assert(page2[0].content === "Message 5", "first of page 2 should be Message 5");
assert(page2[4].content === "Message 9", "last of page 2 should be Message 9");

// No more pages
const page3 = getMessages(db, "sess-002", page2[4].id, 5);
assert(page3.length === 0, "third page should be empty");

console.log("  Messages: OK");

// ── Cleanup ───────────────────────────────────────────────────────────

db.close();

console.log("\nAll tests passed");
