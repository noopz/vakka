// Chat route — `/p/:slug/s/:sdkId`. Resolves slug to a project, sets
// currentSessionId before mounting ChatView, and falls back to home on
// unknown-slug 404s.
import { useEffect, useState, useRef } from "preact/hooks";
import { ChatView } from "../views/chat-view.js";
import {
  projects,
  projectsBySlug,
  currentSessionId,
  sessions,
  projectSessions,
  previewSession,
  previewLookupSettled,
  liveView,
} from "../signals/index.js";
import {
  fetchProjects,
  fetchProjectBySlug,
  fetchProjectSessions,
} from "../services/api.js";
import type { ProjectSession } from "../services/api.js";
import type { ProjectInfo } from "../signals/index.js";
import { useNav } from "./nav.js";

// A session's status can transition through many values; "live" means the
// agent is actively producing or awaiting input. Anything else (done, error,
// killed, idle, exited, etc.) is terminal from the user's POV — the chat is
// dead and we should bounce back to the project-home so the URL doesn't
// linger on a dead session id.
import { LIVE_STATUSES } from "../../shared/types.js";

export function ChatRoute({ slug, sdkId }: { slug: string; sdkId: string }) {
  const nav = useNav();
  const [resolved, setResolved] = useState<boolean>(
    () => !!projectsBySlug.value.get(slug),
  );
  const [notFound, setNotFound] = useState(false);

  // Set currentSessionId synchronously on the first render so ChatView mounts
  // with the right id. Re-run when sdkId changes (route swap between two
  // sessions of the same project shouldn't tear down ChatView, but should
  // update which session is shown).
  if (currentSessionId.value !== sdkId) {
    currentSessionId.value = sdkId;
  }

  useEffect(() => {
    if (projectsBySlug.value.get(slug)) {
      setResolved(true);
      return;
    }
    let cancelled = false;
    fetchProjects()
      .then((p) => {
        if (cancelled) return;
        projects.value = p;
        if (projectsBySlug.value.get(slug)) {
          setResolved(true);
          return;
        }
        return fetchProjectBySlug(slug)
          .then((proj) => {
            if (cancelled) return;
            if (proj) {
              if (!projectsBySlug.value.get(slug)) {
                projects.value = [...projects.value, proj as ProjectInfo];
              }
              setResolved(true);
            } else {
              setNotFound(true);
            }
          })
          .catch(() => {
            if (!cancelled) setNotFound(true);
          });
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (notFound) nav.goHome(true);
  }, [notFound]);

  // Cold-load reconciliation: when the user lands on /p/<slug>/s/<sdk> via
  // refresh or external link, neither `previewSession` (set by project-home
  // click) nor `sessions` (Vakka DB) may know about this id yet. If `sdkId`
  // doesn't match a *live* Vakka session row, this is a historical idle
  // session — fetch the project's session listing and synthesize a preview
  // so chat-view renders the jsonl read-only instead of an empty state.
  useEffect(() => {
    if (previewLookupSettled.value !== sdkId) {
      previewLookupSettled.value = null;
    }
    const proj = projectsBySlug.value.get(slug);
    if (!proj) return;
    // Already have a preview pinned to this sdkId? leave it alone.
    if (previewSession.value?.candidate.sdk_session_id === sdkId) {
      previewLookupSettled.value = sdkId;
      return;
    }
    // URL changed to a different session — drop any stale preview from a
    // previous tile click. Without this, ChatView's `if (preview)` short-
    // circuit keeps rendering the old jsonl on top of the new id.
    if (previewSession.value && previewSession.value.candidate.sdk_session_id !== sdkId) {
      previewSession.value = null;
    }
    // Live Vakka session? main chat view handles it; nothing to do here.
    const liveStatuses = LIVE_STATUSES;
    const vakkaRow = sessions.value.find((s) => s.id === sdkId);
    if (vakkaRow && liveStatuses.has(vakkaRow.status)) {
      previewLookupSettled.value = sdkId;
      return;
    }

    // URL `sdkId` may be either a Vakka DB id (vakka-origin tile click) or an
    // SDK uuid (cold load / external). Match candidates by either key so a
    // terminal Vakka session navigated by its DB id still resolves to the
    // jsonl candidate (which is keyed by SDK uuid).
    const matches = (r: { sdk_session_id: string; vakka_session_id: string | null }) =>
      r.sdk_session_id === sdkId || r.vakka_session_id === sdkId;

    let cancelled = false;
    const ensurePreview = async () => {
      // Try the project-keyed bucket first, then any other already-loaded
      // bucket (the sidebar populates per-cwd entries for subdirectory CLI
      // processes — e.g. ~/projects/repo/sub under repo).
      let rows: ProjectSession[] | undefined = projectSessions.value.get(proj.path);
      let candidate = rows?.find(matches);
      let bucketKey: string = proj.path;
      if (!candidate) {
        for (const [key, list] of projectSessions.value.entries()) {
          if (key === proj.path) continue;
          const hit = list.find(matches);
          if (hit) {
            rows = list;
            candidate = hit;
            bucketKey = key;
            break;
          }
        }
      }
      // Still nothing — fetch the project-path listing, then any cwd of a
      // live cc-cli process under this project.
      if (!candidate) {
        const cwds: string[] = [proj.path];
        for (const r of liveView.value) {
          if (r.transport !== "cli") continue;
          if (r.cwd === proj.path || r.cwd.startsWith(proj.path + "/")) {
            if (!cwds.includes(r.cwd)) cwds.push(r.cwd);
          }
        }
        for (const cwd of cwds) {
          try {
            const fetched = await fetchProjectSessions(cwd);
            if (cancelled) return;
            const next = new Map(projectSessions.value);
            next.set(cwd, fetched);
            projectSessions.value = next;
            const hit = fetched.find(matches);
            if (hit) {
              rows = fetched;
              candidate = hit;
              bucketKey = cwd;
              break;
            }
          } catch {
            /* try next */
          }
        }
      }
      if (cancelled) return;
      if (!candidate) {
        previewLookupSettled.value = sdkId;
        return;
      }
      // CLI-live falls through here (no Vakka row, no WS feed) and renders
      // via PreviewView, which has live-tail polling + fork-on-first-message.
      // Vakka-live was already short-circuited above on the `liveRow` check.
      // Use the bucket key (the actual cwd whose Claude transcripts dir holds
      // this jsonl) — not proj.path — so fetchTranscript hits the right
      // ~/.claude/projects/<projectKey> directory.
      previewSession.value = { candidate, project_path: bucketKey };
      previewLookupSettled.value = sdkId;
    };
    ensurePreview();
    return () => {
      cancelled = true;
    };
  }, [slug, sdkId, resolved]);

  // Watch the live session list. When the session matching `sdkId` transitions
  // out of a live status (organic finish OR manual kill), bounce to project-
  // home so the URL doesn't sit on a dead chat. We only mark a transition once
  // the session has been observed live at least once — otherwise an initial
  // load that arrives with an already-terminal status (e.g. user navigated to
  // a stale URL) would also fire, which is desirable in its own right but we
  // funnel it through the same path. `wasLive` tracks whether we've ever seen
  // it live, so a never-live session still triggers redirect on first observe.
  const wasLive = useRef<boolean>(false);
  useEffect(() => {
    wasLive.current = false; // reset on route swap
    const unsub = sessions.subscribe((list) => {
      const s = list.find((x) => x.id === sdkId);
      if (!s) return; // not yet hydrated; do nothing
      if (LIVE_STATUSES.has(s.status)) {
        wasLive.current = true;
        // Race guard: if we already pinned a preview for this sdkId (because
        // projectSessions resolved before sessions.value did), drop it so
        // ChatView's WS path takes over for the Vakka-owned session.
        if (previewSession.value?.candidate.sdk_session_id === sdkId) {
          previewSession.value = null;
        }
        return;
      }
      // Only redirect on observed live→terminal transition (i.e. kill or
      // organic finish). A session that was already idle when we landed is
      // a historical preview — chat-view renders the jsonl read-only and
      // we should stay put.
      if (!wasLive.current) return;
      const proj = projectsBySlug.value.get(slug);
      if (proj) nav.goProject(slug, true);
      else nav.goHome(true);
    });
    return () => unsub();
  }, [sdkId, slug]);

  if (!resolved) return null;
  return <ChatView />;
}
