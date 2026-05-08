import type { Request, Response, NextFunction } from "express";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as crypto from "node:crypto";
import { getConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  name: string;
  secret: string;
  status: "trusted" | "pending" | "revoked";
  created: string;
  lastSeen: string | null;
}

export interface MqttCreds {
  username: string;
  password: string;
}

export interface AuthConfig {
  token: string;
  devices: Record<string, DeviceInfo>;
  pairingMode: boolean;
  mqtt?: MqttCreds;
}

// ---------------------------------------------------------------------------
// Auth config persistence
// ---------------------------------------------------------------------------

let cachedConfig: AuthConfig | null = null;

// Idempotent: creates the auth config file with a fresh token + MQTT creds if
// it doesn't exist. Safe to call from any process; both manager and run.ts use
// it to avoid first-boot ordering races (web tries to load before manager has
// run).
export function ensureAuthConfig(): void {
  const config = getConfig();
  if (existsSync(config.authTokenPath)) return;
  const token =
    crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  mkdirSync(dirname(config.authTokenPath), { recursive: true });
  const mqtt = generateMqttCreds();
  writeFileSync(
    config.authTokenPath,
    JSON.stringify(
      { token: token.slice(0, 64), devices: {}, pairingMode: true, mqtt },
      null,
      2,
    ),
  );
  logger.info("auth", `Auth token written to ${config.authTokenPath}`);
}

export function loadAuthConfig(): AuthConfig {
  if (cachedConfig) return cachedConfig;
  const config = getConfig();
  try {
    const data = JSON.parse(readFileSync(config.authTokenPath, "utf-8"));
    // Migrate legacy config that only has { token }
    if (!data.devices) data.devices = {};
    // pairingMode field migration:
    //   - If field is absent and devices is empty → fresh config, default true
    //     (bootstrap mode: first device can self-trust).
    //   - If field is absent but devices exist → existing deployment, default
    //     false (operator must explicitly opt-in to add new devices).
    if (typeof data.pairingMode !== "boolean") {
      data.pairingMode = Object.keys(data.devices).length === 0;
    }
    // Backfill MQTT creds for upgraded installs that pre-date broker auth.
    let mqttBackfilled = false;
    if (
      !data.mqtt ||
      typeof data.mqtt.username !== "string" ||
      typeof data.mqtt.password !== "string"
    ) {
      data.mqtt = generateMqttCreds();
      mqttBackfilled = true;
    }
    cachedConfig = data as AuthConfig;
    if (mqttBackfilled) {
      saveAuthConfig(cachedConfig);
      logger.info("auth", "Backfilled MQTT creds into auth config");
    }
    return cachedConfig;
  } catch (err) {
    logger.error("auth", "Failed to load auth config", err);
    throw new Error("Auth config not found — run the agent manager first to generate it");
  }
}

export function saveAuthConfig(config: AuthConfig): void {
  const appConfig = getConfig();
  mkdirSync(dirname(appConfig.authTokenPath), { recursive: true });
  writeFileSync(appConfig.authTokenPath, JSON.stringify(config, null, 2), "utf-8");
  cachedConfig = config;
}

// Legacy helper — still used by index.ts for the startup log
export function loadToken(): string {
  return loadAuthConfig().token;
}

// ---------------------------------------------------------------------------
// MQTT credential helpers
// ---------------------------------------------------------------------------

