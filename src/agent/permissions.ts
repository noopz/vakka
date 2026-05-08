import type { MqttClient } from "mqtt";
import type { PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { topics } from "../shared/mqtt.js";
import type { PermissionsConfig, MQTTPermissionRequest, MQTTPermissionResponse } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import type { QuestionHandler } from "./question-handler.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export class PermissionHandler {
  private pendingByToolUseId = new Map<string, Deferred<MQTTPermissionResponse>>();

  constructor(
    private mqttClient: MqttClient,
    private sessionId: string,
    private config: PermissionsConfig,
    private questionHandler?: QuestionHandler,
  ) {}

  /** Called when an MQTT permission_response message arrives. */
  handleResponse(data: MQTTPermissionResponse & { toolUseId?: string }): void {
    logger.info("permissions", `handleResponse called: ${JSON.stringify(data)}`);
    logger.info("permissions", `Pending requests: ${[...this.pendingByToolUseId.keys()].join(", ") || "(none)"}`);

    if (data.toolUseId) {
      const deferred = this.pendingByToolUseId.get(data.toolUseId);
      if (deferred) {
        logger.info("permissions", `Resolved by toolUseId: ${data.toolUseId}`);
        deferred.resolve(data);
        return;
      }
      logger.warn("permissions", `No pending request for toolUseId: ${data.toolUseId}`);
    }

    // Fallback: resolve the oldest pending request for this tool
    for (const [id, deferred] of this.pendingByToolUseId) {
      logger.warn("permissions", `Fallback: resolving pending request ${id} without matching toolUseId`);
      this.pendingByToolUseId.delete(id);
      deferred.resolve(data);
      return;
    }

    logger.warn("permissions", `No pending requests to resolve`);
  }

  /**
   * The canUseTool callback — matches the SDK CanUseTool signature.
   *
   * Flow:
   *  1. disallowedTools → deny immediately
   *  2. Check alwaysAskTools (supports "Tool:substring" patterns)
   *  3. allowedTools AND NOT alwaysAsk → allow immediately
   *  4. Otherwise publish permission request to MQTT and await response
   *  5. If alwaysAsk, downgrade allow_always → allow (no "remember" semantics)
   */
  async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      blockedPath?: string;
      decisionReason?: string;
      title?: string;
      displayName?: string;
      description?: string;
      toolUseID: string;
      agentID?: string;
    },
  ): Promise<PermissionResult> {
    // 0. AskUserQuestion — intercept and present questions via MQTT
    if (toolName === "AskUserQuestion" && this.questionHandler) {
      return this.handleAskUserQuestion(input, options.signal);
    }

    // 1. Hard deny
    if (this.config.disallowedTools?.includes(toolName)) {
      return { behavior: "deny", message: `Tool "${toolName}" is disallowed` };
    }

    // 2. Check alwaysAsk
    const isAlwaysAsk = this.matchesAlwaysAsk(toolName, input);

    // 3. Auto-allow (unless alwaysAsk overrides)
    if (!isAlwaysAsk && this.config.allowedTools?.includes(toolName)) {
      return { behavior: "allow" };
    }

    // 4. Publish permission request and wait for user response
    const deferred = createDeferred<MQTTPermissionResponse>();
    this.pendingByToolUseId.set(options.toolUseID, deferred);

    const request: MQTTPermissionRequest & { toolUseId: string } = {
      tool: toolName,
      input: input as Record<string, any>,
      alwaysAsk: isAlwaysAsk,
      description: options.title ?? this.describeToolUse(toolName, input),
      toolUseId: options.toolUseID,
    };

    this.mqttClient.publish(
      topics(this.sessionId).permission,
      JSON.stringify(request),
    );

    // Handle abort
    const onAbort = () => {
      this.pendingByToolUseId.delete(options.toolUseID);
      deferred.resolve({ decision: "deny", tool: toolName });
    };
    options.signal.addEventListener("abort", onAbort, { once: true });

    let response: MQTTPermissionResponse;
    try {
      response = await deferred.promise;
    } finally {
      this.pendingByToolUseId.delete(options.toolUseID);
      options.signal.removeEventListener("abort", onAbort);
    }

    // 5. Translate MQTT response → SDK PermissionResult
    logger.info("permissions", `canUseTool response for ${toolName}: decision=${response.decision}, hasSuggestions=${!!options.suggestions}, suggestionsCount=${options.suggestions?.length ?? 0}`);

    let result: PermissionResult;
    if (response.decision === "deny") {
      const denyMsg = (response as any).message
        ? `User denied: ${(response as any).message}`
        : "User denied tool use";
      result = { behavior: "deny", message: denyMsg };
    } else if (isAlwaysAsk) {
      // For alwaysAsk tools, downgrade allow_always to plain allow (no updatedPermissions)
      result = { behavior: "allow", updatedInput: input };
    } else if (response.decision === "allow_always" && options.suggestions) {
      // allow_always → propagate suggestions so the SDK remembers
      result = { behavior: "allow", updatedInput: input, updatedPermissions: options.suggestions };
    } else {
      result = { behavior: "allow", updatedInput: input };
    }

    logger.info("permissions", `Returning PermissionResult: ${JSON.stringify(result).slice(0, 300)}`);
    return result;
  }

  /**
   * Handle AskUserQuestion by presenting each question via MQTT and collecting answers.
   * Returns an allow result with the answers embedded in updatedInput.
   */
  private async handleAskUserQuestion(
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const questions = input.questions as Array<{
      question: string;
      options?: string[];
      allowFreeText?: boolean;
      multiSelect?: boolean;
    }> | undefined;

    if (!questions || questions.length === 0) {
      logger.warn("permissions", "AskUserQuestion called with no questions");
      return { behavior: "allow", updatedInput: { ...input, answers: {} } };
    }

    logger.info("permissions", `AskUserQuestion: presenting ${questions.length} question(s)`);

    const answers: Record<string, string | string[]> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      try {
        const answer = await this.questionHandler!.askQuestion(q.question, {
          options: q.options,
          allowFreeText: q.allowFreeText,
          multiSelect: q.multiSelect,
          signal,
        });
        answers[String(i)] = answer;
        logger.info("permissions", `AskUserQuestion: answer[${i}] received`);
      } catch (err) {
        logger.warn("permissions", `AskUserQuestion: question ${i} aborted/failed`, err);
        return { behavior: "deny", message: "User cancelled the question" };
      }
    }

    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  /**
   * Match tool against alwaysAskTools patterns.
   * Supports plain tool names ("Read") and substring patterns ("Bash:rm -rf").
   */
  private matchesAlwaysAsk(toolName: string, input: Record<string, unknown>): boolean {
    if (!this.config.alwaysAskTools) return false;

    return this.config.alwaysAskTools.some((pattern) => {
      if (!pattern.includes(":")) {
        return pattern === toolName;
      }
      const [tool, substring] = pattern.split(":", 2);
      if (tool !== toolName) return false;
      return Object.values(input).some(
        (v) => typeof v === "string" && v.includes(substring),
      );
    });
  }

  /** Generate a human-readable description for the MQTT permission request. */
  private describeToolUse(toolName: string, input: Record<string, unknown>): string {
    if (toolName === "Bash" && typeof input.command === "string") {
      return input.command.slice(0, 200);
    }
    if ((toolName === "Edit" || toolName === "Write") && typeof input.file_path === "string") {
      return `${toolName}: ${input.file_path}`;
    }
    if (toolName === "Read" && typeof input.file_path === "string") {
      return `Read: ${input.file_path}`;
    }
    return `${toolName}: ${JSON.stringify(input).slice(0, 200)}`;
  }
}
