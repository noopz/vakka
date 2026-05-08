import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../shared/logger.js";

type ImageInput = { type: string; data: string };
type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const ALLOWED_IMAGE_TYPES: readonly ImageMediaType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

/**
 * Bridges push-based MQTT message delivery to the pull-based AsyncIterable
 * that the Claude Agent SDK's `query({ prompt })` expects.
 *
 * Usage:
 *   const channel = new MessageChannel(sessionId);
 *   const queryHandle = query({ prompt: channel, options });
 *   // When an MQTT message arrives:
 *   channel.yieldMessage("user's text here");
 *   // When the session ends:
 *   channel.close();
 */
export class MessageChannel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiter: ((value: IteratorResult<SDKUserMessage>) => void) | null =
    null;
  private closed = false;

  constructor(private readonly sessionId: string) {}

  /**
   * Push a user message into the channel. If the SDK is already waiting
   * for the next value, it's delivered immediately. Otherwise it's buffered.
   */
  yieldMessage(text: string, images?: ImageInput[]): void {
    const validImages = (images ?? []).filter((img): img is ImageInput =>
      !!img?.data && ALLOWED_IMAGE_TYPES.includes(img.type as ImageMediaType),
    );

    const content = validImages.length === 0
      ? text
      : [
          ...validImages.map((img) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.type as ImageMediaType,
              data: img.data,
            },
          })),
          ...(text ? [{ type: "text" as const, text }] : []),
        ];

    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
    };

    if (this.closed) {
      logger.warn("message-channel", "Message dropped: channel already closed", { sessionId: this.sessionId });
      return;
    }

    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  /**
   * Signal that no more messages will arrive. The async iterator will
   * finish after any buffered messages are drained.
   */
  close(): void {
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.closed) {
        return;
      } else {
        const result = await new Promise<IteratorResult<SDKUserMessage>>(
          (resolve) => {
            this.waiter = resolve;
          }
        );
        if (result.done) return;
        yield result.value;
      }
    }
  }
}