function generateHex(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateMqttCreds(): MqttCreds {
  return {
    username: `vakka_mqtt_${generateHex(3)}`, // 6 hex chars
    password: generateHex(32), // 64 hex chars
  };
}

export function loadMqttCreds(): MqttCreds {
  const config = loadAuthConfig();
  if (!config.mqtt) {
    throw new Error(
      "MQTT credentials not initialized in auth config — start the manager first to generate them",
    );
  }
  return config.mqtt;
}

// Test-only: clear cached config so the next loadAuthConfig() re-reads from disk.
export function _resetAuthCacheForTests(): void {
  cachedConfig = null;
}

// ---------------------------------------------------------------------------
// Debounced lastSeen writes
// ---------------------------------------------------------------------------
//
// Authenticated request paths used to call saveAuthConfig() on every hit just
// to update DeviceInfo.lastSeen. That was a synchronous JSON file write per
// request. Instead, buffer mutations in-memory and flush periodically + on
// process exit.

const pendingLastSeen: Map<string, string> = new Map();

function recordLastSeen(deviceId: string, iso: string): void {
  pendingLastSeen.set(deviceId, iso);
}

export function flushLastSeen(): void {
  if (pendingLastSeen.size === 0) return;
  let config: AuthConfig;
  try {
    config = loadAuthConfig();
  } catch {
    // Auth config not loadable (e.g. during shutdown or tests where path was
    // torn down) — drop pending entries silently.
    pendingLastSeen.clear();
    return;
  }
  let mutated = false;
  for (const [deviceId, iso] of pendingLastSeen) {
    const device = config.devices[deviceId];
    if (device) {
      device.lastSeen = iso;
      mutated = true;
    }
  }
  pendingLastSeen.clear();
  if (mutated) {
    try {
      saveAuthConfig(config);
    } catch (err) {
      logger.error("auth", "Failed to flush lastSeen", err);
    }
  }
}

let flushTimer: ReturnType<typeof setInterval> | null = null;
let exitHandlersRegistered = false;

function ensureFlushScheduler(): void {
  if (flushTimer === null) {
    flushTimer = setInterval(flushLastSeen, 30_000);
    // Don't keep the event loop alive solely for this timer.
    (flushTimer as { unref?: () => void }).unref?.();
  }
  if (!exitHandlersRegistered) {
    const onExit = () => {
      try {
        flushLastSeen();
      } catch {
        // best-effort during shutdown
      }
    };
    process.on("exit", onExit);
    process.on("SIGTERM", onExit);
    process.on("SIGINT", onExit);
    exitHandlersRegistered = true;
  }
}

ensureFlushScheduler();

// Test-only helpers
export function _flushLastSeenForTests(): void {
  flushLastSeen();
}

export function _resetLastSeenBufferForTests(): void {
  pendingLastSeen.clear();
}

export function _getPendingLastSeenForTests(): Map<string, string> {
  return pendingLastSeen;
}

// Pairing-mode accessors
export function getPairingMode(): boolean {
  return loadAuthConfig().pairingMode;
}

export function setPairingMode(enabled: boolean): boolean {
  const config = loadAuthConfig();
  config.pairingMode = enabled;
  saveAuthConfig(config);
  logger.info("auth", `Pairing mode ${enabled ? "enabled" : "disabled"}`);
  return config.pairingMode;
}

// ---------------------------------------------------------------------------
// Device management
// ---------------------------------------------------------------------------

function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type RegisterDeviceResult =
  | { deviceId: string; secret: string; status: "trusted" | "pending" }
  | { status: "rejected"; error: string };

export function registerDevice(name: string): RegisterDeviceResult {
  const config = loadAuthConfig();
  const hasDevices = Object.keys(config.devices).length > 0;

  // First device: bootstrap path. Auto-trust and disable pairing mode so
  // subsequent registrations require explicit operator opt-in.
  if (!hasDevices) {
    const deviceId = crypto.randomUUID();
    const secret = generateSecret();
    config.devices[deviceId] = {
      name,
      secret,
      status: "trusted",
      created: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    config.pairingMode = false;
    saveAuthConfig(config);
    logger.info("auth", `Device registered: ${deviceId} (trusted; bootstrap)`);
    return { deviceId, secret, status: "trusted" };
  }

  // Subsequent devices: must be explicitly allowed by the operator.
  if (!config.pairingMode) {
    logger.info("auth", `Device registration rejected (pairing mode disabled): ${name}`);
    return {
      status: "rejected",
      error: "Pairing mode disabled — operator must enable pairing on the trusted device",
    };
  }

  const deviceId = crypto.randomUUID();
  const secret = generateSecret();
  config.devices[deviceId] = {
    name,
    secret,
    status: "pending",
    created: new Date().toISOString(),
    lastSeen: null,
  };
  saveAuthConfig(config);
  logger.info("auth", `Device registered: ${deviceId} (pending)`);
  return { deviceId, secret, status: "pending" };
}

export function verifyDevice(deviceId: string, secret: string): DeviceInfo | null {
  const config = loadAuthConfig();
  const device = config.devices[deviceId];
  if (!device || device.secret !== secret) return null;
  // Mark in-memory and return a view that reflects the freshest pending
  // timestamp without forcing a disk write per request.
  const now = new Date().toISOString();
  recordLastSeen(deviceId, now);
  return { ...device, lastSeen: now };
}

export function approveDevice(deviceId: string): boolean {
  const config = loadAuthConfig();
  const device = config.devices[deviceId];
  if (!device) return false;
  device.status = "trusted";
  device.lastSeen = new Date().toISOString();
  saveAuthConfig(config);
  logger.info("auth", `Device approved: ${deviceId}`);
  return true;
}

export function revokeDevice(deviceId: string): boolean {
  const config = loadAuthConfig();
  if (!config.devices[deviceId]) return false;
  delete config.devices[deviceId];
  saveAuthConfig(config);
  logger.info("auth", `Device removed: ${deviceId}`);
  return true;
}

export function getDevices(): Record<string, DeviceInfo> {
  return loadAuthConfig().devices;
}

export function getPendingDevices(): Record<string, DeviceInfo> {
  const devices = loadAuthConfig().devices;
  return Object.fromEntries(
    Object.entries(devices).filter(([, d]) => d.status === "pending")
  );
}

// ---------------------------------------------------------------------------
// Express middleware — accepts Bearer token OR Device auth
// ---------------------------------------------------------------------------

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const config = loadAuthConfig();

    // Legacy bearer token
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (token === config.token) {
        next();
        return;
      }
    }

    // Device auth: "Device <deviceId>:<secret>"
    if (authHeader.startsWith("Device ")) {
      const payload = authHeader.slice(7);
      const colonIdx = payload.indexOf(":");
      if (colonIdx > 0) {
        const deviceId = payload.slice(0, colonIdx);
        const secret = payload.slice(colonIdx + 1);
        const device = config.devices[deviceId];
        if (device && device.secret === secret && device.status === "trusted") {
          // Update lastSeen (debounced — buffered in memory, flushed periodically)
          const now = new Date().toISOString();
          device.lastSeen = now;
          recordLastSeen(deviceId, now);
          next();
          return;
        }
      }
    }
  } catch (err) {
    logger.error("auth", "Auth middleware error", err);
  }

  res.status(401).json({ error: "Unauthorized" });
}

