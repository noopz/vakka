// Home route — `/`. Real dashboard view ported from `mocks/route-home.html`.
// Renders three sections: serif greeting hero, "Live now" grid of active
// sessions across all projects, and an "All projects" rollup list.
import { useEffect, useState } from "preact/hooks";
import {
  currentSessionId,
  liveView,
  projects,
  projectsBySlug,
  sessions,
  type LiveSessionView,
  type ProjectInfo,
} from "../signals/index.js";
import { useNav } from "./nav.js";
import { formatRelative } from "../utils/time.js";
import { Clickable } from "../components/clickable.js";
import { isDemoMode, redactSlug, redactPath } from "../utils/demo-mode.js";
import { addProject, fetchProjects } from "../services/api.js";

function greetingWord(hour: number): string {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

function shortPath(path: string): string {
  const home = "/Users/";
  if (path.startsWith(home)) {
    const rest = path.slice(home.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) return "~" + rest.slice(slash);
  }
  return path;
}

function AdoptProjectModal({
  row,
  onClose,
}: {
  row: LiveSessionView;
  onClose: () => void;
}) {
  const nav = useNav();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adoptPath = row.project_path ?? row.cwd;
  const onAdd = async () => {
    if (!adoptPath) return;
    setBusy(true);
    setError(null);
    try {
      await addProject(adoptPath, row.cwd_basename);
      const fresh = await fetchProjects();
      projects.value = fresh as ProjectInfo[];
      const slug = fresh.find((p: ProjectInfo) => p.path === adoptPath)?.display_slug;
      onClose();
      if (slug && row.sdk_session_id) {
        nav.goSession(slug, row.sdk_session_id);
      } else if (slug) {
        nav.goProject(slug);
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to add project");
      setBusy(false);
    }
  };

  const onViewOnce = () => {
    onClose();
    if (row.sdk_session_id) nav.goCli(row.sdk_session_id);
  };

  return (
    <div
      class="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="modal">
        <h2>Add this project?</h2>
        <p style="color: var(--text-secondary); font-size: 14px; line-height: 1.5;">
          A Claude session is running in a folder Vakka isn't tracking.
        </p>
        <div style="display: flex; flex-direction: column; gap: 4px; padding: 12px; background: var(--bg); border-radius: var(--radius-button); font-size: 13px;">
          <div><strong>{row.cwd_basename}</strong></div>
          <div style="color: var(--text-secondary); font-family: var(--font-mono, monospace); font-size: 12px;">
            {shortPath(row.cwd)}
          </div>
        </div>
        <p style="color: var(--text-secondary); font-size: 13px; line-height: 1.5;">
          Add it to your project list, or just view this session's history without registering anything.
        </p>
        {error ? <p style="color: var(--danger, #ef4444); font-size: 13px;">{error}</p> : null}
        <div class="modal-actions">
          <button class="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button class="btn btn-ghost" onClick={onViewOnce} disabled={busy}>View once</button>
          <button class="btn btn-primary" onClick={onAdd} disabled={busy}>{busy ? "Adding…" : "Add project"}</button>
        </div>
      </div>
    </div>
  );
}

function LiveCard({ row }: { row: LiveSessionView }) {
  const nav = useNav();
  const [showAdopt, setShowAdopt] = useState(false);
  const onClick = () => {
    if (row.transport === "wrapper" && row.slug && row.vakka_session_id) {
      nav.goSession(row.slug, row.vakka_session_id);
      return;
    }
    if (row.slug && row.sdk_session_id) {
      nav.goSession(row.slug, row.sdk_session_id);
      return;
    }
    if (row.slug) {
      nav.goProject(row.slug);
      return;
    }
    // No slug: project isn't in the DB. Prompt to adopt (using project_path
    // when known, else the live process's cwd) or view ephemerally.
    if (row.project_path || row.cwd) {
      setShowAdopt(true);
      return;
    }
    if (row.sdk_session_id) {
      nav.goCli(row.sdk_session_id);
    }
  };

  const badgeKind = row.transport === "wrapper" ? "vk" : "cli";

  return (
    <>
      <Clickable class="live-card" onClick={onClick}>
        <div class="row1">
          <span class="proj">{isDemoMode() ? redactSlug(row.cwd_basename) : row.cwd_basename}</span>
          <span class={`badge ${badgeKind}`}>{badgeKind}</span>
          <span class="badge live">
            <span class="dot" />
            live
          </span>
        </div>
        <div class="verb">
          <span class="blink">●</span> {row.status_verb}
        </div>
        <div class="path">{isDemoMode() ? redactPath(row.cwd) : shortPath(row.cwd)}</div>
        <div class="meta">
          {row.cost_usd > 0 && <span>${row.cost_usd.toFixed(2)}</span>}
          <span>{formatRelative(row.last_activity)}</span>
        </div>
      </Clickable>
      {showAdopt ? (
        <AdoptProjectModal row={row} onClose={() => setShowAdopt(false)} />
      ) : null}
    </>
  );
}

function RcAttachedCard({ row }: { row: LiveSessionView }) {
  const nav = useNav();
  const cseId = row.cse_id ?? "";
  const onClick = () => {
    if (cseId) nav.goRc(cseId);
  };
  const short = cseId.replace(/^cse_/, "").slice(0, 12);
  return (
    <Clickable class="live-card" onClick={onClick}>
      <div class="row1">
        <span class="proj">{isDemoMode() ? redactSlug(row.cwd_basename) : row.cwd_basename}</span>
        <span class="badge cli">rc</span>
        <span class="badge live">
          <span class="dot" />
          attached
        </span>
      </div>
      <div class="verb">
        <span class="blink">●</span> {row.status_verb}
      </div>
      <div class="path">{isDemoMode() ? redactPath(row.cwd) : shortPath(row.cwd)}</div>
      <div class="path">cse {short} · pid {row.pid ?? "?"}</div>
      <div class="meta">
        {row.cost_usd > 0 && <span>${row.cost_usd.toFixed(4)}</span>}
        <span>{formatRelative(row.last_activity)}</span>
      </div>
    </Clickable>
  );
}

function ProjectRow({
  project,
  liveByPath,
}: {
  project: ProjectInfo;
  liveByPath: Map<string, number>;
}) {
  const nav = useNav();
  const totalCount = sessions.value.filter(
    (s) => s.project_path === project.path
  ).length;
  const liveCount = liveByPath.get(project.path) ?? 0;
  const lastTimes = sessions.value
    .filter((s) => s.project_path === project.path)
    .map((s) => new Date(s.last_activity).getTime())
    .filter((t) => Number.isFinite(t));
  const lastIso =
    lastTimes.length > 0
      ? new Date(Math.max(...lastTimes)).toISOString()
      : project.last_file_activity;

  const onClick = () => {
    if (project.display_slug) nav.goProject(project.display_slug);
  };

  return (
    <Clickable class="proj-row" onClick={onClick}>
      <div class="name-block">
        <div class="name">
          {isDemoMode() ? redactSlug(project.name) : project.name}
          {liveCount > 0 ? (
            <span class="badge live">
              <span class="dot" />
              {liveCount} live{totalCount > liveCount ? ` · ${totalCount} total` : ""}
            </span>
          ) : null}
        </div>
        <div class="slug">
          /p/<span class="accent">{isDemoMode() ? (redactSlug(project.display_slug || "") || "—") : (project.display_slug || "—")}</span> ·{" "}
          {isDemoMode() ? redactPath(project.path) : shortPath(project.path)}
        </div>
      </div>
      <div class="stats">
        <span>
          <strong>{totalCount}</strong> session{totalCount === 1 ? "" : "s"}
        </span>
        <span>
          last <strong>{formatRelative(lastIso)}</strong>
        </span>
      </div>
      <div class="arrow">›</div>
    </Clickable>
  );
}

export function HomeRoute() {
  useEffect(() => {
    currentSessionId.value = null;
  }, []);

  // Read the slug map so the component re-renders when projects load.
  void projectsBySlug.value;

  const liveCards: LiveSessionView[] = [];
  const rcCards: LiveSessionView[] = [];
  for (const r of liveView.value) {
    if (r.transport === "rc") rcCards.push(r);
    else liveCards.push(r);
  }

  const liveByPath = new Map<string, number>();
  for (const r of liveCards) {
    if (!r.project_path) continue;
    liveByPath.set(r.project_path, (liveByPath.get(r.project_path) ?? 0) + 1);
  }
  const sortedProjects = [...projects.value].sort((a, b) => {
    const at = a.last_file_activity ? new Date(a.last_file_activity).getTime() : 0;
    const bt = b.last_file_activity ? new Date(b.last_file_activity).getTime() : 0;
    return bt - at;
  });

  const word = greetingWord(new Date().getHours());

  return (
    <main class="main dashboard-main">
      <div class="crumbs">
        <span>HOME</span>
      </div>

      <h1 class="hero">
        good <span class="accent">{word}</span>.
      </h1>

      {liveCards.length > 0 ? (
        <>
          <div class="sec-head">
            <h2>LIVE NOW</h2>
            <span class="count">{liveCards.length}</span>
          </div>
          <div class="live-grid">
            {liveCards.map((r) => (
              <LiveCard
                key={`${r.transport}:${r.vakka_session_id ?? r.sdk_session_id ?? r.pid ?? r.cwd}`}
                row={r}
              />
            ))}
          </div>
        </>
      ) : null}

      {rcCards.length > 0 ? (
        <>
          <div class="sec-head">
            <h2>REMOTE CTRL</h2>
            <span class="count">{rcCards.length}</span>
          </div>
          <div class="live-grid">
            {rcCards.map((r) => (
              <RcAttachedCard
                key={`rc:${r.pid ?? r.cse_id ?? r.cwd}`}
                row={r}
              />
            ))}
          </div>
        </>
      ) : null}

      <div class="sec-head">
        <h2>ALL PROJECTS</h2>
      </div>
      {sortedProjects.length > 0 ? (
        <div class="proj-list">
          {sortedProjects.map((p) => (
            <ProjectRow key={p.path} project={p} liveByPath={liveByPath} />
          ))}
        </div>
      ) : (
        <div class="proj-empty">
          No projects yet. Start a session from the sidebar to get going.
        </div>
      )}
    </main>
  );
}
