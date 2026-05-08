/**
 * Tier 1.5 integration tests for manager hot-restart with agent survival.
 *
 * Each test spawns the full vakka stack via run.ts, exercises one scenario,
 * and asserts via HTTP API + MQTT + process.kill(pid, 0).
 *
 * Tests run serially because the stack binds a fixed port and lockfile.
 *
 *   I1  — UI button (POST /api/system/restart-manager) preserves agent
 *   I3  — kill -9 on manager preserves agent (setsid payoff)
 *   I12 — SIGTERM directly to manager kills its agents (no orphans)
 *   I13 — SIGINT to run.ts cascades and kills agents (no orphans)
 *
 * Prereqs: Mosquitto running on localhost:1883. Real vakka must NOT be
 * running on the test ports — but the test uses isolated ports, DB path,
 * auth file, and lockfile, so it won't collide with `bun run scripts/run.ts`
 * on default settings.
 */

import { spawn, type Subprocess } from "bun";
import { readFileSync, rmSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import mqtt, { type MqttClient } from "mqtt";

const VAKKA_DIR = join(import.meta.dir, "..");
const WEB_PORT = "3199";
const DB_PATH = "/tmp/vakka-hotrestart-test.db";
const AUTH_PATH = "/tmp/vakka-hotrestart-auth.json";
const LOCK_PATH = "/tmp/vakka-hotrestart-run.lock";
const PROJECTS_ROOT = "/tmp/vakka-hotrestart-projects";
const TEST_PROJECT = join(PROJECTS_ROOT, "p1");
const BASE_URL = `http://localhost:${WEB_PORT}`;
const MQTT_URL = "mqtt://localhost:1883";

const TEST_ENV: Record<string, string> = {
  ...process.env,
  VAKKA_WEB_PORT: WEB_PORT,
  VAKKA_DB_PATH: DB_PATH,
  VAKKA_AUTH_TOKEN_PATH: AUTH_PATH,
  VAKKA_LOCK_PATH: LOCK_PATH,
};

const results: { name: string; passed: boolean; err?: string }[] = [];

function log(msg: string) { console.log(`[hot-restart] ${msg}`); }
function pass(name: string) { results.push({ name, passed: true }); log(`  ✓ ${name}`); }
function fail(name: string, err: string) { results.push({ name, passed: false, err }); log(`  ✗ ${name}: ${err}`); }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  label: string,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v !== null) return v;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForPidDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(50);
  }
  return false;
}

function readToken(): string {
  const data = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
  return data.token;
}

