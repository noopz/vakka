
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { respondPermission } from "../services/api.js";
import { Clickable } from "./clickable.js";
import type { PermissionStatus } from "../../shared/message-types.js";

interface PermissionCardProps {
  tool: string;
  input: Record<string, any>;
  alwaysAsk?: boolean;
  status: PermissionStatus;
  sessionId: string;
  toolUseId?: string;
  onRespond?: () => void;
}

function toolLabel(tool: string): string {
  const t = tool.toLowerCase();
  if (t === "bash") return "Bash";
  if (t === "edit") return "Edit";
  if (t === "write") return "Write";
  return tool;
}

function resolvedSummary(tool: string, input: Record<string, any>): string {
  const t = tool.toLowerCase();
  if (t === "bash") {
    const cmd = input.command ?? "";
    const trimmed = cmd.length > 80 ? cmd.slice(0, 80) + "\u2026" : cmd;
    return `${toolLabel(tool)} ${trimmed}`;
  }
  if (t === "edit" || t === "write") {
    return `${toolLabel(tool)} ${input.file_path ?? input.filePath ?? ""}`;
  }
  return `${toolLabel(tool)}`;
}

function countDiffLines(old_string?: string, new_string?: string): number {
  const removed = old_string ? old_string.split("\n").length : 0;
  const added = new_string ? new_string.split("\n").length : 0;
  return removed + added;
}

const RESOLVED_CAP_LINES = 8;

// Pull a multi-line "body" out of resolved permission input where applicable.
// bash with embedded newlines and write with file content benefit from the
// same disclosure pattern as long question answers; everything else stays flat.
function resolvedBody(tool: string, input: Record<string, any>): string | null {
  const t = tool.toLowerCase();
  if (t === "bash") {
    const cmd: string = input.command ?? "";
    return cmd.includes("\n") ? cmd : null;
  }
  if (t === "write") {
    const content: string = input.content ?? "";
    return content.includes("\n") ? content : null;
  }
  return null;
}

function ResolvedPermission({
  tool,
  input,
  status,
}: {
  tool: string;
  input: Record<string, any>;
  status: "allowed" | "denied";
}) {
  const showAll = useSignal(false);
  const body = resolvedBody(tool, input);
  const verdict = (
    <span class={status === "allowed" ? "allowed" : "denied"}>
      {status === "allowed" ? "✓ Allowed" : "✗ Denied"}
    </span>
  );

  if (!body) {
    return (
      <div class="permission-card resolved">
        <span class="resolved-summary">
          {verdict}
          {": "}
          {resolvedSummary(tool, input)}
        </span>
      </div>
    );
  }

  const lines = body.split("\n");
  const isLong = lines.length > RESOLVED_CAP_LINES;
  const label = toolLabel(tool);
  const filePath = input.file_path ?? input.filePath ?? "";

  return (
    <div class="permission-card resolved">
      <details class="resolved-details">
        <summary>
          {verdict}
          {": "}
          {label}
          {filePath ? ` ${filePath} ` : " "}
          ({lines.length} lines)
        </summary>
        <div class={`answer-block${isLong && !showAll.value ? " capped" : ""}`}>
          {body}
        </div>
        {isLong && (
          <Clickable
            class="answer-toggle"
            onClick={() => {
              showAll.value = !showAll.value;
            }}
          >
            {showAll.value ? "▴ Show less" : `▾ Show all (${lines.length} lines)`}
          </Clickable>
        )}
      </details>
    </div>
  );
}

