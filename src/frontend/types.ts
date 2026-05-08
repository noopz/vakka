// Re-export the wire format from the shared types module. The frontend
// renders rows; it does not decode envelopes. The discriminator is `kind`.
export type { NormalizedMessage as Message } from "../shared/message-types.js";
export type {
  NormalizedMessage,
  NormalizedMessageKind,
  AssistantUsage,
  QuestionEntry,
  PermissionStatus,
  QuestionStatus,
  PlanProposalStatus,
} from "../shared/message-types.js";

import type { MQTTContextMessage } from "../shared/types.js";
export type ContextUsage = MQTTContextMessage;
