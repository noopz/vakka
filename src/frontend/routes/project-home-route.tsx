// Project-home route — `/p/:slug`. Shows the project's live sessions in a
// grid and idle/previous sessions in a list. Header has the project name in
// serif italic, slug pill, full path, summary stats, and action buttons for
// "+ new session" / "attach external CLI".
//
// Data flow:
//   1. Resolve project from `projectsBySlug`. If absent, fetch /projects;
//      if still absent, fall back to /projects/by-slug/:slug. On 404, redirect
//      to home.
//   2. Once we have a project.path, fetch its session listing into the
//      `projectSessions` Map signal.
//
// Visual source of truth: mocks/route-project-home.html.
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  projects,
  projectsBySlug,
  projectSessions,
  previewSession,
  currentSessionId,
  sessions,
  liveView,
} from "../signals/index.js";
import {
  fetchProjects,
  fetchProjectBySlug,
  fetchProjectSessions,
  createSession,
  fetchSessions,
} from "../services/api.js";
import type { ProjectInfo } from "../signals/index.js";
import type { ProjectSession } from "../services/api.js";
import { useNav } from "./nav.js";
import { Clickable } from "../components/clickable.js";
import { formatRelative } from "../utils/time.js";
import { isDemoMode, redactSlug, redactPath, redactId } from "../utils/demo-mode.js";

function shortUuid(id: string): string {
  if (!id) return "";
  return id.length <= 8 ? id : `${id.slice(0, 6)}…`;
}

function homeTilde(path: string): { home: string; rest: string } {
  // ~/foo/bar style display. We don't have access to $HOME on the client,
  // so use a heuristic: /Users/<who>/ → ~/.
  const match = path.match(/^(\/Users\/[^/]+\/|\/home\/[^/]+\/)(.*)$/);
  if (match) return { home: "~/", rest: match[2] };
  return { home: "", rest: path };
}

function originBadge(s: ProjectSession) {
  if (s.origin === "external") return <span class="ph-badge cli">cli</span>;
  return <span class="ph-badge vk">vk</span>;
}