export function PermissionCard({
  tool,
  input,
  alwaysAsk,
  status: initialStatus,
  sessionId,
  toolUseId,
  onRespond,
}: PermissionCardProps) {
  // Sanity guard: AskUserQuestion + ExitPlanMode are now routed to dedicated
  // kinds (`question` / `plan_proposal`) at normalize time. Reaching here
  // indicates a server-side routing bug.
  if (tool === "AskUserQuestion" || tool === "ExitPlanMode") {
    console.error(
      "permission-card received",
      tool,
      "— should be routed to",
      tool === "AskUserQuestion" ? "question-card" : "plan-proposal-card",
    );
    return null;
  }
  const status = useSignal(initialStatus);
  useEffect(() => { status.value = initialStatus; }, [initialStatus]);
  const loading = useSignal(false);
  const diffExpanded = useSignal(false);
  const denyFeedback = useSignal("");
  const cardRef = useRef<HTMLDivElement>(null);

  // Scroll a freshly-mounted pending card into view. The agent is blocked
  // until the user responds, so it should never sit silently below the fold.
  useEffect(() => {
    if (initialStatus === "pending" && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

  const respond = async (decision: "allow" | "deny" | "allow_always", message?: string) => {
    loading.value = true;
    try {
      await respondPermission(sessionId, decision, tool, toolUseId, message);
      status.value = decision === "deny" ? "denied" : "allowed";
      onRespond?.();
    } catch {
      /* best-effort */
    } finally {
      loading.value = false;
    }
  };

  const resolved = status.value !== "pending";
  const t = tool.toLowerCase();

  if (resolved) {
    return (
      <ResolvedPermission
        tool={tool}
        input={input}
        status={status.value as "allowed" | "denied"}
      />
    );
  }

  // Headline summary used in the head row (Bash \u00B7 ls /tmp, Edit \u00B7 path, etc.)
  const headline = (() => {
    if (t === "bash") {
      const cmd = (input.command ?? "").toString();
      const trimmed = cmd.length > 60 ? cmd.slice(0, 60) + "\u2026" : cmd;
      return trimmed ? `${toolLabel(tool)} \u00B7 ${trimmed}` : toolLabel(tool);
    }
    if (t === "edit" || t === "write") {
      const fp = input.file_path ?? input.filePath ?? "";
      return fp ? `${toolLabel(tool)} \u00B7 ${fp}` : toolLabel(tool);
    }
    return toolLabel(tool);
  })();

  return (
    <div class="permission-card" ref={cardRef}>
      <div class="permission-card-head">
        <span class="permission-card-kind">Permission</span>
        <span class="permission-card-headline">{headline}</span>
      </div>

      <div class="permission-card-body">
        <p class="permission-card-question">Allow this {t === "bash" ? "command" : t === "edit" || t === "write" ? "change" : "tool call"}?</p>

        {t === "bash" && (
          <pre class="permission-card-tool">{input.command ?? JSON.stringify(input, null, 2)}</pre>
        )}

        {t === "edit" && (
          <>
            <div class="permission-card-meta">
              {countDiffLines(input.old_string, input.new_string)} lines changed
            </div>
            {(input.old_string || input.new_string) && (
              <>
                <Clickable
                  class="permission-diff-toggle"
                  onClick={() => {
                    diffExpanded.value = !diffExpanded.value;
                  }}
                >
                  {diffExpanded.value ? "\u25BE Hide diff" : "\u25B8 Show diff"}
                </Clickable>
                {diffExpanded.value && (
                  <div class="permission-diff">
                    {input.old_string && (
                      <span class="permission-diff-old">- {input.old_string}</span>
                    )}
                    {input.new_string && (
                      <span class="permission-diff-new">+ {input.new_string}</span>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {t !== "bash" && t !== "edit" && t !== "write" && (
          <pre class="permission-card-tool">
            {(() => {
              const raw = JSON.stringify(input, null, 2);
              return raw.length > 300 ? raw.slice(0, 300) + "\u2026" : raw;
            })()}
          </pre>
        )}

        <input
          type="text"
          class="permission-deny-input"
          placeholder="Deny reason (optional)"
          value={denyFeedback.value}
          onInput={(e: Event) => { denyFeedback.value = (e.target as HTMLInputElement).value; }}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" && denyFeedback.value) respond("deny", denyFeedback.value); }}
          disabled={loading.value}
        />

        <div class="permission-card-actions">
          <button
            class="btn btn-danger"
            disabled={loading.value}
            onClick={() => respond("deny", denyFeedback.value || undefined)}
          >
            Deny
          </button>
          {!alwaysAsk && (
            <button
              class="btn"
              disabled={loading.value}
              onClick={() => respond("allow_always")}
            >
              Always allow
            </button>
          )}
          <button
            class="btn btn-primary"
            disabled={loading.value}
            onClick={() => respond("allow")}
          >
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
}
