import { Router, type Request, type Response, type NextFunction } from "express";
import {
  registerDevice,
  verifyDevice,
  getDevices,
  getPendingDevices,
  approveDevice,
  revokeDevice,
  authMiddleware,
  getPairingMode,
  setPairingMode,
} from "./auth.js";

// ---------------------------------------------------------------------------
// In-memory token-bucket rate limiter for /register
// 5 requests / 60s / IP. 6th attempt → 429 with Retry-After.
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;

interface Bucket {
  // Timestamps (ms) of recent requests within the current window.
  hits: number[];
}

const buckets = new Map<string, Bucket>();

function rateLimitRegister(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(ip, bucket);
  }
  // Drop hits older than the window.
  bucket.hits = bucket.hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (bucket.hits.length >= RATE_LIMIT_MAX) {
    const oldest = bucket.hits[0] ?? now;
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - oldest);
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.set("Retry-After", String(retryAfterSec));
    res.status(429).json({ error: "Too many registration attempts. Try again later." });
    return;
  }
  bucket.hits.push(now);
  next();
}

// Test-only: clear rate-limit state.
export function _resetRateLimitForTests(): void {
  buckets.clear();
}

/**
 * Public auth endpoints (no auth required) — mounted at /api/auth
 */
export function createAuthRouter(): Router {
  const router = Router();

  // Register a new device — public (rate-limited)
  router.post("/register", rateLimitRegister, (req, res) => {
    try {
      const name = req.body?.name || "Unknown device";
      const result = registerDevice(name);
      res.json(result);
    } catch (_err) {
      res.status(500).json({ error: "Registration failed" });
    }
  });

  // Verify device credentials — public
  router.post("/verify", (req, res) => {
    try {
      const { deviceId, secret } = req.body || {};
      if (!deviceId || !secret) {
        res.json({ status: "unknown" });
        return;
      }
      const device = verifyDevice(deviceId, secret);
      if (!device) {
        res.json({ status: "unknown" });
        return;
      }
      res.json({ status: device.status });
    } catch {
      res.json({ status: "unknown" });
    }
  });

  // --- The following require auth ---

  // List all devices
  router.get("/devices", authMiddleware, (_req, res) => {
    res.json({ devices: getDevices() });
  });

  // List pending devices
  router.get("/devices/pending", authMiddleware, (_req, res) => {
    res.json({ devices: getPendingDevices() });
  });

  // Approve a device
  router.post("/devices/:id/approve", authMiddleware, (req, res) => {
    const id = req.params.id as string;
    const ok = approveDevice(id);
    if (!ok) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    res.json({ ok: true });
  });

  // Remove a device
  router.delete("/devices/:id", authMiddleware, (req, res) => {
    const id = req.params.id as string;
    const ok = revokeDevice(id);
    if (!ok) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    res.json({ ok: true });
  });

  // Pairing-mode read/write — auth required.
  router.get("/pairing-mode", authMiddleware, (_req, res) => {
    res.json({ pairingMode: getPairingMode() });
  });

  router.post("/pairing-mode", authMiddleware, (req, res) => {
    const enabled = !!req.body?.enabled;
    const next = setPairingMode(enabled);
    res.json({ pairingMode: next });
  });

  return router;
}
