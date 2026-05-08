/**
 * Agent wrapper — main entry point for agent child processes.
 *
 * Spawned by the agent manager as a detached child. Bridges the Claude Agent
 * SDK with MQTT so the web UI can send input / receive output, handle
 * permission prompts, and answer questions.
 *
 * Usage:
 *   bun run src/agent/wrapper.ts \
 *     --session-id <uuid> \
 *     --project-path /path/to/project \
 *     --mqtt-host mqtt://localhost:1883 \
 *     --model claude-sonnet-4-6 \
 *     [--resume-session-id <uuid>]
 */

import { dlopen, FFIType } from "bun:ffi";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createMQTTClient, topics, systemTopics } from "../shared/mqtt.js";
import { logger } from "../shared/logger.js";
import { MessageChannel } from "./message-channel.js";
import { PermissionHandler } from "./permissions.js";
import { QuestionHandler } from "./question-handler.js";
import type {
  PermissionsConfig,
  MQTTInputMessage,
  MQTTPermissionResponse,
  MQTTQuestionResponse,
  MQTTStatusMessage,
  MQTTCostMessage,
  MQTTContextMessage,
} from "../shared/types.js";

// Detach into our own session/pgid so signals to the manager's process group
// don't propagate to us. Runs before anything else so the window where we
// share the manager's pgid is as small as possible.
function detachToOwnSession(): void {
  if (process.platform === "win32") return;
  try {
    const lib = dlopen(
      process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
      { setsid: { args: [], returns: FFIType.i32 } },
    );
    const r = lib.symbols.setsid();
    if (typeof r === "number" && r < 0) {
      console.error("[wrapper] setsid() returned", r, "— may not survive parent group signals");
    }
  } catch (e) {
    console.error("[wrapper] FFI setsid failed — may not survive parent group signals:", e);
  }
}
detachToOwnSession();

// Immutable boot-time value used in every hello publish. Reconcile relies
// on this being constant across the life of the process (PID-reuse guard).
const STARTED_AT = Date.now();

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  sessionId: string;
  projectPath: string;
  mqttHost: string;
  model: string;
  resumeSessionId?: string;
  forkSession: boolean;
} {
  let sessionId = "";
  let projectPath = "";
  let mqttHost = "mqtt://localhost:1883";
  let model = "opus";
  let resumeSessionId: string | undefined;
  let forkSession = false;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--session-id":
        sessionId = argv[++i];
        break;
      case "--project-path":
        projectPath = argv[++i];
        break;
      case "--mqtt-host":
        mqttHost = argv[++i];
        break;
      case "--model":
        model = argv[++i];
        break;
      case "--resume-session-id":
        resumeSessionId = argv[++i];
        break;
      case "--fork-session":
        forkSession = true;
        break;
    }
  }

  if (!sessionId) throw new Error("--session-id is required");
  if (!projectPath) throw new Error("--project-path is required");

  return { sessionId, projectPath, mqttHost, model, resumeSessionId, forkSession };
}

// ---------------------------------------------------------------------------
// Permissions loading
// ---------------------------------------------------------------------------

async function loadPermissions(projectPath: string): Promise<PermissionsConfig> {
  // Try project-local permissions first
  const projectPermsPath = join(projectPath, "permissions.json");
  try {
    const raw = await readFile(projectPermsPath, "utf-8");
    logger.info("wrapper", `Loaded permissions from ${projectPermsPath}`);
    return JSON.parse(raw) as PermissionsConfig;
  } catch {
    // fall through
  }

  // Fallback to Vakka repo default
  const defaultPermsPath = join(
    import.meta.dir ?? join(__dirname),
    "..",
    "..",
    "config",
    "default-permissions.json",
  );
  try {
    const raw = await readFile(defaultPermsPath, "utf-8");
    logger.info("wrapper", `Loaded default permissions from ${defaultPermsPath}`);
    return JSON.parse(raw) as PermissionsConfig;
  } catch {
    logger.warn("wrapper", "No permissions file found, using empty defaults");
    return {};
  }
}

// ---------------------------------------------------------------------------
// Plugin loading — read CLI-installed plugins from ~/.claude/plugins/
// ---------------------------------------------------------------------------

interface PluginEntry {
  type: "local";
  path: string;
}

