import { describe, expect, test } from "bun:test";
import {
  topics,
  managerTopics,
  commandTopics,
  systemTopics,
  extractSessionId,
  extractSubtopic,
} from "../src/shared/mqtt.js";

describe("MQTT topics — restart-manager wiring", () => {
  test("topics() exposes hello", () => {
    const t = topics("abc-123");
    expect(t.hello).toBe("vakka/sessions/abc-123/hello");
  });

  test("managerTopics includes hello wildcard", () => {
    expect(managerTopics.hello).toBe("vakka/sessions/+/hello");
  });

  test("commandTopics includes restartManager", () => {
    expect(commandTopics.restartManager).toBe("vakka/commands/restart_manager");
  });

  test("systemTopics has managerOnline and managerHelloRequest", () => {
    expect(systemTopics.managerOnline).toBe("vakka/system/manager/online");
    expect(systemTopics.managerHelloRequest).toBe("vakka/system/manager/hello_request");
  });

  test("extractSessionId / extractSubtopic round-trip on hello topic", () => {
    const t = topics("session-42");
    expect(extractSessionId(t.hello)).toBe("session-42");
    expect(extractSubtopic(t.hello)).toBe("hello");
  });
});
