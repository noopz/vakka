
import { useEffect, useRef } from "preact/hooks";
import { useSignal, useComputed } from "@preact/signals";

// uuid() unavailable on non-secure contexts (LAN IP on iOS Safari)
const uuid = typeof crypto.randomUUID === "function"
  ? () => crypto.randomUUID()
  : () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
import {
  messages,
  streamingContent,
  streamingMessageId,
  currentSessionId,
  wsState,
  sessions,
  contextUsage,
  managerRestarting,
  previewSession,
  previewLookupSettled,
  projects,
} from "../signals/index.js";
import { fetchMessages, fetchContextUsage, sendMessage, setPermissionMode, restartSession, killSession, interruptSession, fetchSessions, restartManager, createSession, fetchTranscript, fetchMessageCount } from "../services/api.js";
import { useNav } from "../routes/nav.js";
import type { ProjectSession } from "../services/api.js";
import { wsManager } from "../services/websocket-manager.js";
import { MessageBlock } from "../components/message-block.js";
import { StreamingBlock } from "../components/streaming-block.js";
import { PermissionCard } from "../components/permission-card.js";
import { QuestionCard } from "../components/question-card.js";
import { PlanProposalCard } from "../components/plan-proposal-card.js";
import { ContextPanel } from "../components/context-panel.js";
import { RichInput } from "../components/rich-input.js";
import { ToolResultBlock } from "../components/tool-result-block.js";
import type { Message } from "../types.js";
import type { NormalizedMessage } from "../../shared/message-types.js";
import { formatRelative } from "../utils/time.js";
import { isDemoMode, redactSlug, redactId } from "../utils/demo-mode.js";

// Above which loaded-row count we shade the depth bar amber and surface the
// "investigate trim?" hint. Picked empirically — DOM scroll feels fine well
// past this; the bar's job is to flag *before* it gets bad. See
// mocks/transcript-depth-indicator.html for the visual states.
const HEAVY_THRESHOLD = 2000;

interface DepthBarProps {
  loaded: number;
  total: number | null;
  loading?: boolean; // initial fetch still in-flight
  fetchingOlder?: boolean; // backward pagination in progress
}

/** Sticky depth indicator for the top of any message-list. Same shape for
 *  ChatView and PreviewView — only the data source differs. */
function TranscriptDepthBar({
  loaded,
  total,
  loading,
  fetchingOlder,
}: DepthBarProps) {
  if (loading && loaded === 0) {
    return (
      <div class="depth-bar is-loading">
        <span class="icon">⤓</span>
        <span class="label-text">loading transcript…</span>
        <div class="rail">
          <div class="fill" style="width: 0%" />
          <div class="shimmer" />
        </div>
        <span class="hint">&nbsp;</span>
      </div>
    );
  }

  // Total unknown (count endpoint failed / not yet returned) — degrade
  // gracefully to a count-only display.
  if (total == null || total <= 0) {
    return (
      <div class="depth-bar is-complete">
        <span class="icon">●</span>
        <span class="label-text">
          <strong>{loaded}</strong>{" "}
          <span class="of">{loaded === 1 ? "message" : "messages"}</span>
        </span>
        <div />
        <span class="hint">&nbsp;</span>
      </div>
    );
  }

  const complete = loaded >= total;
  const heavy = loaded > HEAVY_THRESHOLD;
  const cls = fetchingOlder
    ? "is-loading"
    : heavy
      ? "is-heavy"
      : complete
        ? "is-complete"
        : "is-partial";
  const icon = fetchingOlder ? "⤓" : heavy ? "⚠" : complete ? "●" : "⤒";
  const pct = Math.max(2, Math.min(100, Math.round((loaded / total) * 100)));
  const hint = fetchingOlder
    ? "loading older…"
    : heavy
      ? "heavy — investigate trim?"
      : complete
        ? "complete"
        : "scroll up to load older";

  return (
    <div class={`depth-bar ${cls}`}>
      <span class="icon">{icon}</span>
      <span class="label-text">
        {complete ? (
          <>
            all <strong>{total.toLocaleString()}</strong>{" "}
            <span class="of">{total === 1 ? "message" : "messages"}</span>
          </>
        ) : (
          <>
            <strong>{loaded.toLocaleString()}</strong>{" "}
            <span class="of">of</span>{" "}
            <strong>{total.toLocaleString()}</strong>
          </>
        )}
      </span>
      <div class="rail reverse">
        <div class="fill" style={`width: ${pct}%`} />
        {fetchingOlder && <div class="shimmer" />}
      </div>
      <span class="hint">{hint}</span>
      {heavy && (
        <div class="tooltip">
          <dl>
            <dt>in DOM</dt>
            <dd>{loaded.toLocaleString()}</dd>
            <dt>on disk</dt>
            <dd>{total.toLocaleString()}</dd>
            <dt>not loaded</dt>
            <dd>{(total - loaded).toLocaleString()}</dd>
          </dl>
          <div class="heavy-note">
            DOM row count crossed the {HEAVY_THRESHOLD.toLocaleString()}{" "}
            threshold. If scroll feels janky, this is the place to investigate
            forward / backward trim.
          </div>
        </div>
      )}
    </div>
  );
}

interface PreviewViewProps {
  preview: { candidate: ProjectSession; project_path: string };
}