async function loadPlugins(projectPath: string): Promise<PluginEntry[]> {
  const pluginsFile = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  try {
    const raw = await readFile(pluginsFile, "utf-8");
    const data = JSON.parse(raw);
    if (data.version !== 2 || !data.plugins) return [];

    const result: PluginEntry[] = [];
    const seen = new Set<string>();

    for (const [_name, installations] of Object.entries<any[]>(data.plugins)) {
      for (const inst of installations) {
        // Include user-scoped (global) plugins and project-scoped plugins matching this project
        if (inst.scope === "user" || (inst.scope === "project" && inst.projectPath === projectPath)) {
          const p = inst.installPath;
          if (p && !seen.has(p)) {
            seen.add(p);
            result.push({ type: "local", path: p });
          }
        }
      }
    }

    if (result.length > 0) {
      logger.info("wrapper", `Loaded ${result.length} plugins: ${[...seen].map(p => p.split("/").slice(-2).join("/")).join(", ")}`);
    }
    return result;
  } catch {
    // No plugins file or unreadable — that's fine
    return [];
  }
}

// ---------------------------------------------------------------------------
// Module-level state (accessible to signal handlers & shutdown)
// ---------------------------------------------------------------------------

let activeMqttClient: import("mqtt").MqttClient | null = null;
let activeMessageChannel: MessageChannel | null = null;
let activeSessionTopics: ReturnType<typeof topics> | null = null;
let activeAbortController: AbortController | null = null;
let activeQueryHandle: Query | null = null;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const { sessionId, projectPath, mqttHost, model, resumeSessionId, forkSession } = args;
  const LOG = "wrapper";

  logger.info(LOG, `Starting agent wrapper`, {
    sessionId,
    projectPath,
    model,
    resumeSessionId,
    forkSession,
  });

  // Override MQTT host via env so createMQTTClient picks it up
  process.env.VAKKA_MQTT_HOST = mqttHost;

  const sessionTopics = topics(sessionId);
  activeSessionTopics = sessionTopics;

  // ---- MQTT connection ----
  const mqttClient = createMQTTClient(`agent-${sessionId.slice(0, 8)}`);
  activeMqttClient = mqttClient;

  await new Promise<void>((resolve, reject) => {
    mqttClient.once("connect", () => {
      logger.info(LOG, "MQTT connected");
      resolve();
    });
    mqttClient.once("error", (err) => {
      logger.error(LOG, "MQTT connection error", err);
      reject(err);
    });
  });

  // Subscribe to topics we care about
  const contextRequestTopic = `vakka/sessions/${sessionId}/context_request`;
  const subscribeTopics = [
    sessionTopics.input,
    sessionTopics.permissionResponse,
    sessionTopics.questionResponse,
    sessionTopics.interrupt,
    sessionTopics.mode,
    contextRequestTopic,
    systemTopics.managerHelloRequest,
  ];
  await new Promise<void>((resolve, reject) => {
    mqttClient.subscribe(subscribeTopics, (err) => {
      if (err) {
        logger.error(LOG, "MQTT subscribe error", err);
        reject(err);
      } else {
        logger.info(LOG, "Subscribed to session topics", subscribeTopics);
        resolve();
      }
    });
  });

  // ---- Hello handshake ----
  // Manager uses these to confirm we're alive across hot-restarts. Publishing
  // on every `connect` event handles MQTT reconnects; responding to
  // `hello_request` lets the manager actively poll on its own startup.
  // Retain=true ensures a freshly-connected manager sees us immediately.
  const publishHello = () => {
    const helloPayload = JSON.stringify({
      pid: process.pid,
      startTime: STARTED_AT,
      wrapperVersion: 1,
    });
    mqttClient.publish(sessionTopics.hello, helloPayload, { retain: true });
  };
  publishHello();
  mqttClient.on("connect", publishHello);

  // ---- Load permissions ----
  const permissions = await loadPermissions(projectPath);
  const plugins = await loadPlugins(projectPath);

  // ---- Create handler instances ----
  const messageChannel = new MessageChannel(sessionId);
  activeMessageChannel = messageChannel;
  const questionHandler = new QuestionHandler(mqttClient, sessionId);
  const permissionHandler = new PermissionHandler(mqttClient, sessionId, permissions, questionHandler);

  // ---- Context usage publisher (set once query is running) ----
  let publishContextUsage: (() => void) | null = null;

  // ---- Wire MQTT messages to handlers ----
  mqttClient.on("message", (topic: string, payload: Buffer) => {
    try {
      const data = JSON.parse(payload.toString());

      if (topic === sessionTopics.input) {
        const msg = data as MQTTInputMessage;
        logger.debug(LOG, "Received input message", { length: msg.text.length, images: msg.images?.length ?? 0 });
        messageChannel.yieldMessage(msg.text, msg.images);
      } else if (topic === sessionTopics.permissionResponse) {
        const resp = data as MQTTPermissionResponse & { toolUseId?: string };
        logger.info(LOG, "Received permission response", { raw: JSON.stringify(data), decision: resp.decision, tool: resp.tool, toolUseId: resp.toolUseId });
        permissionHandler.handleResponse(resp);
      } else if (topic === sessionTopics.questionResponse) {
        const resp = data as MQTTQuestionResponse & { questionId?: string };
        logger.debug(LOG, "Received question response");
        questionHandler.handleResponse(resp);
      } else if (topic === sessionTopics.interrupt) {
        logger.info(LOG, "Received interrupt request");
        try {
          activeQueryHandle?.interrupt();
        } catch (err) {
          logger.warn(LOG, "interrupt() failed (query may have already ended)", err);
        }
      } else if (topic === sessionTopics.mode) {
        // Map Vakka's UI labels onto SDK PermissionMode values.
        // SDK accepts: default | acceptEdits | bypassPermissions | plan | dontAsk | auto
        const requested = (data?.mode as string) || "default";
        const sdkMode =
          requested === "auto"
            ? "auto"
            : requested === "ask_always"
              ? "default"
              : requested;
        logger.info(LOG, "Mode change requested", { requested, sdkMode });
        try {
          activeQueryHandle?.setPermissionMode(sdkMode as any);
          // Echo the change back via permissionHandler so the UI can confirm.
          permissions.defaultMode = requested as any;
        } catch (err) {
          logger.warn(LOG, "setPermissionMode() failed", err);
        }
      } else if (topic === contextRequestTopic) {
        // On-demand context request — will be handled once query is running
        publishContextUsage?.();
      } else if (topic === systemTopics.managerHelloRequest) {
        // Manager is reconciling on startup — re-announce ourselves.
        publishHello();
      }
    } catch (err) {
      logger.error(LOG, `Failed to parse MQTT message on ${topic}`, err);
    }
  });

  // ---- Publish initial status ----
  const publishStatus = (status: MQTTStatusMessage) => {
    mqttClient.publish(sessionTopics.status, JSON.stringify(status));
  };

  publishStatus({ status: "running" });

  // ---- Call SDK query() ----
  const abortController = new AbortController();
  activeAbortController = abortController;

  logger.info(LOG, "Calling SDK query()", {
    model,
    permissionMode: (permissions.defaultMode as any) || "default",
    allowedTools: permissions.allowedTools,
    disallowedTools: permissions.disallowedTools,
    plugins: plugins.length,
    resume: resumeSessionId || undefined,
    forkSession,
  });

  const q = query({
    prompt: messageChannel,
    options: {
      cwd: projectPath,
      resume: resumeSessionId || undefined,
      forkSession: forkSession || undefined,
      model,
      plugins: plugins.length > 0 ? plugins : undefined,
      allowedTools: permissions.allowedTools,
      disallowedTools: permissions.disallowedTools,
      permissionMode: (permissions.defaultMode as any) || "default",
      canUseTool: permissionHandler.canUseTool.bind(permissionHandler),
      abortController,
      includePartialMessages: true,
    },
  });

  activeQueryHandle = q;
  logger.info(LOG, "SDK query() returned, starting iteration");

  // ---- Poll context usage every 30s ----
  const fetchAndPublishContext = async () => {
    try {
      const usage = await q.getContextUsage();
      const contextMsg: MQTTContextMessage = {
        totalTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        percentage: usage.percentage,
        model: usage.model,
        categories: usage.categories.map((c) => ({ name: c.name, tokens: c.tokens, color: c.color, isDeferred: c.isDeferred })),
        mcpTools: usage.mcpTools.map((t) => ({ name: t.name, serverName: t.serverName, tokens: t.tokens, isLoaded: t.isLoaded })),
        agents: usage.agents.map((a) => ({ agentType: a.agentType, source: a.source, tokens: a.tokens })),
        skills: usage.skills,
        slashCommands: usage.slashCommands,
        systemTools: usage.systemTools,
        deferredBuiltinTools: usage.deferredBuiltinTools,
        systemPromptSections: usage.systemPromptSections,
        memoryFiles: usage.memoryFiles,
        messageBreakdown: usage.messageBreakdown
          ? {
              toolCallTokens: usage.messageBreakdown.toolCallTokens,
              toolResultTokens: usage.messageBreakdown.toolResultTokens,
              attachmentTokens: usage.messageBreakdown.attachmentTokens,
              assistantMessageTokens: usage.messageBreakdown.assistantMessageTokens,
              userMessageTokens: usage.messageBreakdown.userMessageTokens,
              redirectedContextTokens: usage.messageBreakdown.redirectedContextTokens,
              unattributedTokens: usage.messageBreakdown.unattributedTokens,
              toolCallsByType: usage.messageBreakdown.toolCallsByType,
            }
          : undefined,
        autoCompactThreshold: usage.autoCompactThreshold,
        isAutoCompactEnabled: usage.isAutoCompactEnabled,
      };
      mqttClient.publish(sessionTopics.context, JSON.stringify(contextMsg));
    } catch {
      // Query may have ended — ignore
    }
  };

  publishContextUsage = () => { fetchAndPublishContext(); };

  // Publish initial context snapshot, then every 30s
  fetchAndPublishContext();
  const contextPollInterval = setInterval(fetchAndPublishContext, 30_000);

  // ---- Consume SDK output ----
  let messageCount = 0;
  for await (const message of q) {
    messageCount++;
    const msg = message as SDKMessage & { subtype?: string };
    logger.info(LOG, `SDK message #${messageCount}: type=${msg.type}${msg.subtype ? ` subtype=${msg.subtype}` : ""}`, {
      type: msg.type,
      subtype: msg.subtype,
      ...(msg.type === "system" && { session_id: (msg as any).session_id, model: (msg as any).model }),
    });

    // Publish every message to the output topic
    mqttClient.publish(sessionTopics.output, JSON.stringify(message));

    // Handle result messages for cost & final status
    if (message.type === "result") {
      const result = message as SDKResultMessage;

      const cost: MQTTCostMessage = {
        input_tokens: result.usage?.input_tokens ?? 0,
        output_tokens: result.usage?.output_tokens ?? 0,
        cost_usd: result.total_cost_usd ?? 0,
        cumulative_cost_usd: result.total_cost_usd ?? 0,
      };
      mqttClient.publish(sessionTopics.cost, JSON.stringify(cost));

      if (result.subtype === "success") {
        // Turn complete — agent is idle, waiting for next input
        publishStatus({ status: "running" });
      } else {
        // Turn failed — publish error status
        publishStatus({ status: "failed", error: result.subtype });
      }

      // Publish fresh context usage immediately on turn end so the UI
      // reflects per-turn growth instead of waiting up to 30s for the next poll.
      fetchAndPublishContext();
    }
  }

  clearInterval(contextPollInterval);
  logger.info(LOG, "Query iteration completed");

  // ---- Clean shutdown ----
  await shutdown("completed");
}