// ---------------------------------------------------------------------------
// WebSocket auth — accepts token OR device credentials
// ---------------------------------------------------------------------------

export function validateWsToken(token: string): boolean {
  try {
    return token === loadAuthConfig().token;
  } catch {
    return false;
  }
}

export interface WsAuthResult {
  ok: boolean;
  // The matched subprotocol string (e.g. "vakka.bearer.<token>") that the
  // server must echo back in the Sec-WebSocket-Protocol response header so
  // browsers complete the handshake. null if auth came via query-string
  // fallback (no subprotocol to echo) or auth failed.
  subprotocol: string | null;
}

// Parse the Sec-WebSocket-Protocol header value. Browsers send a single
// comma-separated list; node's `ws` exposes either a string or string[].
function parseSubprotocols(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.flatMap((s) => s.split(",").map((p) => p.trim()).filter(Boolean));
}

let queryStringDeprecationWarned = false;

function tryDeviceAuth(deviceId: string, secret: string): boolean {
  const config = loadAuthConfig();
  const device = config.devices[deviceId];
  if (device && device.secret === secret && device.status === "trusted") {
    const now = new Date().toISOString();
    device.lastSeen = now;
    recordLastSeen(deviceId, now);
    return true;
  }
  return false;
}

export function validateWsAuth(req: { url?: string; headers: Record<string, string | string[] | undefined> }): WsAuthResult {
  try {
    // Prefer Sec-WebSocket-Protocol-based auth (creds don't appear in URL /
    // server access logs).
    const offered = parseSubprotocols(req.headers["sec-websocket-protocol"]);
    for (const proto of offered) {
      if (proto.startsWith("vakka.bearer.")) {
        const token = proto.slice("vakka.bearer.".length);
        if (token && validateWsToken(token)) {
          return { ok: true, subprotocol: proto };
        }
      } else if (proto.startsWith("vakka.device.")) {
        // Format: vakka.device.<deviceId>.<secret>. deviceId is a UUID
        // (contains '-' but no '.') and secret is hex (no '.'), so split on
        // the first '.' after the prefix.
        const rest = proto.slice("vakka.device.".length);
        const dotIdx = rest.indexOf(".");
        if (dotIdx > 0) {
          const deviceId = rest.slice(0, dotIdx);
          const secret = rest.slice(dotIdx + 1);
          if (deviceId && secret && tryDeviceAuth(deviceId, secret)) {
            return { ok: true, subprotocol: proto };
          }
        }
      }
    }
    // If a vakka.* subprotocol was offered but didn't match, refuse — don't
    // silently fall through to query-string and accept a different cred.
    if (offered.some((p) => p.startsWith("vakka."))) {
      return { ok: false, subprotocol: null };
    }

    // Deprecated: query-string credentials. Kept for one release so existing
    // browser clients (cached HTML) keep working during rollout. Logs once
    // per process to avoid log spam.
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const deviceId = url.searchParams.get("device");
    const secret = url.searchParams.get("secret");
    const token = url.searchParams.get("token");
    if (deviceId || secret || token) {
      if (!queryStringDeprecationWarned) {
        queryStringDeprecationWarned = true;
        logger.warn(
          "auth",
          "WebSocket auth via query string is deprecated — clients should send creds in Sec-WebSocket-Protocol",
        );
      }
    }
    if (deviceId && secret) {
      return { ok: tryDeviceAuth(deviceId, secret), subprotocol: null };
    }
    if (token) {
      return { ok: validateWsToken(token), subprotocol: null };
    }
    return { ok: false, subprotocol: null };
  } catch {
    return { ok: false, subprotocol: null };
  }
}

// Test-only: reset the once-per-process deprecation warning latch so each
// test in tests/ws-subprotocol-auth.test.ts can assert the log fires.
export function _resetWsDeprecationWarnedForTests(): void {
  queryStringDeprecationWarned = false;
}
