/**
 * Standalone UI dev server — no MQTT, no SQLite, no auth required.
 * Serves the frontend with mock API endpoints and a fake WebSocket.
 *
 * Usage: bun run scripts/dev-ui.ts
 * Then open http://localhost:3000
 * Token: "dev" (or anything — auth is bypassed)
 *
 * Rebuilds the frontend on file changes automatically.
 */

import * as esbuild from "esbuild";
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { join } from "path";
import { readFileSync } from "fs";

const PORT = 3000;
const ROOT = join(import.meta.dir, "..");
const PUBLIC = join(ROOT, "public");

// ---------------------------------------------------------------------------
// 1. Start esbuild in watch mode
// ---------------------------------------------------------------------------

const ctx = await esbuild.context({
  entryPoints: ["src/frontend/index.tsx", "src/frontend/styles/app.css"],
  bundle: true,
  outdir: "public",
  format: "esm",
  target: "safari15",
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: true,
  treeShaking: true,
  entryNames: "[name]",
});
await ctx.watch();
console.log("[dev-ui] esbuild watching for changes...");

// ---------------------------------------------------------------------------
// 2. Mock data
// ---------------------------------------------------------------------------

const mockProjects = [
  { path: "/Users/example/projects/vakka", name: "vakka", discovered_at: new Date().toISOString(), last_file_activity: new Date().toISOString(), last_human_session: new Date().toISOString(), pinned: 1 },
  { path: "/Users/example/projects/foo", name: "foo", discovered_at: new Date().toISOString(), last_file_activity: new Date(Date.now() - 2 * 86400000).toISOString(), last_human_session: null, pinned: 0 },
  { path: "/Users/example/projects/bar", name: "bar", discovered_at: new Date().toISOString(), last_file_activity: new Date(Date.now() - 5 * 86400000).toISOString(), last_human_session: null, pinned: 0 },
  { path: "/Users/example/projects/baz", name: "baz", discovered_at: new Date().toISOString(), last_file_activity: new Date(Date.now() - 14 * 86400000).toISOString(), last_human_session: null, pinned: 0 },
  { path: "/Users/example/projects/notes", name: "notes", discovered_at: new Date().toISOString(), last_file_activity: new Date(Date.now() - 30 * 86400000).toISOString(), last_human_session: null, pinned: 0 },
];

const mockSessions = [
  { id: "sess-001", project_path: "/Users/example/projects/vakka", status: "running", jsonl_path: null, model: "sonnet", pid: 12345, cost_usd: 0.42, created_at: new Date(Date.now() - 300000).toISOString(), last_activity: new Date(Date.now() - 60000).toISOString() },
  { id: "sess-002", project_path: "/Users/example/projects/notes", status: "waiting_input", jsonl_path: null, model: "opus", pid: 12346, cost_usd: 1.05, created_at: new Date(Date.now() - 7200000).toISOString(), last_activity: new Date(Date.now() - 3600000).toISOString() },
];

const mockMessages: Record<string, any[]> = {
  "sess-001": [
    { id: 1, session_id: "sess-001", role: "user", content: JSON.stringify({ type: "user", content: "Add a health check endpoint to the API" }), created_at: new Date(Date.now() - 240000).toISOString() },
    { id: 2, session_id: "sess-001", role: "assistant", content: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "I'll add a health check endpoint. Let me first look at the existing API routes.\n\n```typescript\nrouter.get('/health', (req, res) => {\n  res.json({ status: 'ok', uptime: process.uptime() });\n});\n```\n\nThis adds a simple `/api/health` endpoint that returns the server status and uptime." }] } }), created_at: new Date(Date.now() - 200000).toISOString() },
    { id: 3, session_id: "sess-001", role: "permission", content: JSON.stringify({ tool: "Edit", input: { file_path: "/Users/example/projects/vakka/src/web/api.ts", old_string: "return router;", new_string: "router.get('/health', ...);\n  return router;" }, alwaysAsk: false, toolUseId: "tu-001", description: "Edit: /Users/example/projects/vakka/src/web/api.ts" }), created_at: new Date(Date.now() - 180000).toISOString() },
    { id: 4, session_id: "sess-001", role: "question", content: JSON.stringify({ question: "Should I also add a readiness probe that checks MQTT and SQLite connectivity?", options: ["Yes, add full readiness check", "No, simple health check is enough", "Add it but make it a separate endpoint"], allowFreeText: true, multiSelect: false, questionId: "q-001" }), created_at: new Date(Date.now() - 120000).toISOString() },
  ],
  "sess-002": [
    { id: 10, session_id: "sess-002", role: "user", content: JSON.stringify({ type: "user", content: "List the markdown files in this directory." }), created_at: new Date(Date.now() - 3600000).toISOString() },
    { id: 11, session_id: "sess-002", role: "assistant", content: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Found 3 markdown files:\n\n1. `README.md`\n2. `notes.md`\n3. `todo.md`\n\nWant me to summarize any of them?" }] } }), created_at: new Date(Date.now() - 3500000).toISOString() },
  ],
};

