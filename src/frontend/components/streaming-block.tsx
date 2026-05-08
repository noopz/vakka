
import { streamingContent } from "../signals/index.js";
import { isBlurMode, redactText } from "../utils/demo-mode.js";

export function StreamingBlock() {
  const raw = streamingContent.value;
  if (!raw) return null;
  const content = isBlurMode() ? redactText(raw) : raw;

  return (
    <div class="message assistant">
      <div
        style="white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; display: inline"
      >
        {content}
      </div>
      <span class="streaming-cursor" />
    </div>
  );
}
