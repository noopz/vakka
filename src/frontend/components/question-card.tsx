
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { respondQuestion } from "../services/api.js";
import { Clickable } from "./clickable.js";
import type { QuestionEntry, QuestionStatus } from "../../shared/message-types.js";

// Visible-line cap for the "expanded" stage. Anything longer hides the tail
// behind a fade until the user clicks "Show all". Two-stage disclosure:
// (1) <details> hides the answer entirely, (2) when opened, this caps it.
const ANSWER_CAP_LINES = 8;

function ResolvedAnswer({ text }: { text: string }) {
  const showAll = useSignal(false);
  const lines = text.split("\n");
  const isMultiline = lines.length > 1;
  const isLong = lines.length > ANSWER_CAP_LINES;

  // Single-line answer: keep the historical inline summary so common cases
  // ("yes", "canary", a file path) don't get a disclosure triangle.
  if (!isMultiline) {
    return (
      <div class="question-card resolved">
        <span class="resolved-summary">Answered: "{text}"</span>
      </div>
    );
  }

  return (
    <div class="question-card resolved">
      <details class="resolved-details">
        <summary>Answered ({lines.length} lines)</summary>
        <div class={`answer-block${isLong && !showAll.value ? " capped" : ""}`}>
          {text}
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

interface QuestionCardProps {
  questions: QuestionEntry[];
  status: QuestionStatus;
  sessionId: string;
  questionId?: string;
  toolUseId?: string;
  storedAnswers?: string[];
}

export function QuestionCard({
  questions,
  status: initialStatus,
  sessionId,
  questionId,
  toolUseId,
  storedAnswers,
}: QuestionCardProps) {
  const status = useSignal(initialStatus);
  useEffect(() => {
    status.value = initialStatus;
  }, [initialStatus]);
  const loading = useSignal(false);
  // Per-question selected option set. Keyed by question index.
  const selectedByIndex = useSignal<Map<number, Set<string>>>(new Map());
  const freeTextByIndex = useSignal<Map<number, string>>(new Map());
  const submittedAnswers = useSignal<string[]>(storedAnswers ?? []);
  const activeIdx = useSignal(0);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialStatus === "pending" && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

  const getSelected = (idx: number): Set<string> => {
    return selectedByIndex.value.get(idx) ?? new Set();
  };
  const getFreeText = (idx: number): string => {
    return freeTextByIndex.value.get(idx) ?? "";
  };

  const toggleOption = (idx: number, opt: string, multi?: boolean) => {
    const next = new Map(selectedByIndex.value);
    const cur = new Set(next.get(idx) ?? new Set<string>());
    if (multi) {
      if (cur.has(opt)) cur.delete(opt);
      else cur.add(opt);
    } else {
      cur.clear();
      cur.add(opt);
    }
    next.set(idx, cur);
    selectedByIndex.value = next;
  };

  const setFreeText = (idx: number, val: string) => {
    const next = new Map(freeTextByIndex.value);
    next.set(idx, val);
    freeTextByIndex.value = next;
  };

  const handleCancel = async () => {
    loading.value = true;
    try {
      await respondQuestion(sessionId, "", questionId, {
        toolUseId,
        questions,
        answersByQuestion: {},
        cancel: true,
      });
      submittedAnswers.value = ["(cancelled)"];
      status.value = "answered";
    } catch {
      /* best-effort */
    } finally {
      loading.value = false;
    }
  };

  const handleSubmit = async () => {
    // Build per-question answers. Multi-select joins with ", "; single-select
    // takes the first selected option or free-text fallback.
    const answers: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const selected = Array.from(getSelected(i));
      const text = getFreeText(i).trim();
      let answer: string;
      if (q.multiSelect) {
        answer = text ? [...selected, text].join(", ") : selected.join(", ");
      } else if (selected.length > 0) {
        answer = selected[0];
      } else {
        answer = text;
      }
      if (!answer) {
        return;
      }
      answers.push(answer);
    }

    loading.value = true;
    try {
      // The existing API accepts `string | string[]`. For a single question
      // we send a string (back-compat); for multi-question, an array.
      const payload: string | string[] =
        answers.length === 1 ? answers[0] : answers;
      // Build answers map keyed by question text — required by AskUserQuestion's
      // RC-attached control_response wire shape (see api.ts).
      const answersByQuestion: Record<string, string> = {};
      for (let i = 0; i < questions.length; i++) {
        answersByQuestion[questions[i].question] = answers[i];
      }
      await respondQuestion(sessionId, payload, questionId, {
        toolUseId,
        questions,
        answersByQuestion,
      });
      submittedAnswers.value = answers;
      status.value = "answered";
    } catch {
      /* best-effort */
    } finally {
      loading.value = false;
    }
  };

  // Submit is only enabled when every question has a usable answer. Without
  // this, multi-question cards present a button that silently no-ops because
  // `handleSubmit` bails on the first empty answer.
  const canSubmit = questions.every((_q, i) => {
    const hasSelection = getSelected(i).size > 0;
    const hasFreeText = getFreeText(i).trim().length > 0;
    return hasSelection || hasFreeText;
  });

  const resolved = status.value !== "pending";

  if (resolved) {
    const text = (submittedAnswers.value ?? []).join("\n");
    return <ResolvedAnswer text={text} />;
  }

  const isAnswered = (i: number): boolean => {
    return getSelected(i).size > 0 || getFreeText(i).trim().length > 0;
  };
  const idx = Math.min(activeIdx.value, questions.length - 1);
  const q = questions[idx];
  const selected = getSelected(idx);
  const freeText = getFreeText(idx);
  const multi = questions.length > 1;
  const goPrev = () => {
    if (idx > 0) activeIdx.value = idx - 1;
  };
  const goNext = () => {
    if (idx < questions.length - 1) activeIdx.value = idx + 1;
  };

  return (
    <div class="question-card" ref={cardRef}>
      {multi && (
        <div class="question-card-tabs">
          <button
            class="question-card-tab-arrow"
            disabled={idx === 0}
            onClick={goPrev}
            aria-label="Previous question"
          >
            ←
          </button>
          {questions.map((tq, ti) => (
            <button
              key={ti}
              class={`question-card-tab${ti === idx ? " active" : ""}${isAnswered(ti) ? " answered" : ""}`}
              onClick={() => {
                activeIdx.value = ti;
              }}
            >
              <span class="question-card-tab-marker" aria-hidden="true">
                {isAnswered(ti) ? "☑" : "☐"}
              </span>
              <span class="question-card-tab-label">
                {tq.header ?? `Q${ti + 1}`}
              </span>
            </button>
          ))}
          <span class={`question-card-tab-submit${canSubmit ? " ready" : ""}`}>
            <span aria-hidden="true">✓</span> Submit
          </span>
          <button
            class="question-card-tab-arrow"
            disabled={idx === questions.length - 1}
            onClick={goNext}
            aria-label="Next question"
          >
            →
          </button>
        </div>
      )}
      <div class="question-card-entry">
        <div class="question-card-header">
          {multi && (
            <span class="question-card-step">
              {idx + 1}/{questions.length}
            </span>
          )}
          {q.header && <span class="question-card-header-text">{q.header}</span>}
          {q.options && q.options.length > 0 && (
            <span class="question-card-mode">
              {q.multiSelect ? "select any" : "select one"}
            </span>
          )}
        </div>
        <div class="question-card-text">{q.question}</div>
        {q.options && q.options.length > 0 && (
          <div class="question-card-options">
            {q.options.map((opt, optIdx) => (
              <button
                key={opt.label}
                class={`question-card-option${selected.has(opt.label) ? " selected" : ""}`}
                onClick={() => toggleOption(idx, opt.label, q.multiSelect)}
              >
                <span class="question-card-option-key">[{optIdx + 1}]</span>
                <span
                  class={`question-card-option-marker${q.multiSelect ? " multi" : " single"}${selected.has(opt.label) ? " checked" : ""}`}
                  aria-hidden="true"
                >
                  {q.multiSelect
                    ? selected.has(opt.label) ? "☑" : "☐"
                    : selected.has(opt.label) ? "◉" : "○"}
                </span>
                <span class="question-card-option-body">
                  <span class="question-card-option-label">{opt.label}</span>
                  {opt.description && (
                    <span class="question-card-option-desc">— {opt.description}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
        <div class="question-card-textfield-label">or write your own answer</div>
        <textarea
          class="question-card-input"
          placeholder={q.options ? "Type your own preference…" : "Type your answer…"}
          value={freeText}
          rows={2}
          onInput={(e) => {
            setFreeText(idx, (e.target as HTMLTextAreaElement).value);
          }}
        />
      </div>

      <div class="question-card-actions">
        <button
          class="btn btn-primary btn-small"
          disabled={loading.value || !canSubmit}
          onClick={handleSubmit}
        >
          Submit {questions.length > 1 ? `· ${questions.length} answers` : ""}
        </button>
        <button
          class="btn btn-ghost btn-small"
          disabled={loading.value}
          onClick={handleCancel}
          title="Skip and respond via chat"
        >
          Cancel
        </button>
        {!canSubmit && (
          <span class="question-card-hint">
            {questions.length > 1
              ? `${questions.filter((_q, i) => getSelected(i).size > 0 || getFreeText(i).trim()).length} of ${questions.length} answered`
              : "pick an option or type an answer"}
          </span>
        )}
      </div>
    </div>
  );
}
