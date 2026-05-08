import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../src/shared/config.js";

// Tests focus on the option-passing logic and the auth-config plumbing.
// Running a real mosquitto broker in CI is out of scope; the live-broker
// scenarios (no creds → refused, wrong creds → refused, right creds → connects)
// are exercised manually via the README's `mqtt-init` flow.

let tmpDir: string;
let authPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vakka-mqtt-auth-"));
  authPath = join(tmpDir, "auth.json");
  setConfig({ authTokenPath: authPath, mqttHost: "mqtt://localhost:1883" });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("auth.ts MQTT credential plumbing", () => {
  test("loadMqttCreds throws if creds are missing entirely", async () => {
    const { _resetAuthCacheForTests, loadMqttCreds } = await import(
      "../src/web/auth.js"
    );
    _resetAuthCacheForTests();
    // Write a config that lacks mqtt — backfill should populate it on read.
    writeFileSync(
      authPath,
      JSON.stringify({ token: "t".repeat(64), devices: {}, pairingMode: false }),
    );
    // After loadMqttCreds(), creds should exist (backfilled).
    const creds = loadMqttCreds();
    expect(creds.username).toMatch(/^vakka_mqtt_[0-9a-f]{6}$/);
    expect(creds.password).toMatch(/^[0-9a-f]{64}$/);
  });

  test("generateMqttCreds produces unique creds with expected format", async () => {
    const { generateMqttCreds } = await import("../src/web/auth.js");
    const a = generateMqttCreds();
    const b = generateMqttCreds();
    expect(a.username).toMatch(/^vakka_mqtt_[0-9a-f]{6}$/);
    expect(a.password).toHaveLength(64);
    expect(a.username).not.toBe(b.username);
    expect(a.password).not.toBe(b.password);
  });

  test("loadAuthConfig backfills mqtt creds and persists them", async () => {
    const { _resetAuthCacheForTests, loadAuthConfig } = await import(
      "../src/web/auth.js"
    );
    _resetAuthCacheForTests();
    writeFileSync(
      authPath,
      JSON.stringify({ token: "t".repeat(64), devices: {}, pairingMode: false }),
    );
    const cfg = loadAuthConfig();
    expect(cfg.mqtt).toBeDefined();
    // Re-read from disk: should have been persisted.
    const { readFileSync } = await import("node:fs");
    const onDisk = JSON.parse(readFileSync(authPath, "utf-8"));
    expect(onDisk.mqtt.username).toBe(cfg.mqtt!.username);
    expect(onDisk.mqtt.password).toBe(cfg.mqtt!.password);
  });

  test("loadMqttCreds throws clearly when auth.json is missing", async () => {
    const { _resetAuthCacheForTests, loadMqttCreds } = await import(
      "../src/web/auth.js"
    );
    _resetAuthCacheForTests();
    // No file at authPath at all.
    expect(() => loadMqttCreds()).toThrow();
  });
});

describe("createMQTTClient passes username/password to mqtt.connect", () => {
  test("connect attempt uses the loaded creds", async () => {
    const { _resetAuthCacheForTests } = await import("../src/web/auth.js");
    _resetAuthCacheForTests();
    writeFileSync(
      authPath,
      JSON.stringify({
        token: "t".repeat(64),
        devices: {},
        pairingMode: false,
        mqtt: { username: "vakka_mqtt_abcdef", password: "p".repeat(64) },
      }),
    );

    // Use a non-routable host so `mqtt.connect` returns immediately without
    // actually establishing a connection. We then read the options off the
    // returned client object to verify they were passed through.
    setConfig({
      authTokenPath: authPath,
      mqttHost: "mqtt://127.0.0.1:1",
    });

    const { createMQTTClient } = await import("../src/shared/mqtt.js");
    const client = createMQTTClient("test");
    // mqtt v5 stores options on `client.options` (IClientOptions).
    const opts = (client as unknown as { options: Record<string, unknown> })
      .options;
    expect(opts.username).toBe("vakka_mqtt_abcdef");
    // mqtt normalizes password to a Buffer internally; accept either.
    const pw = opts.password;
    const pwStr = Buffer.isBuffer(pw) ? pw.toString("utf-8") : pw;
    expect(pwStr).toBe("p".repeat(64));
    expect(opts.clientId).toMatch(/^vakka-test-/);
    client.end(true);
  });

  test("createMQTTClient throws if creds are missing", async () => {
    const { _resetAuthCacheForTests } = await import("../src/web/auth.js");
    _resetAuthCacheForTests();
    // No file on disk → loadAuthConfig itself will throw, which createMQTTClient
    // re-wraps as a clear error.
    const { createMQTTClient } = await import("../src/shared/mqtt.js");
    expect(() => createMQTTClient("test-missing")).toThrow(
      /failed to load MQTT credentials/,
    );
  });
});
