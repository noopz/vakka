import { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  watch,
} from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";
import mqtt from "mqtt";
import { getConfig } from "../src/shared/config.js";
import {
  ensureAuthConfig,
  loadAuthConfig,
  loadMqttCreds,
} from "../src/web/auth.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VAKKA_ROOT = resolve(import.meta.dirname!, "..");
const AUTH_PATH = join(VAKKA_ROOT, "config", "auth.json");
const WEB_PORT = process.env.VAKKA_WEB_PORT ?? "3000";

const args = new Set(process.argv.slice(2));
const watchMode = args.has("--watch");
const verbose = args.has("--verbose") || args.has("-v");

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`${DIM}[vakka]${RESET}  ${msg}`);
}

function logError(msg: string) {
  console.log(`${RED}[vakka]${RESET}  ${msg}`);
}

function dots(label: string, maxWidth = 30): string {
  const pad = maxWidth - label.length;
  return `  ${label} ${"·".repeat(Math.max(pad, 2))} `;
}

async function exec(cmd: string[]): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const output = await new Response(proc.stdout).text();
  return { ok: code === 0, output: output.trim() };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lockfile — prevents two `run.ts` instances from racing on the same DB
// ---------------------------------------------------------------------------

const LOCK_PATH = process.env.VAKKA_LOCK_PATH ?? join(homedir(), ".vakka", "run.lock");

function acquireLock(): boolean {
  try {
    if (existsSync(LOCK_PATH)) {
      const heldBy = parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10);
      if (Number.isFinite(heldBy) && isProcessAlive(heldBy)) {
        logError(`vakka is already running (PID ${heldBy} holds ${LOCK_PATH})`);
        logError(`If that PID is wrong, remove the lockfile and retry.`);
        return false;
      }
      // Stale (process is dead) — overwrite below.
    }
    const dir = dirname(LOCK_PATH);
    if (!existsSync(dir)) {
      Bun.spawnSync(["mkdir", "-p", dir]);
    }
    writeFileSync(LOCK_PATH, String(process.pid));
    return true;
  } catch (err: any) {
    logError(`Failed to acquire lockfile: ${err.message}`);
    return false;
  }
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_PATH)) {
      const heldBy = parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10);
      if (heldBy === process.pid) unlinkSync(LOCK_PATH);
    }
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Line-by-line stream reader
// ---------------------------------------------------------------------------

// During startup, buffer log lines so they don't interleave with the banner
let startupComplete = false;
const startupBuffer: string[] = [];

function flushStartupBuffer() {
  startupComplete = true;
  for (const line of startupBuffer) {
    console.log(line);
  }
  startupBuffer.length = 0;
}

function emit(formatted: string) {
  if (startupComplete) {
    console.log(formatted);
  } else {
    startupBuffer.push(formatted);
  }
}

async function pipeOutput(
  stream: ReadableStream<Uint8Array>,
  prefix: string,
  opts: {
    onLine?: (line: string) => void;
  } = {},
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line) continue;
        // Filter DEBUG unless --verbose
        if (!verbose && line.includes("[DEBUG]")) continue;
        emit(`${prefix} ${line}`);
        opts.onLine?.(line);
      }
    }
    // Flush remaining buffer
    if (buffer) {
      emit(`${prefix} ${buffer}`);
      opts.onLine?.(buffer);
    }
  } catch {
    // Stream closed — child exited
  }
}

// ---------------------------------------------------------------------------
// Spawn a managed child process
// ---------------------------------------------------------------------------

interface ManagedProcess {
  name: string;
  proc: Subprocess;
  stdout: Promise<void>;
  stderr: Promise<void>;
}