export function ProjectHomeRoute({ slug }: { slug: string }) {
  const nav = useNav();
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [spawning, setSpawning] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // Clear any active session so the sidebar's selection state doesn't bleed
  // through while we're on project-home.
  useEffect(() => {
    currentSessionId.value = null;
  }, [slug]);

  const project: ProjectInfo | undefined = projectsBySlug.value.get(slug);

  useEffect(() => {
    if (project) return;
    let cancelled = false;
    setLoading(true);
    fetchProjects()
      .then((p) => {
        if (cancelled) return;
        projects.value = p;
        if (!projectsBySlug.value.get(slug)) {
          return fetchProjectBySlug(slug)
            .then((proj) => {
              if (cancelled) return;
              if (!projectsBySlug.value.get(slug) && proj) {
                projects.value = [...projects.value, proj as ProjectInfo];
              }
            })
            .catch(() => {
              if (!cancelled) setNotFound(true);
            });
        }
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (notFound) nav.goHome(true);
  }, [notFound]);

  // Once we have the project, load its session listing.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    setSessionsLoading(true);
    fetchProjectSessions(project.path)
      .then((rows) => {
        if (cancelled) return;
        const next = new Map(projectSessions.value);
        next.set(project.path, rows);
        projectSessions.value = next;
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.path]);

  const allSessions: ProjectSession[] = project
    ? projectSessions.value.get(project.path) ?? []
    : [];

  // Project-scoped slice of the unified live-view feed. Server-side join
  // already populated origin/transport/slug/sdk_id; we just partition.
  const projectLive = useMemo(
    () => (project
      ? liveView.value.filter((r) => r.project_path === project.path)
      : []),
    [liveView.value, project?.path],
  );
  const liveSessions = useMemo(
    () => projectLive.filter((r) => r.transport === "wrapper" || r.transport === "cli"),
    [projectLive],
  );
  const rcForProject = useMemo(
    () => projectLive.filter((r) => r.transport === "rc"),
    [projectLive],
  );

  // Idle = anything in the project's session listing not currently live.
  // Liveness comes from the live-view PIDs and vakka-session-ids; the jsonl
  // `live` flag (which RC also flips) is intentionally not consulted.
  const idleSessions = useMemo(() => {
    const livePids = new Set(
      liveSessions
        .map((r) => r.pid)
        .filter((p): p is number => p !== null),
    );
    const liveVakkaIds = new Set(
      liveSessions
        .map((r) => r.vakka_session_id)
        .filter((v): v is string => v !== null),
    );
    const liveSdkIds = new Set(
      liveSessions
        .map((r) => r.sdk_session_id)
        .filter((v): v is string => v !== null),
    );
    return allSessions.filter((s) => {
      if (s.vakka_session_id && liveVakkaIds.has(s.vakka_session_id)) return false;
      if (liveSdkIds.has(s.sdk_session_id)) return false;
      if (s.live_holder?.pid != null && livePids.has(s.live_holder.pid)) return false;
      return true;
    });
  }, [allSessions, liveSessions]);

  const lastActivity = useMemo(() => {
    if (allSessions.length === 0) return null;
    return allSessions.reduce<string | null>((acc, s) => {
      if (!s.mtime) return acc;
      if (!acc) return s.mtime;
      return new Date(s.mtime) > new Date(acc) ? s.mtime : acc;
    }, null);
  }, [allSessions]);

  const handleNewSession = async () => {
    if (!project || spawning) return;
    setSpawning(true);
    try {
      const res = await createSession(project.path, undefined, undefined, undefined, "rc-spawned");
      const newId = res?.sessionId ?? res?.id;
      // Refresh sessions in the background so the sidebar reflects the new row.
      fetchSessions()
        .then((s) => {
          sessions.value = s;
        })
        .catch(() => {});
      // Always navigate into the chat. A freshly-spawned session may not have
      // an sdk_session_id yet — the SDK assigns one after init and the WS
      // pushes it back. Routing on the Vakka session id keeps the URL stable
      // and mounts ChatView immediately; chat-view reconciles when the SDK id
      // arrives. Mirrors session-list.tsx's onSelect-after-create flow.
      const navId = res?.sdk_session_id ?? newId;
      if (navId) {
        nav.goSession(slug, navId);
      }
    } catch (_) {
      // Silently swallow — the user will see no nav. Surface this via toast
      // in a follow-up.
    } finally {
      setSpawning(false);
    }
  };

  const handleAttachExternalCli = () => {
    // Stub for v1 — wiring up external CLI attach is a separate workstream.
    // For now we just log; the button is visible to set the affordance.
    // eslint-disable-next-line no-console
    console.log("[project-home] attach external CLI: not yet implemented");
  };

  const handleOpenSession = (s: ProjectSession) => {
    if (!project) return;
    // PREVIOUS-SESSIONS list is idle by construction — always preview.
    previewSession.value = { candidate: s, project_path: project.path };
    // For Vakka-owned sessions chat-route resolves by DB id (s.id), not by
    // sdk_session_id — use vakka_session_id when present so the URL hits the
    // live ChatView path instead of falling through to PreviewView.
    const navId =
      s.origin === "vakka" && s.vakka_session_id
        ? s.vakka_session_id
        : s.sdk_session_id;
    nav.goSession(slug, navId);
  };

  if (!project) {
    if (loading) {
      return (
        <div class="project-home">
          <div class="ph-empty-hint">Loading project…</div>
        </div>
      );
    }
    return null;
  }

  const _demo = isDemoMode();
  const { home, rest } = _demo
    ? homeTilde(redactPath(project.path))
    : homeTilde(project.path);

  return (
    <div class="project-home">
      <div class="ph-crumbs">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            nav.goHome();
          }}
        >
          HOME
        </a>
        <span class="sep">/</span>
        <span class="here">{(_demo ? redactSlug(project.display_slug) : project.display_slug).toUpperCase()}</span>
      </div>

      <header class="ph-header">
        <div class="ph-title">
          <h1>{_demo ? redactSlug(project.name) : project.name}</h1>
          <span class="ph-slug-pill">{_demo ? redactSlug(project.display_slug) : project.display_slug}</span>
        </div>
        <div class="ph-path">
          {home && <span class="home">{home}</span>}
          {rest}
        </div>
        <div class="ph-summary">
          <span class="stat">
            <strong>{allSessions.length}</strong>{" "}
            {allSessions.length === 1 ? "session" : "sessions"}
          </span>
          <span class="stat">
            <strong>{liveSessions.length}</strong> live
          </span>
          {project.external_live && liveSessions.length === 0 && (
            <span class="stat ph-live-hint">
              <span class="ph-live-dot" /> CC CLI running
            </span>
          )}
          <span class="stat">
            last activity <strong>{formatRelative(lastActivity)}</strong>
          </span>
        </div>
        <div class="ph-actions">
          <button
            class="ph-btn primary"
            onClick={handleNewSession}
            disabled={spawning}
          >
            + new session
          </button>
          <button class="ph-btn ghost" onClick={handleAttachExternalCli}>
            attach external CLI
          </button>
        </div>
        <div class="ph-actions-hint">
          Spawn a fresh Vakka-managed run, or attach to an external Claude Code
          CLI already in this project.
        </div>
      </header>

      {liveSessions.length > 0 && (
        <>
          <div class="ph-sec-head">
            <h2>LIVE IN THIS PROJECT</h2>
            <span class="ph-count live">{liveSessions.length}</span>
          </div>
          <div class="ph-live-grid">
            {liveSessions.map((r) => {
              const navId =
                r.transport === "wrapper" ? r.vakka_session_id : r.sdk_session_id;
              const handleClick = () => {
                if (r.transport === "wrapper" && r.slug && navId) {
                  nav.goSession(r.slug, navId);
                  return;
                }
                if (r.slug && navId) nav.goSession(r.slug, navId);
                else if (r.slug) nav.goProject(r.slug);
              };
              const idLabel = navId
                ? (_demo ? redactId(navId) : shortUuid(navId))
                : `pid ${r.pid ?? "?"}`;
              const badge = r.transport === "wrapper" ? "vk" : "cli";
              return (
                <Clickable
                  key={`${r.transport}:${r.pid ?? r.vakka_session_id ?? r.sdk_session_id ?? r.cwd}`}
                  class="ph-live-card"
                  onClick={handleClick}
                  disabled={!r.slug && !navId}
                >
                  <div class="row1">
                    <span class={`ph-badge ${badge}`}>{badge}</span>
                    <span class="ph-badge live">
                      <span class="dot" />
                      live
                    </span>
                    <span class="uuid">{idLabel}</span>
                  </div>
                  <div class="verb">
                    <span class="blink">●</span> {r.status_verb}
                  </div>
                  <div class="meta">
                    {r.cost_usd > 0 && <span>${r.cost_usd.toFixed(2)}</span>}
                    <span>{formatRelative(r.last_activity)}</span>
                    {r.pid != null && <span>pid {r.pid}</span>}
                  </div>
                </Clickable>
              );
            })}
          </div>
        </>
      )}

      {rcForProject.length > 0 && (
        <>
          <div class="ph-sec-head">
            <h2>REMOTE CTRL</h2>
            <span class="ph-count live">{rcForProject.length}</span>
          </div>
          <div class="ph-live-grid">
            {rcForProject.map((r) => {
              const cseId = r.cse_id ?? "";
              const short = cseId.replace(/^cse_/, "").slice(0, 12);
              return (
                <Clickable
                  key={`rc:${r.pid ?? cseId}`}
                  class="ph-live-card"
                  onClick={() => {
                    if (cseId) nav.goRc(cseId);
                  }}
                  disabled={!cseId}
                >
                  <div class="row1">
                    <span class="ph-badge cli">rc</span>
                    <span class="ph-badge live">
                      <span class="dot" />
                      attached
                    </span>
                    <span class="uuid">cse {short || "?"}</span>
                  </div>
                  <div class="verb">
                    <span class="blink">●</span> {r.status_verb}
                  </div>
                  <div class="meta">
                    {r.cost_usd > 0 && <span>${r.cost_usd.toFixed(4)}</span>}
                    <span>{formatRelative(r.last_activity)}</span>
                    {r.pid != null && <span>pid {r.pid}</span>}
                  </div>
                </Clickable>
              );
            })}
          </div>
        </>
      )}

      <div class="ph-sec-head">
        <h2>PREVIOUS SESSIONS</h2>
        <span class="ph-count">{idleSessions.length}</span>
      </div>

      {idleSessions.length === 0 ? (
        <div class="ph-empty-hint">
          {sessionsLoading
            ? "Loading sessions…"
            : "No sessions yet — start one above."}
        </div>
      ) : (
        <div class="ph-session-list">
          {idleSessions.map((s) => {
            const preview = s.last_user_text || s.last_assistant_text || "";
            return (
              <Clickable
                key={s.sdk_session_id}
                class="ph-sess-row"
                onClick={() => handleOpenSession(s)}
              >
                <div class="left">
                  <div class="head-row">
                    {originBadge(s)}
                    <span class="ph-badge idle">idle</span>
                    <span class="uuid">{_demo ? redactId(s.sdk_session_id) : shortUuid(s.sdk_session_id)}</span>
                  </div>
                  {preview && <div class="last-msg">{preview}</div>}
                </div>
                <div class="meta">
                  {s.message_count != null && (
                    <span>
                      <strong>{s.message_count}</strong> msgs
                    </span>
                  )}
                  {s.cost_usd != null && s.cost_usd > 0 && (
                    <span>${s.cost_usd.toFixed(2)}</span>
                  )}
                  {s.model && <span>{s.model}</span>}
                  <span>{formatRelative(s.mtime)}</span>
                </div>
                <div class="arrow">›</div>
              </Clickable>
            );
          })}
        </div>
      )}
    </div>
  );
}
