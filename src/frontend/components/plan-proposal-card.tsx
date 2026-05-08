import { useSignal } from "@preact/signals";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { respondPlan } from "../services/api.js";
import type { NormalizedMessage } from "../../shared/message-types.js";

type PlanProposal = Extract<NormalizedMessage, { kind: "plan_proposal" }>;

interface PlanProposalCardProps {
  msg: PlanProposal;
  sessionId: string;
}

export function PlanProposalCard({ msg, sessionId }: PlanProposalCardProps) {
  const status = useSignal(msg.status);
  useEffect(() => {
    status.value = msg.status;
  }, [msg.status]);
  const refining = useSignal(false);
  const feedback = useSignal(msg.feedback ?? "");
  const loading = useSignal(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (msg.status === "pending" && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

  const html = useMemo(() => {
    const raw = marked.parse(msg.plan ?? "", { async: false }) as string;
    return DOMPurify.sanitize(raw, { FORBID_ATTR: ["target"] });
  }, [msg.plan]);

  const submit = async (approved: boolean, fb?: string) => {
    if (!msg.toolUseId) return;
    loading.value = true;
    try {
      await respondPlan(sessionId, {
        approved,
        feedback: fb,
        toolUseId: msg.toolUseId,
      });
      status.value = approved ? "approved" : "rejected";
    } catch {
      /* best-effort */
    } finally {
      loading.value = false;
    }
  };

  if (status.value === "approved") {
    return (
      <div class="plan-proposal-card resolved">
        <span class="resolved-summary">
          <span class="allowed">✓ Approved</span>
        </span>
      </div>
    );
  }

  if (status.value === "rejected") {
    return (
      <div class="plan-proposal-card resolved">
        <span class="resolved-summary">
          <span class="denied">Refined</span>
        </span>
        {feedback.value && (
          <div class="answer-block" style="margin-top: 6px">{feedback.value}</div>
        )}
      </div>
    );
  }

  return (
    <div class="plan-proposal-card" ref={cardRef}>
      <div class="plan-proposal-title">Plan Proposal</div>
      <div
        class="markdown-body plan-proposal-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div class="plan-proposal-actions">
        <button
          class="btn btn-primary btn-small"
          disabled={loading.value}
          onClick={() => submit(true)}
        >
          Approve
        </button>
        <button
          class="btn btn-ghost btn-small"
          disabled={loading.value}
          onClick={() => {
            refining.value = !refining.value;
          }}
        >
          Refine
        </button>
      </div>
      {refining.value && (
        <div class="plan-proposal-refine" style="margin-top: 8px">
          <textarea
            class="plan-proposal-textarea"
            placeholder="Tell the agent how to refine the plan..."
            value={feedback.value}
            onInput={(e) => {
              feedback.value = (e.target as HTMLTextAreaElement).value;
            }}
            rows={3}
            disabled={loading.value}
          />
          <button
            class="btn btn-primary btn-small"
            style="margin-top: 6px"
            disabled={loading.value || !feedback.value.trim()}
            onClick={() => submit(false, feedback.value.trim())}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