const mockContext: Record<string, any> = {
  "sess-001": {
    totalTokens: 62400,
    maxTokens: 200000,
    percentage: 31.2,
    model: "Opus 4.6 (1M context)",
    categories: [
      { name: "Messages", tokens: 45900, color: "#8b5cf6" },
      { name: "System tools", tokens: 8000, color: "#3b82f6" },
      { name: "System prompt", tokens: 6300, color: "#6366f1" },
      { name: "Memory files", tokens: 1100, color: "#a78bfa" },
      { name: "Skills", tokens: 800, color: "#c4b5fd" },
      { name: "Custom agents", tokens: 300, color: "#ddd6fe" },
    ],
    mcpTools: [
      { name: "browser_navigate", serverName: "playwright", tokens: 120, isLoaded: true },
      { name: "browser_snapshot", serverName: "playwright", tokens: 95, isLoaded: true },
      { name: "browser_click", serverName: "playwright", tokens: 110, isLoaded: true },
      { name: "browser_fill_form", serverName: "playwright", tokens: 105, isLoaded: false },
      { name: "authenticate", serverName: "Gmail", tokens: 80, isLoaded: false },
      { name: "authenticate", serverName: "Google Calendar", tokens: 80, isLoaded: false },
    ],
    agents: [
      { agentType: "Explore", source: "builtin", tokens: 150 },
      { agentType: "code-reviewer", source: "feature-dev", tokens: 200 },
    ],
  },
  "sess-002": {
    totalTokens: 145000,
    maxTokens: 200000,
    percentage: 72.5,
    model: "Opus 4.6 (1M context)",
    categories: [
      { name: "Messages", tokens: 120000, color: "#8b5cf6" },
      { name: "System tools", tokens: 12000, color: "#3b82f6" },
      { name: "System prompt", tokens: 8000, color: "#6366f1" },
      { name: "Memory files", tokens: 3000, color: "#a78bfa" },
      { name: "Skills", tokens: 1200, color: "#c4b5fd" },
      { name: "Custom agents", tokens: 800, color: "#ddd6fe" },
    ],
    mcpTools: [],
    agents: [
      { agentType: "wiki-query", source: "commonplace", tokens: 300 },
    ],
  },
};

let nextMessageId = 100;
let nextSessionId = 3;

// ---------------------------------------------------------------------------
// 3. Express app with mock API
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// No auth in dev mode

// ---------------------------------------------------------------------------
// Mock device auth
// ---------------------------------------------------------------------------

const mockDevices: Record<string, any> = {};
let isFirstDevice = true;

app.post("/api/auth/register", (req, res) => {
  const deviceId = crypto.randomUUID();
  const secret = crypto.randomUUID();
  const status = isFirstDevice ? "trusted" : "pending";
  isFirstDevice = false;
  mockDevices[deviceId] = {
    name: req.body?.name || "Unknown",
    secret,
    status,
    created: new Date().toISOString(),
    lastSeen: null,
  };
  res.json({ deviceId, secret, status });
});

app.post("/api/auth/verify", (req, res) => {
  const device = mockDevices[req.body?.deviceId];
  if (!device || device.secret !== req.body?.secret) {
    return res.json({ status: "unknown" });
  }
  res.json({ status: device.status });
});

app.get("/api/auth/devices", (_req, res) => res.json({ devices: mockDevices }));