function PreviewView({ preview }: PreviewViewProps) {
  const previewItems = useSignal<NormalizedMessage[]>([]);
  const loading = useSignal(true);
  const loadingOlder = useSignal(false);
  const committing = useSignal(false);
  const listRef = useRef<HTMLDivElement>(null);
  // Pagination cursors against the absolute jsonl record index. `oldestIndex`
  // is the inclusive lower bound of what's currently in the DOM — fetching
  // older means asking for `before: oldestIndex`. `endIndex` is the exclusive
  // upper bound (used as the next-page anchor for live polling). Signals so
  // the depth-bar (a render-time consumer) updates as pagination progresses.
  const oldestIndex = useSignal<number | null>(null);
  const endIndex = useSignal<number>(0);
  const total = useSignal<number>(0);
  const c = preview.candidate;
  const isLive = c.live;
  const isExternal = c.origin === "external";
  const PAGE_SIZE = 200;

  // Initial load + live-tail polling. We pull only the tail page, so a
  // 10k-record transcript doesn't blow memory just to peek at the latest
  // exchange. Older pages stream in via the scroll-to-top handler below.
  //
  // Server returns NormalizedMessage[] already paired (tool_use → tool_result
  // resolution happens server-side via the manager's transcript decoder), so
  // the frontend just renders the rows.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    oldestIndex.value = null;
    endIndex.value = 0;
    total.value = 0;

    const initialLoad = () => {
      loading.value = true;
      fetchTranscript(c.sdk_session_id, preview.project_path, {
        limit: PAGE_SIZE,
      })
        .then((res) => {
          if (cancelled) return;
          oldestIndex.value = res.startIndex;
          endIndex.value = res.endIndex;
          total.value = res.total;
          previewItems.value = res.messages;
          loading.value = false;
          requestAnimationFrame(() => {
            const list = listRef.current;
            if (list) list.scrollTop = list.scrollHeight;
          });
        })
        .catch(() => {
          if (cancelled) return;
          previewItems.value = [];
          loading.value = false;
        });
    };

    // Live append: poll just for records appended past `endIndex.value`.
    // Cheap change-detection via `total` — skip the parse if no growth.
    const pollTail = () => {
      if (typeof document !== "undefined" && !document.hasFocus()) return;
      fetchTranscript(c.sdk_session_id, preview.project_path, {
        before: undefined,
        limit: Math.max(PAGE_SIZE, 1),
      })
        .then((res) => {
          if (cancelled) return;
          if (res.total === total.value) return;
          // Total grew; merge by NormalizedMessage.id (tail page may overlap
          // what we already have). Existing ids keep their position; new ids
          // append in server order.
          const known = new Set(previewItems.value.map((m) => m.id));
          const appended: NormalizedMessage[] = [];
          for (const m of res.messages) {
            if (!known.has(m.id)) appended.push(m);
          }
          endIndex.value = res.endIndex;
          total.value = res.total;
          if (appended.length === 0) return;
          const list = listRef.current;
          const nearBottom = list
            ? list.scrollHeight - list.scrollTop - list.clientHeight < 120
            : true;
          previewItems.value = [...previewItems.value, ...appended];
          if (nearBottom) {
            requestAnimationFrame(() => {
              if (list) list.scrollTop = list.scrollHeight;
            });
          }
        })
        .catch(() => {});
    };

    initialLoad();

    if (isLive) {
      timer = setInterval(pollTail, 2000);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [c.sdk_session_id, isLive]);

  // Reverse-infinite scroll: when the user gets near the top and we still
  // have older records on disk, fetch the previous page and prepend while
  // preserving scroll position.
  const loadOlder = () => {
    if (loadingOlder.value) return;
    if (oldestIndex.value == null || oldestIndex.value <= 0) return;
    loadingOlder.value = true;
    const before = oldestIndex.value;
    fetchTranscript(c.sdk_session_id, preview.project_path, {
      before,
      limit: PAGE_SIZE,
    })
      .then((res) => {
        if (res.messages.length === 0) {
          oldestIndex.value = res.startIndex;
          loadingOlder.value = false;
          return;
        }
        const known = new Set(previewItems.value.map((m) => m.id));
        const older = res.messages.filter((m) => !known.has(m.id));
        oldestIndex.value = res.startIndex;
        const list = listRef.current;
        const prevHeight = list?.scrollHeight ?? 0;
        const prevTop = list?.scrollTop ?? 0;
        previewItems.value = [...older, ...previewItems.value];
        // Double rAF so Preact's commit + browser layout both flush before
        // we anchor — single rAF occasionally measured the pre-layout height
        // and the viewport jumped.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!list) return;
            list.scrollTop = prevTop + (list.scrollHeight - prevHeight);
            loadingOlder.value = false;
          });
        });
      })
      .catch(() => {
        loadingOlder.value = false;
      });
  };

  const handleScroll = () => {
    const list = listRef.current;
    if (!list) return;
    if (
      list.scrollTop < 100 &&
      !loadingOlder.value &&
      oldestIndex.value != null &&
      oldestIndex.value > 0
    ) {
      loadOlder();
    }
  };

  const nav = useNav();
  const handleBack = () => {
    const slug = projects.value.find((p) => p.path === preview.project_path)?.display_slug;
    previewSession.value = null;
    if (slug) nav.goProject(slug, true);
    else nav.goHome(true);
  };

  // First-message commit: spawn the wrapper with the right resume flag, then
  // forward the prompt as the initial input. Manager picks fork-vs-in-place.
  const handleCommit = async (incoming: string) => {
    const text = incoming.trim();
    if (!text || committing.value) return;
    committing.value = true;
    try {
      const resumeFrom = c.origin === "vakka" ? c.vakka_session_id ?? undefined : undefined;
      const resumeFromExternal = c.origin === "external" ? c.sdk_session_id : undefined;
      const res = await createSession(preview.project_path, undefined, resumeFrom, resumeFromExternal, "rc-spawned");
      const newId = res.sessionId ?? res.id;
      if (!newId) {
        committing.value = false;
        return;
      }
      // Send the user's first message into the freshly-spawned wrapper.
      try {
        await sendMessage(newId, text);
      } catch (err) {
        console.warn("[preview] failed to deliver first message:", err);
      }
      fetchSessions().then((s) => { sessions.value = s; }).catch(() => {});
      previewSession.value = null;
      currentSessionId.value = newId;
      // Navigate to the new session's URL so chat-route's URL-driven sync
      // doesn't stomp currentSessionId back to the old sdk_session_id from
      // the preview URL on the next render.
      const slug = projects.value.find((p) => p.path === preview.project_path)?.display_slug;
      if (slug) nav.goSession(slug, newId, true);
    } finally {
      committing.value = false;
    }
  };

  const _demoPv = isDemoMode();
  const _rawProjectName =
    projects.value.find((p) => p.path === preview.project_path)?.name ??
    preview.project_path.split("/").pop() ??
    preview.project_path;
  const projectName = _demoPv ? redactSlug(_rawProjectName) : _rawProjectName;

  return (
    <div class="main-panel preview-panel">
      <div class="chat-header preview-header">
        <div class="ch-title-block">
          <button class="ch-title-link" onClick={handleBack} title="Back to project">
            <span class="chev">‹</span>
            <span class="ch-title">{projectName}</span>
          </button>
          <span class="ch-sub">
            <span>{_demoPv ? redactId(c.sdk_session_id) : c.sdk_session_id.slice(0, 8)}</span>
            <span class="ch-sub-dot">·</span>
            <span>{formatRelative(c.mtime)}</span>
          </span>
        </div>
        {isLive && <span class="resume-card-badge live">live</span>}
        {isExternal && <span class="resume-card-badge cli">CLI</span>}
      </div>

      {isLive && (
        <div class="preview-banner">
          Claude Code is writing here right now
          {c.live_holder ? ` (pid ${c.live_holder.pid})` : ""}.
          Sending creates a fork — the original keeps going untouched.
        </div>
      )}

      <TranscriptDepthBar
        loaded={
          // Records consumed = endIndex - oldestIndex. Counts raw jsonl lines
          // (not just displayable ones) so reaching `oldestIndex == 0` hits
          // "complete" regardless of how many records the parser drops.
          oldestIndex.value == null
            ? 0
            : Math.max(0, endIndex.value - oldestIndex.value)
        }
        total={total.value || null}
        loading={loading.value}
        fetchingOlder={loadingOlder.value}
      />

      <div class="message-list preview-list" ref={listRef} onScroll={handleScroll}>
        {loading.value && <div class="preview-loading">Loading transcript…</div>}
        {!loading.value &&
          !loadingOlder.value &&
          oldestIndex.value === 0 &&
          previewItems.value.length > 0 && (
            <div class="preview-loading" style="opacity: 0.5;">
              Beginning of transcript
            </div>
          )}
        {!loading.value && previewItems.value.length === 0 && (
          <div class="preview-loading">Nothing readable in this transcript.</div>
        )}
        {!loading.value &&
          previewItems.value.map((msg) => {
            // Server-side decoder pre-pairs tool_use → tool_result and stamps
            // toolName / toolSummary on the result row, so the render is a
            // straight switch over kinds — same shape ChatView uses for live
            // sessions.
            switch (msg.kind) {
              case "user":
                return (
                  <MessageBlock key={msg.id} kind="user" content={msg.text} />
                );
              case "assistant":
                return (
                  <MessageBlock
                    key={msg.id}
                    kind="assistant"
                    content={msg.text}
                  />
                );
              case "tool_use":
                // Folded into the matching tool_result. If the session is
                // live and the result hasn't arrived yet, the call is silent
                // (mirrors live ChatView's "thinking" gap).
                return null;
              case "tool_result":
                if (msg.toolName === "AskUserQuestion" || msg.toolName === "ExitPlanMode") {
                  return null;
                }
                return (
                  <ToolResultBlock
                    key={msg.id}
                    toolName={msg.toolName}
                    toolSummary={msg.toolSummary}
                    output={msg.output}
                    isError={msg.isError}
                  />
                );
              case "system":
                return (
                  <div key={msg.id} class="message system">
                    {msg.text}
                  </div>
                );
              case "compact_summary":
                return (
                  <details key={msg.id} class="compact-summary">
                    <summary>
                      <span class="compact-summary-icon">⟳</span>
                      <span class="compact-summary-title">
                        Compacted summary
                      </span>
                      <span class="compact-summary-hint">click to expand</span>
                    </summary>
                    <div class="compact-summary-body">{msg.text}</div>
                  </details>
                );
              default:
                // permission_request, question, plan_proposal, compact: not
                // useful on a static preview (they're interactive cards keyed
                // to a live sessionId). Skip.
                return null;
            }
          })}
        {isLive && !loading.value && (
          <div class="preview-live-indicator">
            <span class="live-dot" /> live · refreshing every 2s
          </div>
        )}
      </div>

      <RichInput
        onSend={(text) => handleCommit(text)}
        disabled={committing.value}
        permissionLabel={isLive ? "fork & continue" : "continue"}
      />
    </div>
  );
}

