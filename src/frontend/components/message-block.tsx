
import { useMemo } from "preact/hooks";
import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import DOMPurify from "dompurify";
import { isBlurMode, redactText } from "../utils/demo-mode.js";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);

marked.use(
  markedHighlight({
    highlight(code: string, lang: string) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch {
          /* fall through */
        }
      }
      return code;
    },
  }),
);

interface MessageBlockProps {
  kind: "user" | "assistant";
  content: string;
}

export function MessageBlock({ kind, content }: MessageBlockProps) {
  const displayed = isBlurMode() ? redactText(content) : content;
  const html = useMemo(() => {
    if (kind === "user") return null;
    const raw = marked.parse(displayed, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [kind, displayed]);

  if (kind === "user") {
    return <div class="message user" style="white-space: pre-wrap">{displayed}</div>;
  }

  return (
    <div class="message assistant">
      <div
        class="markdown-body"
        dangerouslySetInnerHTML={{ __html: html! }}
      />
    </div>
  );
}
