
import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { wsState } from "../signals/index.js";
import { Clickable } from "./clickable.js";

export interface ImageAttachment {
  type: string;
  data: string;
  preview: string;
}

interface RichInputProps {
  onSend: (text: string, images?: ImageAttachment[]) => void;
  onInterrupt?: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
  permissionLabel?: string;
}

const SLASH_COMMANDS = [
  { command: "/compact", description: "Compact context window" },
  { command: "/clear", description: "Start fresh session" },
  { command: "/model", description: "Change model (sonnet/opus/haiku)" },
];

export function RichInput({ onSend, onInterrupt, isStreaming, disabled, permissionLabel }: RichInputProps) {
  const text = useSignal("");
  const images = useSignal<ImageAttachment[]>([]);
  const showSlash = useSignal(false);
  const slashIndex = useSignal(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Cap at ~40% viewport so a long paste doesn't shove the transcript
    // off-screen, but otherwise grow with content.
    const cap = Math.max(160, Math.floor(window.innerHeight * 0.4));
    el.style.height = Math.min(el.scrollHeight, cap) + "px";
  };

  const handleInput = (e: Event) => {
    text.value = (e.target as HTMLTextAreaElement).value;
    resize();
    showSlash.value = text.value.startsWith("/");
    slashIndex.value = 0;
  };

  const filtered = SLASH_COMMANDS.filter((c) =>
    c.command.startsWith(text.value.split(" ")[0])
  );

  const isPhone = /iPhone|Android/i.test(navigator.userAgent);

  const handleKeyDown = (e: KeyboardEvent) => {
    // On mobile, don't intercept Enter — let the keyboard's Send button
    // and the UI Send button handle sending. This allows newlines to work.
    if (isPhone) return;

    if (showSlash.value && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashIndex.value = Math.min(slashIndex.value + 1, filtered.length - 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashIndex.value = Math.max(slashIndex.value - 1, 0);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const cmd = filtered[slashIndex.value];
        if (cmd) {
          text.value = cmd.command + " ";
          showSlash.value = false;
          if (textareaRef.current) textareaRef.current.value = text.value;
        }
        return;
      }
      if (e.key === "Escape") {
        showSlash.value = false;
        return;
      }
    }

    // Escape interrupts the current turn (like Claude Code CLI)
    if (e.key === "Escape" && isStreaming && onInterrupt) {
      e.preventDefault();
      onInterrupt();
      return;
    }

    // Desktop: Enter sends, Shift+Enter for newline
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    // Prefer signal value, fall back to textarea DOM value (mobile IME edge case)
    const t = (text.value || textareaRef.current?.value || "").trim();
    if (!t && images.value.length === 0) return;
    onSend(t, images.value.length > 0 ? images.value : undefined);
    text.value = "";
    images.value = [];
    if (textareaRef.current) {
      textareaRef.current.value = "";
      textareaRef.current.style.height = "auto";
    }
    showSlash.value = false;
  };

  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addImage(file);
      }
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    containerRef.current?.classList.add("drag-over");
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    containerRef.current?.classList.remove("drag-over");
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    containerRef.current?.classList.remove("drag-over");
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        addImage(file);
      }
    }
  };

  const addImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const img = new Image();
      img.onload = () => {
        // Anthropic vision sweet spot: 1568px on the longest edge
        const MAX_DIM = 1568;
        const longest = Math.max(img.width, img.height);
        const fileType = file.type || "image/png";
        const isAnimated = fileType === "image/gif";

        // Pass through small or animated images unchanged
        if (longest <= MAX_DIM || isAnimated) {
          images.value = [
            ...images.value,
            { type: fileType, data: dataUrl.split(",")[1], preview: dataUrl },
          ];
          return;
        }

        const scale = MAX_DIM / longest;
        const newW = Math.round(img.width * scale);
        const newH = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = newW;
        canvas.height = newH;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          // Canvas unavailable — fall back to original
          images.value = [
            ...images.value,
            { type: fileType, data: dataUrl.split(",")[1], preview: dataUrl },
          ];
          return;
        }
        ctx.drawImage(img, 0, 0, newW, newH);
        const resized = canvas.toDataURL("image/jpeg", 0.85);
        images.value = [
          ...images.value,
          { type: "image/jpeg", data: resized.split(",")[1], preview: resized },
        ];
      };
      img.onerror = () => {
        // Decode failed — send original bytes through
        images.value = [
          ...images.value,
          { type: file.type || "image/png", data: dataUrl.split(",")[1], preview: dataUrl },
        ];
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const removeImage = (index: number) => {
    images.value = images.value.filter((_, i) => i !== index);
  };

  const borderColor =
    wsState.value === "connected"
      ? undefined
      : wsState.value === "connecting"
        ? "var(--warning)"
        : "var(--danger)";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag/drop target, not a click target — adding a role would mislead assistive tech.
    <div
      class="rich-input"
      ref={containerRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showSlash.value && filtered.length > 0 && (
        <div class="slash-dropdown">
          {filtered.map((cmd, i) => (
            <Clickable
              key={cmd.command}
              class={`slash-item ${i === slashIndex.value ? "active" : ""}`}
              onClick={() => {
                text.value = cmd.command + " ";
                showSlash.value = false;
                if (textareaRef.current) {
                  textareaRef.current.value = text.value;
                  textareaRef.current.focus();
                }
              }}
            >
              <span class="slash-command">{cmd.command}</span>
              <span class="slash-desc">{cmd.description}</span>
            </Clickable>
          ))}
        </div>
      )}

      {images.value.length > 0 && (
        <div class="image-previews">
          {images.value.map((img, i) => (
            <div key={i} class="image-preview">
              <img src={img.preview} alt="attachment" />
              <button class="image-remove" onClick={() => removeImage(i)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div class="rich-input-stack">
        <textarea
          ref={textareaRef}
          placeholder={disabled ? "Connecting..." : "Type a message…"}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={3}
          enterkeyhint={isPhone ? "send" : undefined}
          style={{ borderColor }}
        />
        <div class="rich-input-footer">
          <div class="rich-input-hints">
            <kbd>↵</kbd> send <span class="rich-input-sep">·</span>
            <kbd>shift</kbd>+<kbd>↵</kbd> newline <span class="rich-input-sep">·</span>
            <kbd>/</kbd> commands
          </div>
          <div class="rich-input-actions">
            {permissionLabel && (
              <span class="rich-input-meta">auto-permission: {permissionLabel}</span>
            )}
            {isStreaming ? (
              <button
                type="button"
                class="btn btn-danger rich-input-send"
                onClick={onInterrupt}
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                class={`btn btn-primary rich-input-send${disabled ? " disabled" : ""}`}
                onClick={handleSend}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
