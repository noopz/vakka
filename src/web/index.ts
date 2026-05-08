import express from "express";
import { createServer } from "node:http";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { getConfig } from "../shared/config.js";
import { initDatabase } from "../db/schema.js";
import { createMQTTClient } from "../shared/mqtt.js";
import { createApiRouter } from "./api.js";
import { createCcRcRelay } from "../relay/cc-rc-relay.js";
import { makeRelayEventHandler } from "../manager/rc-attached.js";
import { createAuthRouter } from "./auth-routes.js";
import { setupWebSocket } from "./websocket.js";
import { authMiddleware } from "./auth.js";
import { logger } from "../shared/logger.js";

const config = getConfig();

// Open SQLite database (WAL mode allows concurrent reads alongside the manager)
const db = initDatabase(config.dbPath);

// Connect to MQTT broker
const mqttClient = createMQTTClient("web");

mqttClient.on("connect", () => {
  logger.info("web", "Connected to MQTT broker");
});

mqttClient.on("error", (err) => {
  logger.error("web", "MQTT error", err);
});

// Create Express app
const app = express();
// 50mb because the RC relay receives full worker-event POSTs (assistant turns
// with embedded tool results) which routinely exceed the 100kb default.
app.use(express.json({ limit: "50mb" }));

// Auth routes (public — no auth required)
const authRouter = createAuthRouter();
app.use("/api/auth", authRouter);

// Auth middleware for all other API routes
app.use("/api", authMiddleware);

// CC RC relay (rc-attached mode) — additive third control plane.
// Mounted outside the /api auth middleware: the relay enforces its own TOFU
// JWT pin per cseId on the worker JWT that CC presents. Endpoints live under
// /v1/code/... so they don't collide with /api or the SPA fallback.
const rcRelay = createCcRcRelay({
  onEvent: makeRelayEventHandler({ mqttClient, db }),
});
app.use(rcRelay.router);

// Mount API router (after relay so api can reach into rcRelay.pushFrame).
const apiRouter = createApiRouter(db, mqttClient, rcRelay);
app.use("/api", apiRouter);

// Serve static files from public/ directory
const publicDir = join(import.meta.dir, "..", "..", "public");
app.use(express.static(publicDir));

// SPA fallback: serve index.html for any non-API route
app.get("/{*splat}", (_req, res) => {
  try {
    const indexPath = join(publicDir, "index.html");
    const html = readFileSync(indexPath, "utf-8");
    res.type("html").send(html);
  } catch {
    res.status(404).send("Not found — frontend not built yet. Run: bun run build:frontend");
  }
});

// Create HTTP server and set up WebSocket
const server = createServer(app);
setupWebSocket(server, mqttClient, db);

// Start listening — bind to localhost by default. Set VAKKA_BIND=0.0.0.0 to
// expose on all interfaces (LAN access opt-in).
server.listen(config.webPort, process.env.VAKKA_BIND ?? "127.0.0.1", () => {
  logger.info("web", `Vakka web server listening on port ${config.webPort}`);
  logger.info("web", `Auth token: configured at ${config.authTokenPath}`);
  logger.info("web", `Public dir: ${publicDir}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("web", "Received SIGTERM, shutting down...");
  server.close(() => {
    mqttClient.end(false, () => {
      db.close();
      logger.info("web", "Shutdown complete");
      process.exit(0);
    });
  });
});
