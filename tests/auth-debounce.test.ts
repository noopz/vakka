import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set up an isolated tmp auth path BEFORE importing auth.ts.
const tmpDir = mkdtempSync(join(tmpdir(), "vekka-auth-debounce-"));
const AUTH_PATH = join(tmpDir, "auth.json");
process.env.VAKKA_AUTH_TOKEN_PATH = AUTH_PATH;

writeFileSync(
  AUTH_PATH,
  JSON.stringify({ token: "t", devices: {}, pairingMode: true }),
  "utf-8",
);

const auth = await import("../src/web/auth.js");
const sharedConfig = await import("../src/shared/config.js");

sharedConfig.setConfig({ authTokenPath: AUTH_PATH });

const DEVICE_ID = "device-debounce-1";
const SECRET = "secret-debounce-1";

function writeFreshConfig() {
  const data = {
    token: "test-token",
    devices: {
      [DEVICE_ID]: {
        name: "test-device",
        secret: SECRET,
        status: "trusted" as const,
        created: new Date().toISOString(),
        lastSeen: null,
      },
    },
    pairingMode: false,
    // Pre-fill MQTT creds so loadAuthConfig() doesn't backfill + write on
    // first access (that would race our "before" content snapshots).
    mqtt: { username: "vakka_mqtt_test01", password: "x".repeat(64) },
  };
  writeFileSync(AUTH_PATH, JSON.stringify(data), "utf-8");
  auth._resetAuthCacheForTests();
  auth._resetLastSeenBufferForTests();
  // Prime the cache.
  auth.loadAuthConfig();
}

// Witness disk writes by sampling auth.json content. The flush path is the
// only writer in this suite, so a content change indicates one or more
// saveAuthConfig writes.
function readDiskContent(): string {
  return readFileSync(AUTH_PATH, "utf-8");
}

beforeEach(() => {
  writeFreshConfig();
});

afterEach(() => {
  auth._resetLastSeenBufferForTests();
  auth._resetAuthCacheForTests();
});

afterAll(() => {
  auth._resetAuthCacheForTests();
  sharedConfig._resetConfigForTests();
});

describe("auth debounced lastSeen", () => {
  test("100 verifyDevice calls in <1s → 0 disk writes from verifyDevice", () => {
    const before = readDiskContent();
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      const result = auth.verifyDevice(DEVICE_ID, SECRET);
      expect(result).not.toBeNull();
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    // No flush has happened yet → file content unchanged.
    expect(readDiskContent()).toBe(before);
  });

  test("verifyDevice returns DeviceInfo with fresh in-memory lastSeen", () => {
    const before = Date.now();
    const result = auth.verifyDevice(DEVICE_ID, SECRET);
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    expect(result.lastSeen).not.toBeNull();
    const ts = Date.parse(result.lastSeen!);
    expect(ts).toBeGreaterThanOrEqual(before - 5);
    expect(ts).toBeLessThanOrEqual(Date.now() + 5);
  });

  test("pending lastSeen reflects most recent timestamp after rapid calls", async () => {
    auth.verifyDevice(DEVICE_ID, SECRET);
    const firstPending = auth._getPendingLastSeenForTests().get(DEVICE_ID);
    expect(firstPending).toBeTruthy();

    // Wait long enough that the next ISO timestamp differs.
    await new Promise((r) => setTimeout(r, 10));
    auth.verifyDevice(DEVICE_ID, SECRET);
    const secondPending = auth._getPendingLastSeenForTests().get(DEVICE_ID);
    expect(secondPending).toBeTruthy();
    expect(Date.parse(secondPending!)).toBeGreaterThanOrEqual(
      Date.parse(firstPending!),
    );
  });

  test("flushLastSeen on demand persists most recent timestamp to disk", () => {
    auth.verifyDevice(DEVICE_ID, SECRET);
    const expected = auth._getPendingLastSeenForTests().get(DEVICE_ID);
    expect(expected).toBeTruthy();

    const beforeContent = readDiskContent();
    auth._flushLastSeenForTests();
    const afterContent = readDiskContent();
    expect(afterContent).not.toBe(beforeContent);

    const onDisk = JSON.parse(afterContent);
    expect(onDisk.devices[DEVICE_ID].lastSeen).toBe(expected);
  });

  test("buffer cleared after flush", () => {
    auth.verifyDevice(DEVICE_ID, SECRET);
    expect(auth._getPendingLastSeenForTests().size).toBe(1);
    auth._flushLastSeenForTests();
    expect(auth._getPendingLastSeenForTests().size).toBe(0);
  });

  test("flushLastSeen with empty buffer is a no-op (no disk write)", () => {
    const before = readDiskContent();
    auth._flushLastSeenForTests();
    expect(readDiskContent()).toBe(before);
  });

  test("100 verifyDevice calls then a single flush → file written once with final timestamp", () => {
    const before = readDiskContent();
    for (let i = 0; i < 100; i++) {
      auth.verifyDevice(DEVICE_ID, SECRET);
    }
    // No write yet.
    expect(readDiskContent()).toBe(before);
    const finalPending = auth._getPendingLastSeenForTests().get(DEVICE_ID);
    auth._flushLastSeenForTests();
    const after = readDiskContent();
    expect(after).not.toBe(before);
    const onDisk = JSON.parse(after);
    expect(onDisk.devices[DEVICE_ID].lastSeen).toBe(finalPending);
    // Buffer is cleared, so a follow-up flush is a no-op.
    const afterAgain = readDiskContent();
    auth._flushLastSeenForTests();
    expect(readDiskContent()).toBe(afterAgain);
  });
});
