import { join } from "node:path";

export interface VakkaConfig {
  mqttHost: string;
  dbPath: string;
  webPort: number;
  authTokenPath: string;
  ntfyTopic: string;
  ntfyServer: string;
}

let _config: VakkaConfig | null = null;

export function getConfig(): VakkaConfig {
  if (_config) return _config;

  // Vakka's own install location: VAKKA_ROOT env wins, else current working
  // directory (typical case: launched from the repo root via `bun run dev`).
  const vakkaRoot = process.env.VAKKA_ROOT ?? process.cwd();

  _config = {
    mqttHost: process.env.VAKKA_MQTT_HOST ?? "mqtt://localhost:1883",
    dbPath: process.env.VAKKA_DB_PATH ?? join(vakkaRoot, "data", "vakka.db"),
    webPort: parseInt(process.env.VAKKA_WEB_PORT ?? "3000", 10),
    authTokenPath: process.env.VAKKA_AUTH_TOKEN_PATH ?? join(vakkaRoot, "config", "auth.json"),
    ntfyTopic: process.env.VAKKA_NTFY_TOPIC ?? "vakka",
    ntfyServer: process.env.VAKKA_NTFY_SERVER ?? "https://ntfy.sh",
  };

  return _config;
}

// Allow overriding config in tests
export function setConfig(config: Partial<VakkaConfig>): void {
  _config = { ...getConfig(), ...config };
}

// Test-only: drop the cached config so the next getConfig() re-reads env vars.
export function _resetConfigForTests(): void {
  _config = null;
}