// CC-style action verbs keyed by tool name. Falls back to "thinking" when
// the agent is between tool calls (composing a response, awaiting LLM tokens).
const ACTION_VERBS: Record<string, string> = {
  Bash: "running",
  Read: "reading",
  Write: "writing",
  Edit: "editing",
  MultiEdit: "editing",
  Glob: "searching",
  Grep: "searching",
  WebFetch: "fetching",
  WebSearch: "searching",
  Task: "delegating",
  Hook: "running hooks",
  TodoWrite: "planning",
  ExitPlanMode: "planning",
  NotebookEdit: "editing",
};

function ThinkingIndicator({
  sinceMs,
  action,
}: {
  sinceMs: number;
  action: string | null;
}) {
  const tick = useSignal(0);
  useEffect(() => {
    const id = setInterval(() => {
      tick.value = tick.value + 1;
    }, 1000);
    return () => clearInterval(id);
  }, []);
  void tick.value; // re-render trigger
  const elapsed = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  const verb = action ? (ACTION_VERBS[action] ?? action.toLowerCase()) : "thinking";
  const detail = action && verb !== action.toLowerCase() ? ` (${action})` : "";
  return (
    <div class="thinking-indicator">
      <span class="thinking-dots"><i /><i /><i /></span>
      <span class="thinking-verb">{verb}{detail}…</span>
      <span class="thinking-elapsed">{elapsed}s</span>
      <span class="thinking-hint">esc to interrupt</span>
    </div>
  );
}