async function request(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${readToken()}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

interface Stack {
  proc: Subprocess;
  mqtt: MqttClient;
  startedAt: number; // managerStartedAt seen on first up beacon
}

async function startStack(): Promise<Stack> {
  const proc = spawn(
    ["bun", "run", join(VAKKA_DIR, "scripts", "run.ts")],
    {
      cwd: VAKKA_DIR,
      env: TEST_ENV,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // Stream output prefixed for debugging.
  void (async () => {
    if (!proc.stdout) return;
    const reader = (proc.stdout as ReadableStream).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        for (const line of text.split("\n")) {
          if (line.trim()) log(`    | ${line}`);
        }
      }
    } catch {}
  })();

  // If anything below fails, make sure we don't leak the subprocess.
  let client: MqttClient | null = null;
  try {
    // Wait for the auth token file to be written (manager creates it on startup).
    await pollUntil(async () => existsSync(AUTH_PATH) ? true : null, "auth token file", 15_000);

    // Wait for /api/health (with auth) to respond OK.
    await pollUntil(async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/health`, {
          headers: { Authorization: `Bearer ${readToken()}` },
        });
        if (res.ok) return true;
      } catch {}
      return null;
    }, "/api/health", 15_000);

    // Connect MQTT and capture initial manager_online up.
    client = mqtt.connect(MQTT_URL, { clientId: `hot-restart-test-${Date.now()}` });
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => reject(err);
      client!.once("connect", () => { client!.off("error", onErr); resolve(); });
      client!.once("error", onErr);
    });

    let startedAt = 0;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("manager_online up not seen within 10s")), 10_000);
      // Register the message handler BEFORE subscribe so retained messages
      // delivered immediately after SUBACK don't race with the listener add.
      const onMsg = (topic: string, payload: Buffer) => {
        if (topic !== "vakka/system/manager/online") return;
        try {
          const data = JSON.parse(payload.toString());
          if (data.status === "up" && typeof data.startedAt === "number") {
            startedAt = data.startedAt;
            client!.off("message", onMsg);
            clearTimeout(timeout);
            resolve();
          }
        } catch {}
      };
      client!.on("message", onMsg);
      client!.subscribe("vakka/system/manager/online");
    });

    return { proc, mqtt: client, startedAt };
  } catch (err) {
    // Clean up the subprocess and MQTT client we partially created.
    try { client?.end(true); } catch {}
    try { proc.kill("SIGINT"); } catch {}
    await Promise.race([proc.exited, sleep(15_000)]);
    if (isProcessAlive(proc.pid)) {
      try { proc.kill("SIGKILL"); } catch {}
      await proc.exited;
    }
    throw err;
  }
}

async function stopStack(stack: Stack): Promise<void> {
  try { stack.mqtt.end(true); } catch {}
  // SIGINT triggers run.ts shutdown cascade.
  try { stack.proc.kill("SIGINT"); } catch {}
  // run.ts shutdown waits for web (~5s) + manager — give it generous time.
  const exited = await Promise.race([
    stack.proc.exited.then(() => true),
    sleep(15_000).then(() => false),
  ]);
  if (!exited) {
    try { stack.proc.kill("SIGKILL"); } catch {}
    await stack.proc.exited;
  }
}

async function findManagerPid(): Promise<number> {
  // Identify the manager process belonging to THIS test by matching the env.
  // Default `pgrep -f` would also match the user's real vakka if running.
  // We use VAKKA_DB_PATH in env which appears in /proc-equivalent only on
  // Linux; on macOS we pgrep by command, then filter by checking lockfile.
  const pgrep = spawn(["pgrep", "-f", "src/manager/index.ts"], { stdout: "pipe" });
  const out = await new Response(pgrep.stdout).text();
  const pids = out.trim().split("\n").filter(Boolean).map((s) => parseInt(s, 10));
  // Prefer the lone match. If multiple, the test is colliding with real vakka.
  if (pids.length === 0) throw new Error("No manager process found");
  if (pids.length === 1) return pids[0];
  // Multiple matches — pick the highest PID (most recently spawned). This is
  // a heuristic; the cleaner fix is for the test environment to have nothing
  // else running.
  log(`  ! multiple manager PIDs found: ${pids.join(",")} — using highest`);
  return Math.max(...pids);
}

async function waitForNewManagerOnline(stack: Stack, oldStartedAt: number, timeoutMs = 15_000): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stack.mqtt.off("message", onMsg);
      reject(new Error(`Timed out waiting for new manager_online up (old startedAt=${oldStartedAt})`));
    }, timeoutMs);
    const onMsg = (topic: string, payload: Buffer) => {
      if (topic !== "vakka/system/manager/online") return;
      try {
        const data = JSON.parse(payload.toString());
        if (data.status === "up" && typeof data.startedAt === "number" && data.startedAt !== oldStartedAt) {
          clearTimeout(timeout);
          stack.mqtt.off("message", onMsg);
          resolve(data.startedAt);
        }
      } catch {}
    };
    stack.mqtt.on("message", onMsg);
  });
}

async function spawnAgent(): Promise<{ sessionId: string; pid: number }> {
  const r = await request("POST", "/api/sessions", { projectPath: TEST_PROJECT, model: "opus" });
  if (r.status !== 200) throw new Error(`spawn failed: status=${r.status} body=${JSON.stringify(r.data)}`);
  return { sessionId: r.data.sessionId ?? r.data.id, pid: r.data.pid };
}

// Block until the session reaches 'running' status. Without this, kill
// scenarios race the wrapper's first status publish — the manager's shutdown
// path filters by status and would skip a session still in 'starting'.
async function waitForRunning(sessionId: string, timeoutMs = 10_000): Promise<void> {
  await pollUntil(async () => {
    const r = await request("GET", `/api/sessions/${sessionId}`);
    if (r.status === 200 && r.data?.status === "running") return true;
    return null;
  }, `session ${sessionId.slice(0, 8)} → running`, timeoutMs, 100);
}

function ensureTestProject() {
  if (!existsSync(PROJECTS_ROOT)) mkdirSync(PROJECTS_ROOT, { recursive: true });
  if (!existsSync(TEST_PROJECT)) mkdirSync(TEST_PROJECT, { recursive: true });
}

function nukeArtifacts() {
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm", AUTH_PATH, LOCK_PATH]) {
    try { rmSync(f, { force: true }); } catch {}
  }
}

async function killSurvivors() {
  // Belt-and-suspenders: pkill anything that might reference our test paths.
  // Restricted to processes whose argv mentions VAKKA_LOCK_PATH or our DB path.
  const patterns = [LOCK_PATH, DB_PATH, AUTH_PATH];
  for (const p of patterns) {
    try { spawn(["pkill", "-9", "-f", p]); } catch {}
  }
  // Also kill any wrapper that references our test project root.
  try { spawn(["pkill", "-9", "-f", PROJECTS_ROOT]); } catch {}
  await sleep(200);
}

// ─── Tests ────────────────────────────────────────────────────────────────

async function testI1_uiButtonPreservesAgent(): Promise<void> {
  const name = "I1: UI button restart preserves agent PID";
  log(`\n→ ${name}`);
  let stack: Stack | null = null;
  try {
    stack = await startStack();
    const oldStartedAt = stack.startedAt;
    const { sessionId, pid: agentPid } = await spawnAgent();
    log(`  agent spawned, PID=${agentPid}`);
    if (!isProcessAlive(agentPid)) throw new Error("agent dead immediately after spawn");
    await waitForRunning(sessionId);

    const r = await request("POST", "/api/system/restart-manager");
    if (r.status !== 200) throw new Error(`restart-manager status=${r.status}`);
    log(`  restart-manager command accepted`);

    const newStartedAt = await waitForNewManagerOnline(stack, oldStartedAt);
    log(`  new manager up, startedAt ${oldStartedAt} → ${newStartedAt}`);
    if (!isProcessAlive(agentPid)) throw new Error(`agent PID ${agentPid} died across restart`);
    pass(name);
  } catch (err: any) {
    fail(name, err.message);
  } finally {
    if (stack) await stopStack(stack);
    await killSurvivors();
  }
}

async function testI3_sigkillManagerPreservesAgent(): Promise<void> {
  const name = "I3: kill -9 manager preserves agent PID";
  log(`\n→ ${name}`);
  let stack: Stack | null = null;
  try {
    stack = await startStack();
    const oldStartedAt = stack.startedAt;
    const { sessionId, pid: agentPid } = await spawnAgent();
    await waitForRunning(sessionId);
    const managerPid = await findManagerPid();
    log(`  manager PID=${managerPid}, agent PID=${agentPid}`);

    process.kill(managerPid, "SIGKILL");
    log(`  SIGKILL'd manager`);

    // Give run.ts time to respawn (2s backoff + startup).
    const newStartedAt = await waitForNewManagerOnline(stack, oldStartedAt, 20_000);
    log(`  new manager up, startedAt ${oldStartedAt} → ${newStartedAt}`);

    if (!isProcessAlive(agentPid)) throw new Error(`agent PID ${agentPid} did not survive kill -9 — setsid broken?`);
    pass(name);
  } catch (err: any) {
    fail(name, err.message);
  } finally {
    if (stack) await stopStack(stack);
    await killSurvivors();
  }
}

async function testI12_sigtermManagerKillsAgents(): Promise<void> {
  const name = "I12: SIGTERM to manager kills agents (no orphans)";
  log(`\n→ ${name}`);
  let stack: Stack | null = null;
  try {
    stack = await startStack();
    const { sessionId, pid: agentPid } = await spawnAgent();
    await waitForRunning(sessionId);
    const managerPid = await findManagerPid();
    log(`  manager PID=${managerPid}, agent PID=${agentPid}`);

    process.kill(managerPid, "SIGTERM");
    log(`  SIGTERM'd manager directly`);

    const dead = await waitForPidDead(agentPid, 5000);
    if (!dead) throw new Error(`agent PID ${agentPid} survived manager SIGTERM — orphan!`);
    log(`  agent died as expected`);
    pass(name);
  } catch (err: any) {
    fail(name, err.message);
  } finally {
    if (stack) await stopStack(stack);
    await killSurvivors();
  }
}

async function testI13_sigintRunTsKillsAgents(): Promise<void> {
  const name = "I13: SIGINT to run.ts cascades and kills agents";
  log(`\n→ ${name}`);
  let stack: Stack | null = null;
  try {
    stack = await startStack();
    const { sessionId, pid: agentPid } = await spawnAgent();
    await waitForRunning(sessionId);
    log(`  agent PID=${agentPid}`);

    // Skip the normal stopStack — we want to test the SIGINT cascade.
    try { stack.mqtt.end(true); } catch {}
    stack.proc.kill("SIGINT");

    // Wait for run.ts to finish its cascade.
    await Promise.race([
      stack.proc.exited,
      sleep(20_000),
    ]);
    if (isProcessAlive(stack.proc.pid)) throw new Error("run.ts didn't exit within 20s");

    // Now agent should be dead.
    const dead = await waitForPidDead(agentPid, 5000);
    if (!dead) throw new Error(`agent PID ${agentPid} survived run.ts SIGINT — orphan!`);
    log(`  agent died as expected, no orphans`);
    stack = null; // already stopped
    pass(name);
  } catch (err: any) {
    fail(name, err.message);
  } finally {
    if (stack) await stopStack(stack);
    await killSurvivors();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  log("Tier 1.5 hot-restart integration tests");
  log(`  WEB_PORT=${WEB_PORT}`);
  log(`  DB_PATH=${DB_PATH}`);
  log(`  LOCK_PATH=${LOCK_PATH}`);
  log("");

  // Verify Mosquitto is reachable.
  try {
    const probe = mqtt.connect(MQTT_URL, { connectTimeout: 2000, reconnectPeriod: 0 });
    await new Promise<void>((resolve, reject) => {
      probe.once("connect", () => { probe.end(true); resolve(); });
      probe.once("error", (err) => reject(err));
      setTimeout(() => reject(new Error("MQTT connect timeout")), 3000);
    });
  } catch (err: any) {
    log(`Mosquitto not reachable at ${MQTT_URL}: ${err.message}`);
    log(`Start it with: brew services start mosquitto`);
    process.exit(1);
  }

  // Clean slate.
  nukeArtifacts();
  await killSurvivors();
  ensureTestProject();

  await testI1_uiButtonPreservesAgent();
  await testI3_sigkillManagerPreservesAgent();
  await testI12_sigtermManagerKillsAgents();
  await testI13_sigintRunTsKillsAgents();

  // Final cleanup.
  await killSurvivors();
  nukeArtifacts();
  try { rmSync(PROJECTS_ROOT, { recursive: true, force: true }); } catch {}

  // Summary.
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  log("");
  log(`──────────────────────────────`);
  log(`  ${passed} passed, ${failed} failed`);
  for (const r of results) {
    if (!r.passed) log(`  ✗ ${r.name}: ${r.err}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  log(`Fatal: ${err.stack || err.message}`);
  process.exit(2);
});