app.get("/api/auth/devices/pending", (_req, res) => {
  const pending = Object.fromEntries(
    Object.entries(mockDevices).filter(([, d]: [string, any]) => d.status === "pending")
  );
  res.json({ devices: pending });
});

app.post("/api/auth/devices/:id/approve", (req, res) => {
  if (mockDevices[req.params.id]) mockDevices[req.params.id].status = "trusted";
  res.json({ ok: true });
});

app.delete("/api/auth/devices/:id", (req, res) => {
  delete mockDevices[req.params.id];
  res.json({ ok: true });
});

// Projects
app.get("/api/projects", (_req, res) => res.json(mockProjects));
app.get("/api/projects/:path", (req, res) => {
  const p = mockProjects.find(p => p.path === decodeURIComponent(req.params.path));
  p ? res.json(p) : res.status(404).json({ error: "Not found" });
});
app.post("/api/projects/:path/pin", (req, res) => {
  const p = mockProjects.find(p => p.path === decodeURIComponent(req.params.path));
  if (p) p.pinned = req.body.pinned ? 1 : 0;
  res.json({ ok: true });
});

// Sessions
app.get("/api/sessions", (_req, res) => res.json(mockSessions));
app.get("/api/sessions/active", (_req, res) => res.json(mockSessions.filter(s => ["running", "waiting_permission", "waiting_input"].includes(s.status))));
app.get("/api/sessions/:id", (req, res) => {
  const s = mockSessions.find(s => s.id === req.params.id);
  s ? res.json(s) : res.status(404).json({ error: "Not found" });
});
app.post("/api/sessions", (req, res) => {
  const id = `sess-${String(nextSessionId++).padStart(3, "0")}`;
  const session = {
    id,
    project_path: req.body.projectPath,
    status: "running",
    jsonl_path: null,
    model: req.body.model || "sonnet",
    pid: Math.floor(Math.random() * 90000) + 10000,
    cost_usd: 0,
    created_at: new Date().toISOString(),
    last_activity: new Date().toISOString(),
  };
  mockSessions.push(session);
  mockMessages[id] = [];
  res.status(201).json(session);
});
app.post("/api/sessions/:id/kill", (req, res) => {
  const s = mockSessions.find(s => s.id === req.params.id);
  if (s) s.status = "completed";
  res.json({ ok: true });
});
app.post("/api/sessions/:id/restart", (req, res) => {
  const old = mockSessions.find(s => s.id === req.params.id);
  if (old) old.status = "completed";
  const id = `sess-${String(nextSessionId++).padStart(3, "0")}`;
  const session = {
    id,
    project_path: old?.project_path ?? "/tmp/unknown",
    status: "running",
    jsonl_path: null,
    model: old?.model ?? "sonnet",
    pid: Math.floor(Math.random() * 90000) + 10000,
    cost_usd: 0,
    created_at: new Date().toISOString(),
    last_activity: new Date().toISOString(),
  };
  mockSessions.push(session);
  mockMessages[id] = [];
  mockContext[id] = { ...mockContext[req.params.id], totalTokens: 6300, percentage: 3.2 };
  console.log(`[dev-ui] Restart ${req.params.id} -> ${id}`);
  res.json({ ok: true, oldSessionId: req.params.id, sessionId: id, pid: session.pid });
});
app.post("/api/sessions/:id/mode", (req, res) => {
  console.log(`[dev-ui] Mode change for ${req.params.id}: ${req.body.mode}`);
  res.json({ ok: true });
});

