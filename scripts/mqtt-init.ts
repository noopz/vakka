// First-boot helper: read MQTT creds from auth.json and write them into the
// mosquitto password file. After running this, the operator must
// `brew services restart mosquitto` (macOS) or `systemctl restart mosquitto`
// (Linux) for the broker to pick up the new password file.
//
// Usage:
//   bun run scripts/mqtt-init.ts
//
// Path detection (in order):
//   1. $VAKKA_MQTT_PASSWD_PATH
//   2. /opt/homebrew/etc/mosquitto/vakka_passwd  (macOS Homebrew)
//   3. /etc/mosquitto/vakka_passwd               (Linux)

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { loadMqttCreds } from "../src/web/auth.js";

function detectPasswdPath(): string {
  const fromEnv = process.env.VAKKA_MQTT_PASSWD_PATH;
  if (fromEnv) return fromEnv;
  const macPath = "/opt/homebrew/etc/mosquitto/vakka_passwd";
  if (existsSync(dirname(macPath))) return macPath;
  return "/etc/mosquitto/vakka_passwd";
}

function main(): void {
  const creds = loadMqttCreds();
  const passwdPath = detectPasswdPath();
  const dir = dirname(passwdPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const result = spawnSync(
    "mosquitto_passwd",
    ["-b", "-c", passwdPath, creds.username, creds.password],
    { stdio: "inherit" },
  );
  if (result.error) {
    console.error(
      `mosquitto_passwd not found or failed to spawn: ${result.error.message}`,
    );
    console.error(
      "Install with: brew install mosquitto  (macOS) or apt install mosquitto  (Linux).",
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`mosquitto_passwd exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
  console.log(`Wrote MQTT creds for user '${creds.username}' to ${passwdPath}`);
  console.log(
    "Now restart the broker: `brew services restart mosquitto` (macOS) or `systemctl restart mosquitto` (Linux).",
  );
}

main();
