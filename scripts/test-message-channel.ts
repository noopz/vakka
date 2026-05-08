import { MessageChannel } from "../src/agent/message-channel.js";

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const SESSION_ID = "test-session-001";

// ── Test 1: Buffered messages are yielded in order ───────────────────

{
  const ch = new MessageChannel(SESSION_ID);
  ch.yieldMessage("first");
  ch.yieldMessage("second");
  ch.yieldMessage("third");
  ch.close();

  const collected: string[] = [];
  for await (const msg of ch) {
    assert(msg.type === "user", "message type should be 'user'");
    assert(msg.session_id === SESSION_ID, "session_id should match");
    assert(msg.parent_tool_use_id === null, "parent_tool_use_id should be null");
    const content = msg.message.content;
    assert(typeof content === "string", "content should be a string");
    collected.push(content as string);
  }

  assert(collected.length === 3, `expected 3 messages, got ${collected.length}`);
  assert(collected[0] === "first", "first message should be 'first'");
  assert(collected[1] === "second", "second message should be 'second'");
  assert(collected[2] === "third", "third message should be 'third'");

  console.log("  Test 1 (buffered order): OK");
}

// ── Test 2: Awaiting next() blocks until yieldMessage() is called ────

{
  const ch = new MessageChannel(SESSION_ID);
  const iter = ch[Symbol.asyncIterator]();

  let resolved = false;
  const pending = iter.next().then((result) => {
    resolved = true;
    return result;
  });

  // Give the event loop a tick to confirm it hasn't resolved yet
  await new Promise((r) => setTimeout(r, 10));
  assert(!resolved, "next() should block when no messages are available");

  // Now push a message after 50ms
  setTimeout(() => ch.yieldMessage("delayed"), 50);

  const result = await pending;
  assert(resolved, "next() should have resolved after yieldMessage");
  assert(!result.done, "result should not be done");
  assert(
    (result.value.message.content as string) === "delayed",
    "content should be 'delayed'"
  );

  ch.close();
  const final = await iter.next();
  assert(final.done === true, "iterator should be done after close");

  console.log("  Test 2 (async blocking): OK");
}

// ── Test 3: close() ends iteration immediately when blocking ─────────

{
  const ch = new MessageChannel(SESSION_ID);
  const iter = ch[Symbol.asyncIterator]();

  let resolved = false;
  const pending = iter.next().then((result) => {
    resolved = true;
    return result;
  });

  await new Promise((r) => setTimeout(r, 10));
  assert(!resolved, "should be blocking");

  ch.close();
  const result = await pending;
  assert(resolved, "should have resolved after close");
  assert(result.done === true, "result should be done after close");

  console.log("  Test 3 (close while blocking): OK");
}

// ── Test 4: yieldMessage after close is silently ignored ─────────────

{
  const ch = new MessageChannel(SESSION_ID);
  ch.yieldMessage("before");
  ch.close();
  ch.yieldMessage("after"); // should be ignored

  const collected: string[] = [];
  for await (const msg of ch) {
    collected.push(msg.message.content as string);
  }

  assert(collected.length === 1, `expected 1 message, got ${collected.length}`);
  assert(collected[0] === "before", "only pre-close message should appear");

  console.log("  Test 4 (yield after close ignored): OK");
}

// ── Test 5: Interleaved push/pull ────────────────────────────────────

{
  const ch = new MessageChannel(SESSION_ID);
  const iter = ch[Symbol.asyncIterator]();

  // Buffer one, then pull
  ch.yieldMessage("a");
  const r1 = await iter.next();
  assert((r1.value.message.content as string) === "a", "should get 'a'");

  // Pull blocks, then push resolves it
  const p2 = iter.next();
  ch.yieldMessage("b");
  const r2 = await p2;
  assert((r2.value.message.content as string) === "b", "should get 'b'");

  // Buffer two, pull two
  ch.yieldMessage("c");
  ch.yieldMessage("d");
  const r3 = await iter.next();
  const r4 = await iter.next();
  assert((r3.value.message.content as string) === "c", "should get 'c'");
  assert((r4.value.message.content as string) === "d", "should get 'd'");

  ch.close();
  const r5 = await iter.next();
  assert(r5.done === true, "should be done");

  console.log("  Test 5 (interleaved push/pull): OK");
}

console.log("\nAll tests passed");
