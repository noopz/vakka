import mqtt from "mqtt";
import { getConfig } from "./config.js";
import { loadMqttCreds } from "../web/auth.js";

// Topic builder
export function topics(sessionId: string) {
  const base = `vakka/sessions/${sessionId}`;
  return {
    input: `${base}/input`,
    output: `${base}/output`,
    status: `${base}/status`,
    cost: `${base}/cost`,
    permission: `${base}/permission`,
    permissionResponse: `${base}/permission_response`,
    question: `${base}/question`,
    questionResponse: `${base}/question_response`,
    interrupt: `${base}/interrupt`,
    context: `${base}/context`,
    hello: `${base}/hello`,
    mode: `${base}/mode`,
    chatMessages: `${base}/chat_messages`,
  };
}

// Wildcard topics for manager subscription
export const managerTopics = {
  input: "vakka/sessions/+/input",
  output: "vakka/sessions/+/output",
  status: "vakka/sessions/+/status",
  cost: "vakka/sessions/+/cost",
  permission: "vakka/sessions/+/permission",
  permissionResponse: "vakka/sessions/+/permission_response",
  question: "vakka/sessions/+/question",
  questionResponse: "vakka/sessions/+/question_response",
  interrupt: "vakka/sessions/+/interrupt",
  context: "vakka/sessions/+/context",
  hello: "vakka/sessions/+/hello",
};

// Command topics
export const commandTopics = {
  spawn: "vakka/commands/spawn",
  kill: "vakka/commands/kill",
  restart: "vakka/commands/restart",
  restartManager: "vakka/commands/restart_manager",
  resume: "vakka/commands/resume",
  response: "vakka/commands/response",
};

// System-wide topics (manager liveness, hello requests)
export const systemTopics = {
  managerOnline: "vakka/system/manager/online",
  managerHelloRequest: "vakka/system/manager/hello_request",
};

// Extract session ID from a topic string like "vakka/sessions/{id}/output"
export function extractSessionId(topic: string): string | null {
  const match = topic.match(/^vakka\/sessions\/([^/]+)\//);
  return match ? match[1] : null;
}

// Extract the subtopic (output, status, etc.) from a topic string
export function extractSubtopic(topic: string): string | null {
  const match = topic.match(/^vakka\/sessions\/[^/]+\/(.+)$/);
  return match ? match[1] : null;
}

// Create an MQTT client with standard options. Reads broker auth credentials
// from the shared auth.json (seeded by the manager on first boot). Throws if
// creds aren't initialized — the broker is configured `allow_anonymous false`,
// so connecting without creds would just be refused anyway.
export function createMQTTClient(
  clientId: string,
  extraOptions?: Partial<mqtt.IClientOptions>,
): mqtt.MqttClient {
  const config = getConfig();
  let creds: { username: string; password: string };
  try {
    creds = loadMqttCreds();
  } catch (err) {
    throw new Error(
      `createMQTTClient: failed to load MQTT credentials — ${(err as Error).message}`,
    );
  }
  return mqtt.connect(config.mqttHost, {
    clientId: `vakka-${clientId}-${process.pid}`,
    clean: true,
    reconnectPeriod: 1000,
    username: creds.username,
    password: creds.password,
    ...extraOptions,
  });
}
