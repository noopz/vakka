
import { useSignal } from "@preact/signals";
import { Clickable } from "./clickable.js";

interface ToolResultBlockProps {
  toolName: string;
  output: string;
  isError: boolean;
  toolSummary?: string;
  toolInput?: Record<string, unknown> | null;
}

export function ToolResultBlock({ toolName, output, isError, toolSummary, toolInput }: ToolResultBlockProps) {
  const expanded = useSignal(false);
  const lines = output.split("\n");
  const firstLine = lines[0] ?? "";
  const summary = toolSummary?.trim() ?? "";
  const headline = summary || firstLine.slice(0, 120);
  const truncatedHeadline = headline.length > 140 ? headline.slice(0, 140) : headline;
  const hasMore =
    output.trim().length > 0 ||
    lines.length > 1 ||
    firstLine.length > 120 ||
    headline.length > 140 ||
    !!toolInput;

  return (
    <div class={`tool-result ${isError ? "tool-result-error" : ""}`}>
      <Clickable
        class="tool-result-header"
        onClick={() => {
          if (hasMore) expanded.value = !expanded.value;
        }}
        disabled={!hasMore}
      >
        <span class="tool-result-icon">{isError ? "✗" : "✓"}</span>
        <span class="tool-result-name">{toolName}</span>
        <span class="tool-result-preview">{truncatedHeadline}{hasMore && !expanded.value ? "…" : ""}</span>
        {hasMore && (
          <span class="tool-result-toggle">{expanded.value ? "▾" : "▸"}</span>
        )}
      </Clickable>
      {expanded.value && (
        <div class="tool-result-body">
          {toolInput && <ToolInputView toolName={toolName} input={toolInput} />}
          {output.trim().length > 0 && (
            <pre class="tool-result-output">{output}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function ToolInputView({
  toolName,
  input,
}: {
  toolName: string;
  input: Record<string, unknown>;
}) {
  // Edit / MultiEdit: show old_string → new_string as a unified-ish diff.
  if (toolName === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    return <DiffView oldStr={input.old_string} newStr={input.new_string} />;
  }
  if (toolName === "MultiEdit" && Array.isArray((input as any).edits)) {
    const edits = (input as any).edits as Array<{ old_string: string; new_string: string }>;
    return (
      <div class="tool-input-multi">
        {edits.map((e, i) => (
          <div key={i} class="tool-input-multi-edit">
            <div class="tool-input-multi-label">edit {i + 1}</div>
            <DiffView oldStr={e.old_string ?? ""} newStr={e.new_string ?? ""} />
          </div>
        ))}
      </div>
    );
  }
  // Write: show the file contents.
  if (toolName === "Write" && typeof input.content === "string") {
    return <pre class="tool-input-content">{input.content}</pre>;
  }
  // Bash: show the command.
  if (toolName === "Bash" && typeof input.command === "string") {
    return <pre class="tool-input-command">$ {input.command}</pre>;
  }
  // Fallback: pretty-print JSON.
  return <pre class="tool-input-json">{JSON.stringify(input, null, 2)}</pre>;
}

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  return (
    <pre class="tool-input-diff">
      {oldStr.split("\n").map((l, i) => (
        <div key={`o-${i}`} class="diff-line diff-removed">- {l}</div>
      ))}
      {newStr.split("\n").map((l, i) => (
        <div key={`n-${i}`} class="diff-line diff-added">+ {l}</div>
      ))}
    </pre>
  );
}
