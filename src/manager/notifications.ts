import { getConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";

interface NotificationOptions {
  title: string;
  message: string;
  url?: string;       // Click action URL
  priority?: "min" | "low" | "default" | "high" | "urgent";
  tags?: string[];     // Emoji tags
}

export async function sendNotification(options: NotificationOptions): Promise<void> {
  const config = getConfig();
  const url = `${config.ntfyServer}/${config.ntfyTopic}`;

  try {
    const headers: Record<string, string> = {
      "Title": options.title,
      "Priority": options.priority ?? "default",
    };

    if (options.url) {
      headers["Click"] = options.url;
    }
    if (options.tags?.length) {
      headers["Tags"] = options.tags.join(",");
    }

    await fetch(url, {
      method: "POST",
      headers,
      body: options.message,
    });

    logger.info("notifications", `Sent notification: ${options.title}`);
  } catch (err) {
    logger.error("notifications", "Failed to send notification", err);
  }
}

// Convenience functions for common notifications
export function notifyPermissionRequest(sessionId: string, projectName: string, tool: string, description?: string): Promise<void> {
  return sendNotification({
    title: `${projectName} needs approval`,
    message: `wants to run: ${description ?? tool}`,
    url: `https://vakka/sessions/${sessionId}`,
    priority: "high",
    tags: ["lock"],
  });
}

export function notifyQuestion(sessionId: string, projectName: string, question: string): Promise<void> {
  return sendNotification({
    title: `${projectName} has a question`,
    message: question.slice(0, 200),
    url: `https://vakka/sessions/${sessionId}`,
    priority: "default",
    tags: ["question"],
  });
}

export function notifyCompletion(_sessionId: string, projectName: string, costUsd: number): Promise<void> {
  return sendNotification({
    title: `${projectName} finished`,
    message: `Cost: $${costUsd.toFixed(4)}`,
    priority: "low",
    tags: ["white_check_mark"],
  });
}

export function notifyFailure(_sessionId: string, projectName: string, error?: string): Promise<void> {
  return sendNotification({
    title: `${projectName} failed`,
    message: error ?? "Unknown error",
    priority: "urgent",
    tags: ["x"],
  });
}