export function ChatView() {
  const sessionId = currentSessionId.value;
  const preview = previewSession.value;

  // Lazy preview takes precedence: if the user clicked an idle session card,
  // render the jsonl directly without spawning. We check preview *before*
  // sessionId because chat-route sets currentSessionId from the URL eagerly,
  // but for an idle session that id is the SDK session id (not a Vakka DB
  // row), so the live message-fetch path would mis-key and show empty state.
  if (preview) {
    return <PreviewView preview={preview} />;
  }

  if (!sessionId) {
    // Home-route owns the empty/dashboard surface now; ChatView only mounts
    // when there's an active session or preview, so render nothing here.
    return null;
  }

  const nav = useNav();
  const cost = useSignal(0);
  const sessionStatus = useSignal("");
  const permissionMode = useSignal("default");
  const showMenu = useSignal(false);
  const showModeMenu = useSignal(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const agentBusy = useSignal(false);
  const busySinceMs = useSignal<number | null>(null);

  // Latest pending tool_use (a tool_use row whose toolUseId has no matching
  // tool_result yet) drives the "running X" thinking-indicator label. Pure
  // derivation from the row stream — no envelope inspection required.
  const currentAction = useComputed<string | null>(() => {
    const ms = messages.value;
    const resolved = new Set<string>();
    for (const m of ms) {
      if (m.kind === "tool_result" && m.toolUseId) resolved.add(m.toolUseId);
      // Question/permission/plan_proposal cards in a terminal state also
      // resolve their underlying tool_use — CC has unblocked even though no
      // synthetic tool_result row is emitted (deny via rc-relay etc.).
      if (
        m.kind === "question" &&
        m.toolUseId &&
        m.status !== "pending"
      ) {
        resolved.add(m.toolUseId);
      }
      if (
        m.kind === "permission_request" &&
        m.toolUseId &&
        m.status !== "pending"
      ) {
        resolved.add(m.toolUseId);
      }
      if (
        m.kind === "plan_proposal" &&
        m.toolUseId &&
        m.status !== "pending"
      ) {
        resolved.add(m.toolUseId);
      }
    }
    for (let i = ms.length - 1; i >= 0; i--) {
      const m = ms[i];
      if (m.kind === "tool_use" && !resolved.has(m.toolUseId)) {
        return m.toolName;
      }
    }
    return null;
  });

  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Pagination state
  const isLoadingOlder = useSignal(false);
  const hasOlderMessages = useSignal(true);
  const oldestLoadedId = useSignal<number | null>(null);
  const messageTotal = useSignal<number | null>(null);

  // Find session info
  const session = sessions.value.find((s) => s.id === sessionId);
  const _demo = isDemoMode();
  const projectName = session
    ? (_demo
        ? redactSlug(session.project_path.split("/").pop() ?? "")
        : session.project_path.split("/").pop())
    : (_demo ? redactId(sessionId) : sessionId.slice(0, 8));
  // Stale: chat-route's preview-lookup has settled on this id, found no
  // candidate, AND no live Vakka session matches. Means the URL points at a
  // session id we can't resolve via either the live Vakka feed or any
  // external CLI candidate. Show a hint instead of silently failing on send.
  const isStale =
    previewLookupSettled.value === sessionId &&
    !session &&
    sessions.value.length > 0;

  // Auto-scroll helper
  const scrollToBottom = () => {
    const list = listRef.current;
    if (!list) return;
    const nearBottom =
      list.scrollHeight - list.scrollTop - list.clientHeight < 100;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior });
    }
  };

  // Scroll on message changes
  useEffect(() => {
    scrollToBottom();
  }, [messages.value.length, streamingContent.value]);

  // Load messages + subscribe WS on mount
  useEffect(() => {
    // Fetch latest messages (no cursor = server returns most recent N).
    // API returns NormalizedMessage[] post-C3; assign verbatim.
    fetchMessages(sessionId)
      .then((rows) => {
        messages.value = rows;

        // Track oldest DB row id for "load older" pagination. The
        // NormalizedMessage `id` is the persisted chat_messages row id as a
        // string.
        if (rows.length > 0) {
          const firstId = Number(rows[0].id);
          oldestLoadedId.value = Number.isFinite(firstId) ? firstId : null;
          hasOlderMessages.value = rows.length >= 200;
        } else {
          hasOlderMessages.value = false;
        }

        // Scroll to bottom after initial load
        requestAnimationFrame(() => {
          bottomRef.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior });
        });
      })
      .catch((err) => {
        console.error("[chat] Failed to load messages:", err);
      });

    fetchContextUsage(sessionId)
      .then((ctx) => { contextUsage.value = ctx; })
      .catch(() => {});

    fetchMessageCount(sessionId)
      .then(({ total }) => { messageTotal.value = total; })
      .catch(() => {});

    // Set initial cost/status from session info
    if (session) {
      cost.value = session.cost_usd;
      sessionStatus.value = session.status;
    }

    // Subscribe to WS updates for this session
    wsManager.subscribe(sessionId);

    const onMessage = (e: Event) => {
      const raw = (e as CustomEvent).detail;
      if (raw.sessionId !== sessionId) return;

      // Snapshot replay on (re)subscribe — replaces any stale streaming state
      // with the server-side accumulator. Always set, never append, so a tab
      // that navigated away and back doesn't double up the prefix.
      if (raw.type === "stream_snapshot") {
        streamingContent.value = raw.text ?? "";
        streamingMessageId.value = raw.uuid ?? "streaming";
        if (raw.text) agentBusy.value = true;
        return;
      }

      // Unified row broadcast. The server normalizes input/output/permission/
      // question/permission_response/question_response into NormalizedMessage[]
      // and broadcasts under this single envelope type.
      if (raw.type === "chat_messages") {
        handleSdkMessage(raw);
        requestAnimationFrame(() => {
          bottomRef.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior });
        });
        return;
      }

      const subtopic: string = raw.subtopic ?? raw.type ?? "";
      // Unwrap MQTT payload — backend sends { type: "mqtt", sessionId, subtopic, data: <payload> }
      const payload = raw.data ?? raw;
      if (subtopic === "output") {
        // Streaming-delta envelopes still flow through `output`. The thin
        // upsert-by-id reducer also accepts these via the legacy stream paths.
        handleSdkMessage(payload);
      } else if (subtopic === "status") {
        const newStatus = payload.status ?? "";
        sessionStatus.value = newStatus;
        // RC mode does not emit hook_started / stream_event envelopes that
        // normally drive agentBusy. Derive busy from session status so the
        // thinking-indicator surfaces during RC turns.
        if (newStatus === "running") {
          if (!agentBusy.value) busySinceMs.value = Date.now();
          agentBusy.value = true;
        } else if (newStatus === "idle" || newStatus === "completed" || newStatus === "failed") {
          agentBusy.value = false;
          busySinceMs.value = null;
        }
      } else if (subtopic === "cost") {
        cost.value = payload.cost_usd ?? payload.cost ?? 0;
      } else if (subtopic === "context") {
        contextUsage.value = payload;
      }
      // input/permission/question/*_response are now subsumed by the unified
      // `chat_messages` broadcast above — no inline subtopic constructor here.
    };

    wsManager.addEventListener("message", onMessage);

    return () => {
      wsManager.removeEventListener("message", onMessage);
      wsManager.unsubscribe(sessionId);
      messages.value = [];
      streamingContent.value = "";
      streamingMessageId.value = null;
      contextUsage.value = null;
      oldestLoadedId.value = null;
      hasOlderMessages.value = true;
      messageTotal.value = null;
    };
  }, [sessionId]);

  // Load older messages on scroll-to-top
  async function loadOlderMessages() {
    const capturedSessionId = sessionId;
    if (!capturedSessionId || oldestLoadedId.value == null) return;
    isLoadingOlder.value = true;

    try {
      const rows = await fetchMessages(capturedSessionId, {
        beforeId: oldestLoadedId.value,
        limit: 100,
      });

      // Stale session guard — user may have switched sessions during fetch
      if (currentSessionId.value !== capturedSessionId) return;

      if (rows.length === 0) {
        hasOlderMessages.value = false;
        return;
      }

      // Always update cursor from raw DB id
      const firstId = Number(rows[0].id);
      oldestLoadedId.value = Number.isFinite(firstId) ? firstId : null;
      hasOlderMessages.value = rows.length >= 100;

      // Capture scroll position before prepending
      const list = listRef.current;
      const prevScrollHeight = list?.scrollHeight ?? 0;
      const prevScrollTop = list?.scrollTop ?? 0;

      // Prepend older messages — API now returns NormalizedMessage[].
      messages.value = [...rows, ...messages.value];

      // Restore scroll position with double rAF to ensure Preact's DOM commit has flushed
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (list) {
            list.scrollTop = prevScrollTop + (list.scrollHeight - prevScrollHeight);
          }
        });
      });
    } catch (err) {
      console.error("[chat] Failed to load older messages:", err);
    } finally {
      isLoadingOlder.value = false;
    }
  }

  const handleListScroll = () => {
    const list = listRef.current;
    if (!list) return;
    if (list.scrollTop < 100 && hasOlderMessages.value && !isLoadingOlder.value) {
      loadOlderMessages();
    }
  };

  // Thin upsert-by-id reducer. The server normalizes envelopes into
  // NormalizedMessage[] and broadcasts under `{type:'chat_messages',messages}`.
  // Streaming deltas (text_delta / message_start / content_block_* /
  // message_stop) still flow as raw envelopes via the `output` subtopic and
  // are dispatched here too — they update streamingContent / streamingMessageId
  // and a couple of busy-state side-effects that don't belong on the row stream.
  function handleSdkMessage(payload: any) {
    if (payload?.type === "chat_messages") {
      const incoming = (payload.messages as Message[]) ?? [];
      if (incoming.length === 0) return;
      const byId = new Map<string, Message>();
      for (const m of messages.value) byId.set(m.id, m);
      for (const m of incoming) byId.set(m.id, m); // upsert
      // Any incoming assistant row finalizes the in-flight stream.
      if (incoming.some((m) => m.kind === "assistant")) {
        streamingContent.value = "";
        streamingMessageId.value = null;
      }
      messages.value = Array.from(byId.values()).sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      // Side-effect: refresh context after a compact boundary lands.
      if (incoming.some((m) => m.kind === "compact")) {
        fetchContextUsage(sessionId!)
          .then((ctx) => {
            contextUsage.value = ctx;
          })
          .catch(() => {});
      }
      return;
    }

    // Legacy streaming-delta envelope path. The server still emits
    // text_delta / content_block_* / message_start / message_stop as raw
    // SDK envelopes over the `output` subtopic. Keep the existing logic so
    // the streaming bubble continues to function — these don't go through
    // the normalizer.
    const data = payload;
    if (!data?.type) return;

    if (data.type === "system") {
      if (data.subtype === "hook_started") {
        if (!agentBusy.value) busySinceMs.value = Date.now();
        agentBusy.value = true;
      } else if (data.subtype === "hook_response") {
        // Hook finished. Clear busy iff no tool_use is currently outstanding —
        // currentAction is now derived from the row stream so we can't gate
        // on its identity. Conservative: only clear if no streaming content.
        if (!streamingMessageId.value) {
          agentBusy.value = false;
          busySinceMs.value = null;
        }
      }
      return;
    }

    if (data.type === "stream_event") {
      if (!agentBusy.value) busySinceMs.value = Date.now();
      agentBusy.value = true;
      const event = data.event;
      if (!event) return;
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta"
      ) {
        const chunk = event.delta.text ?? "";
        if (chunk) {
          streamingMessageId.value = data.uuid ?? "streaming";
          streamingContent.value += chunk;
        }
      }
      return;
    }

    if (data.type === "result") {
      agentBusy.value = false;
      busySinceMs.value = null;
      streamingContent.value = "";
      streamingMessageId.value = null;
      cost.value = data.total_cost_usd ?? cost.value;
      if (data.subtype === "success") {
        sessionStatus.value = "running";
      }
      return;
    }

    // assistant / user / etc. envelopes are now produced as chat_messages by
    // the server; ignore the raw envelope here.
  }

  // Close menus on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        showMenu.value = false;
      }
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        showModeMenu.value = false;
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  // Kill session
  const handleKill = () => {
    showMenu.value = false;
    const proj = projects.value.find((p) => p.path === session?.project_path);
    const slug = proj?.display_slug;
    killSession(sessionId).then(() => {
      currentSessionId.value = null;
      if (slug) nav.goProject(slug, true);
      else nav.goHome(true);
      // Delay fetch — kill is async (MQTT → SIGTERM → status update)
      setTimeout(() => {
        fetchSessions().then((s) => { sessions.value = s; }).catch(() => {});
      }, 1000);
    }).catch(() => {});
  };

  // Compact context
  const handleCompact = () => {
    sendMessage(sessionId, "/compact").catch(() => {});
    const msg: Message = {
      kind: "system",
      id: uuid(),
      text: "Compacting context...",
      timestamp: Date.now(),
    };
    messages.value = [...messages.value, msg];
  };

  // Clear — kill session, start fresh for same project
  const handleClear = () => {
    if (!session?.project_path) return;
    const proj = projects.value.find((p) => p.path === session.project_path);
    const slug = proj?.display_slug;
    restartSession(sessionId)
      .then(() => {
        // Restart is fire-and-forget via MQTT — go back to list and refresh
        currentSessionId.value = null;
        if (slug) nav.goProject(slug, true);
        else nav.goHome(true);
        fetchSessions().then((s) => { sessions.value = s; }).catch(() => {});
      })
      .catch(() => {});
  };

  // Restart the manager process. Active agents survive; the new manager
  // reattaches to them via the hello handshake. Set the banner ONLY after the
  // server returns 200 so a broker/network failure doesn't leave it stuck.
  const handleRestartManager = () => {
    showMenu.value = false;
    restartManager()
      .then(() => {
        managerRestarting.value = true;
        // Safety net: if no manager_online beacon arrives within 30s, clear
        // the banner anyway so the UI doesn't appear permanently broken.
        setTimeout(() => {
          if (managerRestarting.value) managerRestarting.value = false;
        }, 30_000);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        const sysMsg: Message = {
          kind: "system",
          id: uuid(),
          text: `Manager restart failed: ${msg}`,
          timestamp: Date.now(),
        };
        messages.value = [...messages.value, sysMsg];
      });
  };

  // Send message
  const handleSend = (text: string, images?: { type: string; data: string }[]) => {
    if (!text && !images?.length) return;

    // Intercept local slash commands so they share the menu's UX path
    if (text.trim() === "/compact") {
      handleCompact();
      return;
    }

    // No optimistic insert — the backend broadcasts the persisted user row
    // immediately from POST /sessions/:id/messages. An optimistic insert here
    // would have a uuid id that doesn't match the broadcast's DB id, so the
    // upsert reducer can't dedupe and the user sees two bubbles.

    agentBusy.value = true;
    busySinceMs.value = Date.now();
    // Backend may auto-resume a dead session in place (same id, new wrapper)
    // by spawning with --resume against the prior sdk_session_id. Refresh
    // sessions so the row's status flips back to live in the sidebar.
    sendMessage(sessionId, text, images)
      .then((res) => {
        if (res?.resumed) {
          fetchSessions().then((s) => { sessions.value = s; }).catch(() => {});
        }
      })
      .catch((err: Error) => {
        agentBusy.value = false;
        const stale = /^409:/.test(err?.message ?? "");
        const msg: Message = {
          kind: "system",
          id: uuid(),
          text: stale
            ? "Session is no longer attached to a running CC instance. Refresh and pick a live session."
            : `Failed to send: ${err?.message ?? "unknown error"}`,
          timestamp: Date.now(),
        };
        messages.value = [...messages.value, msg];
      });

    // Scroll after adding user message
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior });
    });
  };

  // Interrupt current turn
  const handleInterrupt = () => {
    interruptSession(sessionId).catch(() => {});
  };

  const setMode = (mode: string) => {
    permissionMode.value = mode;
    setPermissionMode(sessionId, mode).catch(() => {});
    showModeMenu.value = false;
  };

  const modeLabels: Record<string, string> = {
    default: "default",
    auto: "auto-approve",
    ask_always: "ask always",
  };

  // Render messages
  const renderMessage = (msg: Message) => {
    switch (msg.kind) {
      case "user":
        return <MessageBlock key={msg.id} kind="user" content={msg.text} />;
      case "assistant":
        return (
          <MessageBlock key={msg.id} kind="assistant" content={msg.text} />
        );
      case "tool_use":
        // tool_use rows are paired with their tool_result counterpart in the
        // ToolResultBlock render below; render nothing on their own.
        return null;
      case "tool_result": {
        // AskUserQuestion / ExitPlanMode have their own dedicated cards that
        // render question/plan + resolved-answer state; the generic tool_result
        // would just dump the raw input JSON beside them.
        if (msg.toolName === "AskUserQuestion" || msg.toolName === "ExitPlanMode") {
          return null;
        }
        const pairedUse = messages.value.find(
          (m) => m.kind === "tool_use" && m.toolUseId === msg.toolUseId,
        );
        const toolInput =
          pairedUse && pairedUse.kind === "tool_use" ? pairedUse.toolInput : null;
        return (
          <ToolResultBlock
            key={msg.id}
            toolName={msg.toolName}
            toolSummary={msg.toolSummary}
            toolInput={toolInput}
            output={msg.output}
            isError={msg.isError}
          />
        );
      }
      case "permission_request":
        return (
          <PermissionCard
            key={msg.id}
            tool={msg.tool}
            input={msg.input}
            alwaysAsk={msg.alwaysAsk}
            status={msg.status}
            sessionId={sessionId}
            toolUseId={msg.toolUseId}
          />
        );
      case "question":
        return (
          <QuestionCard
            key={msg.id}
            questions={msg.questions}
            status={msg.status}
            sessionId={sessionId}
            questionId={msg.questionId}
            toolUseId={msg.toolUseId}
            storedAnswers={msg.answers}
          />
        );
      case "plan_proposal":
        return (
          <PlanProposalCard key={msg.id} msg={msg} sessionId={sessionId} />
        );
      case "system":
        return (
          <div key={msg.id} class="message system">
            {msg.text}
          </div>
        );
      case "compact": {
        const saved = msg.preTokens - msg.postTokens;
        const pct = msg.preTokens > 0 ? Math.round((saved / msg.preTokens) * 100) : 0;
        const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
        return (
          <div key={msg.id} class="compact-banner">
            <div class="compact-banner-line" />
            <div class="compact-banner-body">
              <span class="compact-banner-icon">⟳</span>
              <span class="compact-banner-title">Context compacted</span>
              <span class="compact-banner-stats">
                {fmt(msg.preTokens)} → {fmt(msg.postTokens)} tokens
                {pct > 0 && <span class="compact-banner-savings"> (−{pct}%)</span>}
              </span>
              <span class="compact-banner-trigger">{msg.trigger}</span>
            </div>
            <div class="compact-banner-line" />
          </div>
        );
      }
      case "compact_summary":
        return (
          <details key={msg.id} class="compact-summary">
            <summary>
              <span class="compact-summary-icon">⟳</span>
              <span class="compact-summary-title">Compacted summary</span>
              <span class="compact-summary-hint">click to expand</span>
            </summary>
            <div class="compact-summary-body">{msg.text}</div>
          </details>
        );
      default:
        return null;
    }
  };

  return (
    <div class="main-panel">
      <div class="chat-view">
        {/* Header */}
        <div class="chat-header">
          <div class="ch-title-block">
            <button
              class="ch-title-link"
              onClick={() => {
                const slug = projects.value.find((p) => p.path === session?.project_path)?.display_slug;
                if (slug) nav.goProject(slug, true);
                else nav.goHome(true);
              }}
              title="Back to project"
            >
              <span class="chev">‹</span>
              <span class="ch-title">{projectName}</span>
            </button>
            {session && (
              <span class="ch-sub">
                <span>{session.model}</span>
                <span class="ch-sub-dot">·</span>
                <span>started {formatRelative(session.created_at)}</span>
              </span>
            )}
            {isStale && (
              <span
                class="ch-pill"
                style="background:#4a3a10;border:1px solid #b8860b;color:#ffd479;"
                title="This session is no longer attached. Refresh to pick a live session."
              >
                Stale · refresh
              </span>
            )}
            {_demo && <span class="ch-pill demo-pill">DEMO</span>}
          </div>
          {cost.value > 0 && (
            <span class="ch-pill cost" title="Session cost">
              ${cost.value < 0.01 ? cost.value.toFixed(3) : cost.value.toFixed(2)}
            </span>
          )}
          <button
            class={`ch-pill auto-toggle${permissionMode.value === "auto" ? " is-on" : ""}`}
            onClick={() => setMode(permissionMode.value === "auto" ? "default" : "auto")}
            title={
              permissionMode.value === "auto"
                ? "Auto-approve is ON — model classifier decides per call. Click to disable."
                : "Enable auto-approve for this session"
            }
          >
            <span class="auto-dot" />
            AUTO
          </button>
          <div class="ch-mode-container" ref={modeMenuRef}>
            <button
              class="ch-pill mode"
              onClick={() => { showModeMenu.value = !showModeMenu.value; }}
              title="Permission mode"
            >
              {modeLabels[permissionMode.value] ?? permissionMode.value}
              <span class="ch-pill-caret">▾</span>
            </button>
            {showModeMenu.value && (
              <div class="ch-mode-menu">
                <button
                  class={`ch-mode-item${permissionMode.value === "default" ? " selected" : ""}`}
                  onClick={() => setMode("default")}
                >
                  <span class="check">✓</span>
                  <div>
                    <div>Default</div>
                    <div class="ch-mode-hint">Ask before tools</div>
                  </div>
                </button>
                <button
                  class={`ch-mode-item${permissionMode.value === "auto" ? " selected" : ""}`}
                  onClick={() => setMode("auto")}
                >
                  <span class="check">✓</span>
                  <div>
                    <div>Auto-approve</div>
                    <div class="ch-mode-hint">All tools allowed</div>
                  </div>
                </button>
                <button
                  class={`ch-mode-item${permissionMode.value === "ask_always" ? " selected" : ""}`}
                  onClick={() => setMode("ask_always")}
                >
                  <span class="check">✓</span>
                  <div>
                    <div>Ask always</div>
                    <div class="ch-mode-hint">Confirm everything</div>
                  </div>
                </button>
              </div>
            )}
          </div>
          <span
            class={`status-dot ${wsState.value}`}
            title={`Connection: ${wsState.value}`}
          />
          <div class="header-menu-container" ref={menuRef}>
            <button class="ch-menu-btn" onClick={() => { showMenu.value = !showMenu.value; }} title="More">&#x22EF;</button>
            {showMenu.value && (
              <div class="header-menu">
                <div class="header-menu-label">Session</div>
                <button class="header-menu-item" onClick={() => { showMenu.value = false; handleCompact(); }}>Compact context</button>
                <button class="header-menu-item" onClick={() => { showMenu.value = false; handleClear(); }}>Restart session</button>
                <button class="header-menu-item danger" onClick={handleKill}>Kill session</button>
                <div class="header-menu-divider" />
                <div class="header-menu-label">Manager</div>
                <button class="header-menu-item" onClick={handleRestartManager}>Restart manager</button>
              </div>
            )}
          </div>
        </div>

        {/* Context usage panel */}
        <ContextPanel />

        <TranscriptDepthBar
          loaded={messages.value.length}
          total={
            messageTotal.value == null
              ? null
              : Math.max(messageTotal.value, messages.value.length)
          }
          fetchingOlder={isLoadingOlder.value}
        />

        {/* Message list */}
        <div class="message-list" ref={listRef} onScroll={handleListScroll}>
          {!hasOlderMessages.value && messages.value.length > 0 && (
            <div class="history-start">Beginning of conversation</div>
          )}
          {messages.value.length === 0 && !streamingContent.value && (
            <div class="empty-state empty-state-hint">
              <div class="empty-state-icon">›_</div>
              <div class="empty-state-title">Ready when you are</div>
              <div class="empty-state-sub">Type a message below to start the conversation.</div>
            </div>
          )}
          {messages.value.map(renderMessage)}
          {streamingMessageId.value && <StreamingBlock />}
          {agentBusy.value && !streamingMessageId.value && busySinceMs.value !== null && currentAction.value !== null && (
            <ThinkingIndicator
              sinceMs={busySinceMs.value}
              action={currentAction.value}
            />
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input area */}
        <RichInput
          onSend={(text, images) => handleSend(text, images)}
          onInterrupt={handleInterrupt}
          isStreaming={
            !!streamingMessageId.value ||
            (agentBusy.value && currentAction.value !== null)
          }
          disabled={wsState.value !== "connected"}
          permissionLabel={modeLabels[permissionMode.value] ?? permissionMode.value}
        />
      </div>
    </div>
  );
}
