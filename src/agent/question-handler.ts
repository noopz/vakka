import type { MqttClient } from "mqtt";
import { topics } from "../shared/mqtt.js";
import type { MQTTQuestionMessage, MQTTQuestionResponse } from "../shared/types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Publishes questions to MQTT and awaits answers from the web UI.
 *
 * Used when the agent needs human input that isn't a permission check
 * (e.g., the SDK's askQuestion / elicitation flow).
 */
export class QuestionHandler {
  private pending = new Map<string, Deferred<MQTTQuestionResponse>>();
  private nextId = 0;

  constructor(
    private mqttClient: MqttClient,
    private sessionId: string,
  ) {}

  /** Called when an MQTT question_response message arrives. */
  handleResponse(data: MQTTQuestionResponse & { questionId?: string }): void {
    if (data.questionId) {
      const deferred = this.pending.get(data.questionId);
      if (deferred) {
        deferred.resolve(data);
        return;
      }
    }

    // Fallback: resolve the oldest pending question
    for (const [id, deferred] of this.pending) {
      this.pending.delete(id);
      deferred.resolve(data);
      return;
    }
  }

  /**
   * Publish a question to MQTT and wait for the user's answer.
   *
   * @returns The user's answer (string or string[] for multiSelect).
   */
  async askQuestion(
    question: string,
    options?: {
      options?: string[];
      allowFreeText?: boolean;
      multiSelect?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<string | string[]> {
    const questionId = `q-${this.nextId++}`;
    const deferred = createDeferred<MQTTQuestionResponse>();
    this.pending.set(questionId, deferred);

    const message: MQTTQuestionMessage & { questionId: string } = {
      question,
      questionId,
      ...(options?.options && { options: options.options }),
      ...(options?.allowFreeText !== undefined && { allowFreeText: options.allowFreeText }),
      ...(options?.multiSelect !== undefined && { multiSelect: options.multiSelect }),
    };

    this.mqttClient.publish(
      topics(this.sessionId).question,
      JSON.stringify(message),
    );

    // Handle abort
    if (options?.signal) {
      const onAbort = () => {
        this.pending.delete(questionId);
        deferred.reject(new Error("Question aborted"));
      };
      options.signal.addEventListener("abort", onAbort, { once: true });

      let response: MQTTQuestionResponse;
      try {
        response = await deferred.promise;
      } finally {
        this.pending.delete(questionId);
        options.signal.removeEventListener("abort", onAbort);
      }
      return response.answer;
    }

    let response: MQTTQuestionResponse;
    try {
      response = await deferred.promise;
    } finally {
      this.pending.delete(questionId);
    }
    return response.answer;
  }
}