function spawnChild(
  name: string,
  entrypoint: string,
  color: string,
  opts: {
    onLine?: (line: string) => void;
  } = {},
): ManagedProcess {
  // Manager is NEVER given Bun's --watch. The manager owns long-lived agent
  // child processes; SIGTERMing it on every file save (which is what --watch
  // does) would kill those agents. We instead drive manager restarts through
  // the explicit MQTT `restart_manager` command (preserves agents) — see the
  // file watcher in startManagerSourceWatcher() below. Web is stateless and
  // benefits from instant reload.
  const cmd = (watchMode && name !== "manager")
    ? ["bun", "run", "--watch", entrypoint]
    : ["bun", "run", entrypoint];

  const proc = Bun.spawn(cmd, {
    cwd: VAKKA_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const prefix = `${color}[${name.padEnd(7)}]${RESET}`;

  const stdout = pipeOutput(proc.stdout as ReadableStream<Uint8Array>, prefix, opts);
  const stderr = pipeOutput(proc.stderr as ReadableStream<Uint8Array>, prefix);

  return { name, proc, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Cleanup orphaned processes
// ---------------------------------------------------------------------------

async function cleanupOrphans() {
  // Only the manager and web server are recycled on each `run.ts` start.
  // Agent wrappers self-detach via setsid() and survive manager restarts —
  // killing them here would break hot-restart. Surviving wrappers are
  // reconciled by the manager on its next boot via the hello handshake.
  await exec(["pkill", "-f", "bun run src/(manager|web)/index\\.ts"]).catch(() => {});
  // Brief pause to let processes die
  await Bun.sleep(300);
}

// ---------------------------------------------------------------------------
// Check Mosquitto
// ---------------------------------------------------------------------------

async function checkMosquitto(): Promise<boolean> {
  const { ok } = await exec(["pgrep", "-x", "mosquitto"]);
  return ok;
}

// ---------------------------------------------------------------------------
// Bootstrap mosquitto: install vakka.conf, write vakka_passwd, restart broker
// if anything changed. Idempotent — no-op when already configured.
// macOS-only auto-bootstrap; on Linux the operator follows infra/README.md.
// ---------------------------------------------------------------------------

const MOSQ_ETC_MAC = "/opt/homebrew/etc/mosquitto";
const MOSQ_CONF_TARGET = `${MOSQ_ETC_MAC}/conf.d/vakka.conf`;
const MOSQ_CONF_SOURCE = join(VAKKA_ROOT, "infra", "mosquitto.conf");
const MOSQ_PASSWD_PATH =
  process.env.VAKKA_MQTT_PASSWD_PATH ?? `${MOSQ_ETC_MAC}/vakka_passwd`;

async function bootstrapMqtt(): Promise<boolean> {
  // Skip auto-bootstrap on Linux / non-Homebrew layouts; user follows README.
  if (!existsSync(MOSQ_ETC_MAC)) return true;

  let restartNeeded = false;

  // 1. Ensure auth.json exists (first-boot — manager hasn't run yet) and load
  //    it so MQTT creds are available below.
  ensureAuthConfig();
  loadAuthConfig();
  const creds = loadMqttCreds();

  // 2. Install / refresh /opt/homebrew/etc/mosquitto/conf.d/vakka.conf.
  const wantConf = readFileSync(MOSQ_CONF_SOURCE, "utf-8");
  const haveConf = existsSync(MOSQ_CONF_TARGET)
    ? readFileSync(MOSQ_CONF_TARGET, "utf-8")
    : null;
  if (haveConf !== wantConf) {
    mkdirSync(dirname(MOSQ_CONF_TARGET), { recursive: true });
    writeFileSync(MOSQ_CONF_TARGET, wantConf);
    restartNeeded = true;
  }

  // 3. Write/refresh vakka_passwd. mosquitto_passwd hashes are salted, so we
  //    can't compare hashes — use a sidecar marker file with the username
  //    fingerprint to skip re-running when nothing changed.
  const markerPath = `${MOSQ_PASSWD_PATH}.vakka-marker`;
  const wantMarker = `${creds.username}\n`;
  const haveMarker = existsSync(markerPath)
    ? readFileSync(markerPath, "utf-8")
    : null;
  if (
    !existsSync(MOSQ_PASSWD_PATH) ||
    haveMarker !== wantMarker
  ) {
    mkdirSync(dirname(MOSQ_PASSWD_PATH), { recursive: true });
    // mosquitto_passwd -c refuses to overwrite an existing file in recent
    // versions, so unlink first when refreshing creds.
    if (existsSync(MOSQ_PASSWD_PATH)) {
      try {
        unlinkSync(MOSQ_PASSWD_PATH);
      } catch {}
    }
    const result = spawnSync(
      "mosquitto_passwd",
      ["-b", "-c", MOSQ_PASSWD_PATH, creds.username, creds.password],
      { stdio: "pipe" },
    );
    if (result.error || result.status !== 0) {
      logError(
        `mosquitto_passwd failed: ${result.error?.message ?? `exit ${result.status}`}`,
      );
      logError("Install with: brew install mosquitto");
      return false;
    }
    writeFileSync(markerPath, wantMarker);
    restartNeeded = true;
  }

  if (restartNeeded) {
    process.stdout.write(dots("mosquitto config"));
    const result = spawnSync("brew", ["services", "restart", "mosquitto"], {
      stdio: "pipe",
    });
    if (result.status !== 0) {
      process.stdout.write(`${RED}restart failed${RESET}\n`);
      logError(
        "Could not restart mosquitto. Run manually: brew services restart mosquitto",
      );
      return false;
    }
    // Wait briefly for the broker to come back up.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await checkMosquitto()) {
        process.stdout.write(`${GREEN}refreshed${RESET}\n`);
        return true;
      }
    }
    process.stdout.write(`${RED}did not come back up${RESET}\n`);
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Read auth token for banner
// ---------------------------------------------------------------------------

function getAuthToken(): string | null {
  try {
    if (!existsSync(AUTH_PATH)) return null;
    const data = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
    return data.token ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;
let forceKill = false;
const children: ManagedProcess[] = [];

async function shutdown() {
  if (forceKill) {
    logError("Force killing all processes...");
    for (const child of children) {
      try { child.proc.kill(9); } catch {}
    }
    process.exit(1);
  }

  if (shuttingDown) {
    forceKill = true;
    logError("Press Ctrl+C again to force kill");
    return;
  }

  shuttingDown = true;
  console.log("");
  log("Shutting down...");

  // Shutdown in reverse order: web first, then manager. The manager's own
  // SIGTERM handler kills its agent children — we don't reap them here.
  for (const child of [...children].reverse()) {
    const label = dots(child.name);
    try {
      child.proc.kill();
      const exited = await Promise.race([
        child.proc.exited,
        Bun.sleep(child.name === "manager" ? 10_000 : 5_000).then(() => null),
      ]);
      if (exited === null) {
        child.proc.kill(9);
        await child.proc.exited;
        process.stdout.write(`${label}${RED}killed${RESET}\n`);
      } else {
        process.stdout.write(`${label}stopped\n`);
      }
    } catch {
      process.stdout.write(`${label}already dead\n`);
    }
  }

  // Last line of defense: if the manager is dead (crashed, gave up, was
  // already gone), agents have lost their supervisor. Reap any sessions still
  // marked active in the DB so we never leave orphans behind. If the manager
  // exited cleanly, it killed its agents itself and this loop is a no-op.
  try {
    const cfg = getConfig();
    if (existsSync(cfg.dbPath)) {
      const db = new Database(cfg.dbPath, { readonly: true });
      const rows = db
        .query(
          "SELECT id, pid FROM sessions WHERE status IN ('running', 'waiting_permission', 'waiting_input')",
        )
        .all() as { id: string; pid: number | null }[];
      db.close();
      let reaped = 0;
      for (const row of rows) {
        if (row.pid != null && isProcessAlive(row.pid)) {
          try { process.kill(row.pid, "SIGTERM"); reaped++; } catch {}
        }
      }
      if (reaped > 0) log(`Reaped ${reaped} orphan agent process(es)`);
    }
  } catch (err: any) {
    logError(`Final agent reap failed: ${err.message}`);
  }

  releaseLock();
  log("Stopped.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Auto-restart logic
// ---------------------------------------------------------------------------

interface RestartState {
  crashes: number;
  lastCrash: number;
  delay: number;
}

const restartStates = new Map<string, RestartState>();

function getRestartState(name: string): RestartState {
  let state = restartStates.get(name);
  if (!state) {
    state = { crashes: 0, lastCrash: 0, delay: 2000 };
    restartStates.set(name, state);
  }
  return state;
}

async function watchProcess(
  child: ManagedProcess,
  entrypoint: string,
  color: string,
  readyMarker: string,
) {
  const code = await child.proc.exited;
  if (shuttingDown) return;

  // Exit code 42 is the manager's graceful hot-restart sentinel. It means the
  // manager preserved its agents and asked us to respawn it — bypass the
  // crash counter and skip the backoff delay.
  const isManagerHotRestart = child.name === "manager" && code === 42;
  if (isManagerHotRestart) {
    log("manager: graceful restart (exit 42), respawning...");
  } else {
    const state = getRestartState(child.name);
    const now = Date.now();

    // Reset crash counter if stable for 60s
    if (now - state.lastCrash > 60_000) {
      state.crashes = 0;
      state.delay = 2000;
    }

    state.crashes++;
    state.lastCrash = now;

    if (state.crashes >= 5) {
      logError(`${child.name} crashed ${state.crashes} times, giving up`);
      await shutdown();
      return;
    }

    logError(`${child.name} exited (code ${code}), restarting in ${state.delay / 1000}s...`);
    state.delay = Math.min(state.delay * 2, 30_000);

    await Bun.sleep(state.delay);
  }
  if (shuttingDown) return;

  // Respawn
  let readyResolve: ((line: string) => void) | null = null;
  const newChild = spawnChild(child.name, entrypoint, color, {
    onLine: (line) => readyResolve?.(line),
  });

  // Replace in children array
  const idx = children.indexOf(child);
  if (idx >= 0) children[idx] = newChild;

  // Wait for ready
  const readyPromise = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 10_000);
    readyResolve = (line: string) => {
      if (line.includes(readyMarker)) {
        clearTimeout(timeout);
        resolve(true);
      }
    };
    newChild.proc.exited.then(() => {
      clearTimeout(timeout);
      resolve(false);
    });
  });

  const ready = await readyPromise;
  if (ready) {
    log(`${child.name} restarted successfully`);
    getRestartState(child.name); // reset tracking on success
  }

  // Continue watching
  watchProcess(newChild, entrypoint, color, readyMarker);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(`  ${BOLD}vakka${RESET}${watchMode ? ` ${DIM}(watch mode)${RESET}` : ""}`);
  console.log("");

  // 0. Acquire the run lockfile. Without this, two `run.ts` invocations would
  //    spawn duplicate managers double-processing every command — and since
  //    agents now persist across run.ts re-runs, that mess would leak.
  if (!acquireLock()) {
    process.exit(1);
  }

  // 1. Cleanup orphans
  await cleanupOrphans();

  // 2. Bootstrap mosquitto config + passwd file (idempotent, macOS-only auto).
  if (!(await bootstrapMqtt())) {
    process.exit(1);
  }

  // 3. Check Mosquitto is running.
  process.stdout.write(dots("mosquitto"));
  if (await checkMosquitto()) {
    process.stdout.write(`${GREEN}ok${RESET}\n`);
  } else {
    process.stdout.write(`${RED}not running${RESET}\n`);
    logError("Start Mosquitto first: brew services start mosquitto");
    process.exit(1);
  }

  // 3. Spawn manager
  process.stdout.write(dots("manager"));

  let managerReadyResolve: ((line: string) => void) | null = null;
  const manager = spawnChild("manager", "src/manager/index.ts", CYAN, {
    onLine: (line) => managerReadyResolve?.(line),
  });
  children.push(manager);

  const managerReady = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 10_000);
    managerReadyResolve = (line: string) => {
      if (line.includes("Agent manager started")) {
        clearTimeout(timeout);
        resolve(true);
      }
    };
    manager.proc.exited.then(() => {
      clearTimeout(timeout);
      resolve(false);
    });
  });

  if (await managerReady) {
    process.stdout.write(`${GREEN}ok${RESET}\n`);
  } else {
    process.stdout.write(`${RED}failed${RESET}\n`);
    logError("Manager failed to start. Check logs above.");
    await shutdown();
    return;
  }

  // 4a. Build frontend bundle. In watch mode, spawn the builder as a long-lived
  //     child that rebuilds on source changes. In one-shot mode, build once
  //     synchronously before web starts so it serves a fresh bundle.
  process.stdout.write(dots("frontend"));
  if (watchMode) {
    // Spawn the frontend builder with its own --watch (esbuild context), NOT
    // Bun's --watch — Bun would re-exec on edits to build-frontend.ts itself.
    const proc = Bun.spawn(["bun", "run", "scripts/build-frontend.ts", "--watch"], {
      cwd: VAKKA_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    const prefix = `${DIM}[frontend]${RESET}`;
    const stdout = pipeOutput(proc.stdout as ReadableStream<Uint8Array>, prefix);
    const stderr = pipeOutput(proc.stderr as ReadableStream<Uint8Array>, prefix);
    children.push({ name: "frontend", proc, stdout, stderr });
    // build-frontend.ts in watch mode prints an initial build line; we don't
    // gate web startup on it since esbuild's first build is fast and the
    // dist/ files written by a previous run are also fine.
    process.stdout.write(`${GREEN}watching${RESET}\n`);
  } else {
    const built = await exec(["bun", "run", "scripts/build-frontend.ts"]);
    if (!built.ok) {
      process.stdout.write(`${RED}failed${RESET}\n`);
      logError(built.output);
      process.exit(1);
    }
    process.stdout.write(`${GREEN}built${RESET}\n`);
  }

  // 4b. Spawn web
  process.stdout.write(dots("web"));

  let webReadyResolve: ((line: string) => void) | null = null;
  const web = spawnChild("web", "src/web/index.ts", GREEN, {
    onLine: (line) => webReadyResolve?.(line),
  });
  children.push(web);

  const webReady = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 10_000);
    webReadyResolve = (line: string) => {
      if (line.includes("listening on port")) {
        clearTimeout(timeout);
        resolve(true);
      }
    };
    web.proc.exited.then(() => {
      clearTimeout(timeout);
      resolve(false);
    });
  });

  if (await webReady) {
    process.stdout.write(`${GREEN}ok${RESET}\n`);
  } else {
    process.stdout.write(`${RED}failed${RESET}\n`);
    logError("Web server failed to start. Check logs above.");
    await shutdown();
    return;
  }

  // 5. Banner
  console.log("");
  const token = getAuthToken();
  console.log(`  ${BOLD}http://localhost:${WEB_PORT}${RESET}`);
  if (token) console.log(`  ${DIM}token: ${token.slice(0, 8)}...${RESET}`);
  console.log("");
  console.log(`  ${DIM}Ctrl+C to stop${RESET}`);
  console.log(`  ${DIM}${"─".repeat(35)}${RESET}`);
  console.log("");

  // 6. Flush buffered startup logs
  flushStartupBuffer();

  // 7. Watch for unexpected exits
  watchProcess(manager, "src/manager/index.ts", CYAN, "Agent manager started");
  watchProcess(web, "src/web/index.ts", GREEN, "listening on port");

  // 8. In --watch mode, watch the manager's source tree ourselves and trigger
  //    a hot-restart over MQTT on changes. We can't use Bun's --watch on the
  //    manager because that SIGTERMs it, which would kill its agent children.
  if (watchMode) {
    startManagerSourceWatcher();
  }
}

// ---------------------------------------------------------------------------
// Manager source watcher (--watch mode only)
// ---------------------------------------------------------------------------

function startManagerSourceWatcher() {
  const mqttHost = process.env.VAKKA_MQTT_HOST ?? "mqtt://localhost:1883";
  const watcher = mqtt.connect(mqttHost, {
    clientId: `vakka-runner-${process.pid}`,
    reconnectPeriod: 1000,
  });

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const trigger = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      log("manager source changed, requesting hot-restart...");
      watcher.publish(
        "vakka/commands/restart_manager",
        JSON.stringify({
          commandId: crypto.randomUUID(),
          source: "watcher",
          requestedAt: Date.now(),
        }),
      );
    }, 200);
  };

  // Watching shared/ and db/ too because the manager imports from them.
  for (const dir of ["src/manager", "src/shared", "src/db"]) {
    const fullPath = join(VAKKA_ROOT, dir);
    if (!existsSync(fullPath)) continue;
    try {
      watch(fullPath, { recursive: true }, (_event, filename) => {
        if (filename && filename.endsWith(".ts")) trigger();
      });
    } catch (err: any) {
      logError(`watcher: failed to watch ${dir}: ${err.message}`);
    }
  }

  log("manager source watcher armed (src/manager, src/shared, src/db)");
}

main().catch((err) => {
  logError(`Fatal: ${err.message}`);
  process.exit(1);
});