// ---------------------------------------------------------------------------
// Shutdown helper
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function shutdown(reason: "completed" | "error", errorMsg?: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  const LOG = "wrapper";
  logger.info(LOG, `Shutting down: ${reason}`);

  // Close the query handle (kills SDK subprocess)
  try {
    activeQueryHandle?.close();
  } catch {
    // Already closed
  }
  activeQueryHandle = null;

  // Abort the SDK cleanly so it stops mid-turn work
  activeAbortController?.abort();

  // Close the message channel so the SDK iterator finishes
  activeMessageChannel?.close();

  try {
    if (activeMqttClient && activeSessionTopics) {
      const status: MQTTStatusMessage = {
        status: reason === "error" ? "error" : reason,
        ...(errorMsg && { error: errorMsg }),
      };
      // Clear our retained hello so a future manager doesn't try to reattach
      // to this session after we've exited.
      activeMqttClient.publish(activeSessionTopics.hello, "", { retain: true });
      // Publish final status and disconnect
      await new Promise<void>((resolve) => {
        activeMqttClient!.publish(
          activeSessionTopics!.status,
          JSON.stringify(status),
          {},
          () => {
            activeMqttClient!.end(false, {}, () => resolve());
          },
        );
        // Don't wait forever
        setTimeout(() => resolve(), 2000);
      });
    }
  } catch (err) {
    logger.error(LOG, "Error during shutdown status publish", err);
  }

  process.exit(reason === "error" ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

process.on("SIGTERM", () => {
  logger.info("wrapper", "Received SIGTERM");
  shutdown("completed");
});

process.on("SIGINT", () => {
  logger.info("wrapper", "Received SIGINT");
  shutdown("completed");
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
  logger.error("wrapper", `Unhandled error in main: ${msg}`);

  // Best-effort status publish
  shutdown("error", err instanceof Error ? err.message : String(err));
});