// Messages
app.get("/api/sessions/:id/messages", (req, res) => {
  const msgs = mockMessages[req.params.id] || [];
  const after = req.query.after ? parseInt(req.query.after as string) : 0;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
  const filtered = msgs.filter(m => m.id > after).slice(0, limit);
  res.json(filtered);
});
app.post("/api/sessions/:id/messages", (req, res) => {
  const msgs = mockMessages[req.params.id];
  if (!msgs) return res.status(404).json({ error: "Session not found" });

  const id = nextMessageId++;
  msgs.push({
    id,
    session_id: req.params.id,
    role: "user",
    content: JSON.stringify({ type: "user", content: req.body.text }),
    created_at: new Date().toISOString(),
  });

  // Handle /compact command
  if (req.body.text === "/compact") {
    setTimeout(() => {
      const ctx = mockContext[req.params.id];
      const preTokens = ctx?.totalTokens ?? 60000;
      const postTokens = Math.round(preTokens * 0.3);

      // Send compact_boundary via WS
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "mqtt",
            sessionId: req.params.id,
            subtopic: "output",
            data: { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: preTokens, post_tokens: postTokens } },
          }));
        }
      });

      // Update mock context
      if (ctx) {
        ctx.totalTokens = postTokens;
        ctx.percentage = (postTokens / ctx.maxTokens) * 100;
      }
    }, 300);
    return res.json({ ok: true, id });
  }

  // Simulate an agent response after 500ms
  setTimeout(() => {
    const respId = nextMessageId++;
    const response = {
      id: respId,
      session_id: req.params.id,
      role: "assistant",
      content: JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: `I received your message: "${req.body.text}"\n\nThis is a mock response from the dev UI server. In production, this would come from the Claude Agent SDK via MQTT.` }],
        },
      }),
      created_at: new Date().toISOString(),
    };
    msgs.push(response);

    // Push to any connected WebSocket clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: "mqtt",
          sessionId: req.params.id,
          subtopic: "output",
          data: JSON.parse(response.content),
        }));
      }
    });
  }, 500);

  res.json({ ok: true, id });
});

// Permission + question responses
app.post("/api/sessions/:id/permission", (req, res) => {
  console.log(`[dev-ui] Permission response for ${req.params.id}: ${req.body.decision} ${req.body.tool}`);
  res.json({ ok: true });
});
app.post("/api/sessions/:id/question", (req, res) => {
  console.log(`[dev-ui] Question response for ${req.params.id}:`, req.body.answer);
  res.json({ ok: true });
});

// Context usage
app.get("/api/sessions/:id/context", (req, res) => {
  const ctx = mockContext[req.params.id];
  ctx ? res.json(ctx) : res.status(404).json({ error: "No context data" });
});

// Health
app.get("/api/health", (_req, res) => res.json({ status: "ok", mode: "dev" }));

// Static files
app.use(express.static(PUBLIC));
app.get("/{*splat}", (_req, res) => {
  try {
    res.type("html").send(readFileSync(join(PUBLIC, "index.html"), "utf-8"));
  } catch {
    res.status(404).send("Frontend not built. Run: bun run scripts/build-frontend.ts");
  }
});

// ---------------------------------------------------------------------------
// 4. WebSocket (mock — just echoes subscriptions, pushes mock data)
// ---------------------------------------------------------------------------

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  // No auth check in dev mode
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  console.log("[dev-ui] WebSocket client connected");

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      console.log("[dev-ui] WS message:", data.type, data.sessionId || "");

      if (data.type === "subscribe") {
        ws.send(JSON.stringify({ type: "subscribed", sessionId: data.sessionId }));
        // Push initial context data
        const ctx = mockContext[data.sessionId];
        if (ctx) {
          ws.send(JSON.stringify({ type: "mqtt", sessionId: data.sessionId, subtopic: "context", data: ctx }));
        }
      } else if (data.type === "catchup") {
        // Send missed messages from mock store
        const msgs = mockMessages[data.sessionId] || [];
        const after = data.afterMessageId || 0;
        const missed = msgs.filter((m: any) => m.id > after);
        for (const m of missed) {
          ws.send(JSON.stringify({ type: "catchup_message", sessionId: data.sessionId, message: m }));
        }
      } else if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch (err) {
      console.error("[dev-ui] WS parse error:", err);
    }
  });

  ws.on("close", () => {
    console.log("[dev-ui] WebSocket client disconnected");
  });
});

// ---------------------------------------------------------------------------
// 5. Start
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`\n[dev-ui] Vakka UI dev server running at http://localhost:${PORT}`);
  console.log(`[dev-ui] Auth: device trust (first device auto-trusted)`);
  console.log(`[dev-ui] Mock data: 2 active sessions, 5 projects`);
  console.log(`[dev-ui] Frontend rebuilds automatically on file changes\n`);
});
