// Vekka RC-attached preload — fetch URL rewriter for Claude Code.
//
// Load via:
//   BUN_OPTIONS="--preload <abs-path>/cc-preload.js" claude
//
// What it does
// ------------
// Hooks globalThis.fetch and rewrites api.anthropic.com /worker/* URLs to
// the Vekka relay (default http://127.0.0.1:3000). All other fetch traffic
// — including /v1/messages?beta=true, /api/eval/*, /bridge (which actually
// uses axios under the hood, not fetch, and is unaffected either way) —
// passes through untouched.
//
// Liveness-gated
// --------------
// Probes the relay's /healthz on a background interval. When Vekka is down,
// the rewrite is skipped and worker traffic flows to api.anthropic.com just
// like a no-Vekka session (CC's "Remote Control on claude.ai/code/..." path
// keeps working). When Vekka comes up, the next probe tick flips the gate
// and subsequent worker fetches redirect to the relay.
//
// Defensive self-check
// --------------------
// If this preload accidentally loads into a Bun process that isn't CC
// (BUN_OPTIONS leakage), the script no-ops.

const RELAY = (process.env.VEKKA_RELAY_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const PROBE_INTERVAL_MS = 3000;
const PROBE_TIMEOUT_MS = 500;
const DISABLED = process.env.VEKKA_DISABLE_PRELOAD === "1";
const VERBOSE = process.env.VEKKA_PRELOAD_VERBOSE === "1";

// Only activate inside the CC binary. process.execPath looks like
// /Users/.../.local/share/claude/versions/<version> when CC launched us.
// (argv[0] is just "bun" on Bun-compiled binaries; execPath is the real
// host binary path.)
const isClaude = typeof process.execPath === "string" && process.execPath.includes("/claude/versions/");

if (!DISABLED && isClaude) {
  const origFetch = globalThis.fetch;
  let vekkaUp = false;

  const log = (msg) => {
    if (VERBOSE) process.stderr.write(`[vekka-preload] ${msg}\n`);
  };

  const isWorkerUrl = (url) =>
    typeof url === "string" &&
    url.startsWith("https://api.anthropic.com/v1/code/sessions/") &&
    url.includes("/worker");

  const rewrite = (url) => url.replace("https://api.anthropic.com", RELAY);

  const isConnError = (e) => {
    if (!e) return false;
    const code = e?.code || e?.cause?.code;
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND") return true;
    const msg = String(e?.message || e);
    return msg.includes("ECONNREFUSED") || msg.includes("Failed to connect") || msg.includes("ConnectionRefused");
  };

  // AbortSignal.timeout is Bun ≥0.6.3 / Node ≥17.3. Guard so older runtimes
  // don't throw synchronously every probe (which would silently pin
  // vekkaUp=false forever).
  const makeTimeoutSignal = () =>
    typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(PROBE_TIMEOUT_MS) : undefined;

  // Belt-and-suspenders timeout: even when AbortSignal.timeout is missing, we
  // must not let probe hang on the OS TCP connect timeout (~75-130s). Worker
  // fetches `await firstProbe`; a hung probe would freeze the CC session.
  const probe = async () => {
    try {
      const sig = makeTimeoutSignal();
      const fetchP = origFetch(`${RELAY}/healthz`, sig ? { signal: sig } : undefined);
      const timeoutP = new Promise((_, rej) => {
        const id = setTimeout(() => rej(new Error("probe timeout")), PROBE_TIMEOUT_MS);
        if (typeof id.unref === "function") id.unref();
      });
      const r = await Promise.race([fetchP, timeoutP]);
      const next = r.ok;
      if (next !== vekkaUp) log(`vekka ${next ? "up" : "down"}`);
      vekkaUp = next;
    } catch {
      if (vekkaUp) log("vekka down");
      vekkaUp = false;
    }
  };

  // Initial probe runs async; the first /worker/* fetch must wait for it to
  // settle, or it'll race past `vekkaUp` and land on anthropic — and for the
  // long-lived `/worker/events/stream` SSE that mistake sticks for the whole
  // session (no reconnect = no chance to redirect later).
  let firstProbeSettled = false;
  const firstProbe = probe().finally(() => { firstProbeSettled = true; });
  const t = setInterval(probe, PROBE_INTERVAL_MS);
  if (typeof t.unref === "function") t.unref();

  // Resolve fetch's `input` argument to a URL string. Accepts string, URL,
  // Request, and falls back to String() with logging if something else slips
  // through.
  const inputToUrl = (input) => {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input instanceof Request) return input.url;
    if (input && typeof input === "object") return input.url ?? input.href ?? String(input);
    return String(input);
  };

  globalThis.fetch = async function vekkaFetch(input, init) {
    const url = inputToUrl(input);

    if (!isWorkerUrl(url)) {
      return origFetch.call(this, input, init);
    }

    // Worker URL — block on initial probe so the SSE stream redirects right.
    if (!firstProbeSettled) {
      try { await firstProbe; } catch {}
    }

    if (!vekkaUp) {
      return origFetch.call(this, input, init);
    }

    const target = rewrite(url);
    log(`rewrite ${url} -> ${target}`);

    // For Request inputs, the body is a ReadableStream that can only be
    // consumed once. `new Request(target, input)` adopts (consumes) the body,
    // which would leave the original `input` "disturbed" and unusable for
    // the ECONNREFUSED fallback. Clone first so we have a fresh fallback
    // copy.
    let newInput;
    let fallbackInput = input;
    if (typeof input === "string") {
      newInput = target;
    } else if (input instanceof URL) {
      newInput = target;
    } else if (input instanceof Request) {
      // input.clone() throws TypeError if the body is already disturbed.
      // Should not happen in practice (we're the outermost wrapper, nothing
      // has touched the body yet), but if it does we lose the fallback path
      // rather than crashing the caller's fetch.
      try {
        fallbackInput = input.clone();
      } catch {
        fallbackInput = null;
      }
      newInput = new Request(target, input);
    } else {
      newInput = target;
    }

    try {
      return await origFetch.call(this, newInput, init);
    } catch (e) {
      if (isConnError(e) && fallbackInput !== null) {
        // Relay died between probes. Flip cached state and transparently
        // fall back to the original (un-rewritten) URL so the user's RC
        // session degrades to the Anthropic-hosted relay rather than
        // hard-failing.
        log(`rewritten fetch failed (${e?.code || e?.cause?.code || "conn"}) — falling back to anthropic`);
        vekkaUp = false;
        return origFetch.call(this, fallbackInput, init);
      }
      throw e;
    }
  };

  log(`installed (relay=${RELAY})`);
}
