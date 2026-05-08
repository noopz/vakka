
import { useState, useEffect, useRef, useCallback, useMemo } from "preact/hooks";
import {
  sessions,
  projects,
  currentSessionId,
  pendingActions,
  projectSessions,
  previewSession,
  liveView,
} from "../signals/index.js";
import type { ProjectInfo, } from "../signals/index.js";
import {
  fetchSessions,
  fetchProjects,
  createSession,
  killSession,
  fetchPendingDevices,
  browseDirectory,
  fetchProjectSessions,
  setPinned,
} from "../services/api.js";
import type { ProjectSession } from "../services/api.js";
import { wsManager } from "../services/websocket-manager.js";
import { Clickable } from "../components/clickable.js";
import { isDemoMode, redactSlug, redactId } from "../utils/demo-mode.js";
import { DevicePanel } from "../components/device-panel.js";
import { DebugPanel } from "../components/debug-panel.js";
import { logout } from "../services/auth.js";
import { useNav } from "../routes/nav.js";
import { formatRelative, formatAgo } from "../utils/time.js";

const HOUR = 3600_000;
const DAY = 86400_000;
const COLLAPSE_KEY = "vk.sidebarProjectsCollapsed";

interface ContextMenuState {
  x: number;
  y: number;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// ProjectPickerModal — kept inline, behavior unchanged from prior sidebar.
// ---------------------------------------------------------------------------
function ProjectPickerModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (session: any) => void;
}) {
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"projects" | "browse">("projects");

  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [browseDisplay, setBrowseDisplay] = useState("");
  const [browseDirs, setBrowseDirs] = useState<string[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [manualPath, setManualPath] = useState("");

  const sortedProjects = [...projects.value].sort((a, b) => {
    const aTime = a.last_file_activity ? new Date(a.last_file_activity).getTime() : 0;
    const bTime = b.last_file_activity ? new Date(b.last_file_activity).getTime() : 0;
    return bTime - aTime;
  });

  const handlePickProject = async (path: string) => {
    if (creating) return;
    setCreating(path);
    setError("");
    try {
      const session = await createSession(path, "opus");
      onCreated(session);
    } catch (err: any) {
      setError(err.message || "Failed to create session");
      setCreating(null);
    }
  };

  const loadDir = async (path?: string) => {
    setBrowseLoading(true);
    setError("");
    try {
      const result = await browseDirectory(path);
      setBrowsePath(result.path);
      setBrowseDisplay(result.display);
      setBrowseDirs(result.dirs);
    } catch (err: any) {
      setError(err.message || "Cannot read directory");
    }
    setBrowseLoading(false);
  };

  const handleTabSwitch = (t: "projects" | "browse") => {
    setTab(t);
    if (t === "browse" && !browsePath) loadDir();
  };

  const navigateUp = () => {
    if (!browsePath) return;
    const parent = browsePath.replace(/\/[^/]+$/, "") || "/";
    loadDir(parent);
  };

  const navigateInto = (dir: string) => {
    loadDir(browsePath + "/" + dir);
  };

  const selectCurrent = () => {
    if (browsePath) handlePickProject(browsePath);
  };

  const handleManualSubmit = (e: Event) => {
    e.preventDefault();
    const trimmed = manualPath.trim();
    if (!trimmed) return;
    handlePickProject(trimmed);
  };

  return (
    <Clickable
      class="modal-overlay"
      tabIndex={-1}
      onClick={(e: Event) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="modal">
        <h2>New Session</h2>

        <div class="picker-tabs">
          <button
            class={`picker-tab${tab === "projects" ? " active" : ""}`}
            onClick={() => handleTabSwitch("projects")}
          >
            Recent
          </button>
          <button
            class={`picker-tab${tab === "browse" ? " active" : ""}`}
            onClick={() => handleTabSwitch("browse")}
          >
            Browse
          </button>
        </div>

        {tab === "projects" && (
          <>
            {sortedProjects.length > 0 ? (
              <div class="project-picker-list">
                {sortedProjects.map((p) => (
                  <Clickable
                    key={p.path}
                    class={`project-picker-item${creating === p.path ? " creating" : ""}`}
                    onClick={() => handlePickProject(p.path)}
                  >
                    <div class="project-picker-name">{p.name}</div>
                    <div class="project-picker-meta">
                      <span class="project-picker-path">{p.path.replace(/^\/Users\/[^/]+/, "~")}</span>
                      {" · "}
                      {p.last_file_activity ? formatRelative(p.last_file_activity) : "No activity"}
                    </div>
                  </Clickable>
                ))}
              </div>
            ) : (
              <div class="picker-empty">No projects yet. Browse to add one.</div>
            )}
            <form onSubmit={handleManualSubmit} class="picker-manual">
              <input
                type="text"
                placeholder="Or type a path: ~/projects/myapp"
                value={manualPath}
                onInput={(e) => { setManualPath((e.target as HTMLInputElement).value); setError(""); }}
              />
              {manualPath.trim() && (
                <button type="submit" class="btn btn-primary" disabled={!!creating}>
                  {creating === manualPath.trim() ? "Creating..." : "Go"}
                </button>
              )}
            </form>
          </>
        )}

        {tab === "browse" && (
          <div class="picker-browser">
            <div class="picker-breadcrumb">
              <button class="btn btn-ghost btn-small" onClick={navigateUp} disabled={browsePath === "/"}>
                ..
              </button>
              <span class="picker-current-path">{browseDisplay || "~"}</span>
              <button
                class="btn btn-primary btn-small"
                onClick={selectCurrent}
                disabled={!!creating || !browsePath}
              >
                {creating ? "Creating..." : "Select"}
              </button>
            </div>
            <div class="project-picker-list">
              {browseLoading ? (
                <div class="picker-empty">Loading...</div>
              ) : browseDirs.length > 0 ? (
                browseDirs.map((dir) => (
                  <Clickable
                    key={dir}
                    class="project-picker-item"
                    onClick={() => navigateInto(dir)}
                  >
                    <div class="project-picker-name">{dir}</div>
                  </Clickable>
                ))
              ) : (
                <div class="picker-empty">No subdirectories</div>
              )}
            </div>
          </div>
        )}

        {error && <div class="picker-error">{error}</div>}

        <div class="modal-actions">
          <button class="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Clickable>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function shortId(id: string | null | undefined): string {
  if (!id) return "";
  return id.replace(/^cse_/, "").slice(0, 6);
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
  } catch {
    /* ignore — Safari Private Mode */
  }
}

interface LiveRow {
  key: string;
  origin: "rc" | "vk" | "cli";
  slug: string | null;
  projectName: string;
  navigate: () => void;
  killSessionId: string | null;
  shortSid: string;
  verb: string;
  thinking: boolean;
  pendingCount: number;
  isCurrent: boolean;
}

// ---------------------------------------------------------------------------
// SessionList component
// ---------------------------------------------------------------------------
export function SessionList({
  onSelect,
}: {
  onSelect: (id: string) => void;
}) {
  const nav = useNav();
  const [showModal, setShowModal] = useState(false);
  const [showDevicePanel, setShowDevicePanel] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [pendingDeviceCount, setPendingDeviceCount] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [projectsCollapsed, setProjectsCollapsed] = useState<boolean>(readCollapsed);
  const [pinning, setPinning] = useState<Set<string>>(new Set());
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);

  // Devices poll
  useEffect(() => {
    const poll = () => {
      fetchPendingDevices()
        .then((r) => setPendingDeviceCount(Object.keys(r.devices).length))
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 10000);
    return () => clearInterval(id);
  }, []);

  // Initial sessions/projects fetch — App.tsx already does this on bootstrap,
  // but keep a defensive refetch in case the sidebar mounts after a hot
  // reload or the WS reconnects during a long session.
  useEffect(() => {
    fetchSessions().then((s) => (sessions.value = s)).catch(() => {});
    fetchProjects().then((p) => (projects.value = p as ProjectInfo[])).catch(() => {});
  }, []);

  const rehydrateProjectSessions = useCallback(() => {
    Promise.all(
      projects.value.map((p) =>
        fetchProjectSessions(p.path, 5)
          .then((cs) => [p.path, cs] as const)
          .catch(() => [p.path, [] as ProjectSession[]] as const),
      ),
    ).then((entries) => {
      const next = new Map(projectSessions.value);
      for (const [path, cs] of entries) next.set(path, cs);
      projectSessions.value = next;
    });
  }, []);

  // WS event handler — drives session list refresh + pendingActions counters.
  // Per-project rehydrate runs ONLY on `status` events here (App.tsx already
  // does the bulk pass on bootstrap).
  useEffect(() => {
    const handler = (e: Event) => {
      const raw = (e as CustomEvent).detail;
      const subtopic: string = raw?.subtopic ?? "";
      const sid: string = raw?.sessionId ?? "";

      if (subtopic === "status") {
        fetchSessions().then((s) => (sessions.value = s)).catch(() => {});
        rehydrateProjectSessions();
      }
      if ((subtopic === "permission" || subtopic === "question") && sid) {
        const map = new Map(pendingActions.value);
        map.set(sid, (map.get(sid) || 0) + 1);
        pendingActions.value = map;
      }
      if ((subtopic === "permission_response" || subtopic === "question_response") && sid) {
        const map = new Map(pendingActions.value);
        const count = (map.get(sid) || 1) - 1;
        if (count <= 0) map.delete(sid);
        else map.set(sid, count);
        pendingActions.value = map;
      }
    };
    wsManager.addEventListener("message", handler);
    return () => wsManager.removeEventListener("message", handler);
  }, [rehydrateProjectSessions]);

  // Close context menu on click anywhere
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [contextMenu]);

  // Live rows derivation — server-side join via `liveView`. The four-way
  // partition (rc/wrapper/cli) used to be done in-component over three
  // signals; now each row already carries origin/transport/slug/sdk_id.
  const liveRows = useMemo(() => {
    const rc: LiveRow[] = [];
    const vk: LiveRow[] = [];
    const cli: LiveRow[] = [];

    for (const r of liveView.value) {
      if (r.transport === "rc") {
        const cseId = r.cse_id ?? "";
        if (!cseId) continue;
        rc.push({
          key: `rc:${r.pid ?? cseId}:${cseId}`,
          origin: "rc",
          slug: r.slug,
          projectName: r.cwd_basename,
          navigate: () => nav.goRc(cseId),
          killSessionId: null,
          shortSid: shortId(cseId),
          verb: r.status_verb,
          thinking: false,
          pendingCount: pendingActions.value.get(cseId) ?? 0,
          isCurrent: false,
        });
      } else if (r.transport === "wrapper") {
        const sid = r.vakka_session_id;
        if (!sid) continue;
        const slug = r.slug;
        vk.push({
          key: `vk:${sid}`,
          origin: "vk",
          slug,
          projectName: r.cwd_basename,
          navigate: () => {
            if (slug) nav.goSession(slug, sid);
            onSelect(sid);
          },
          killSessionId: sid,
          shortSid: shortId(sid),
          verb: r.status_verb,
          thinking: false,
          pendingCount: pendingActions.value.get(sid) ?? 0,
          isCurrent: currentSessionId.value === sid,
        });
      } else {
        const slug = r.slug;
        const sdkId = r.sdk_session_id;
        cli.push({
          key: `cli:${r.pid ?? sdkId ?? r.cwd}`,
          origin: "cli",
          slug,
          projectName: r.cwd_basename,
          navigate: () => {
            if (slug && sdkId) nav.goSession(slug, sdkId);
            else if (slug) nav.goProject(slug);
            else if (sdkId) nav.goCli(sdkId);
          },
          killSessionId: null,
          shortSid: shortId(sdkId ?? `pid${r.pid ?? ""}`),
          verb: r.status_verb,
          thinking: false,
          pendingCount: sdkId ? pendingActions.value.get(sdkId) ?? 0 : 0,
          isCurrent: false,
        });
      }
    }

    return { rc, vk, cli };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    liveView.value,
    pendingActions.value,
    currentSessionId.value,
  ]);

  const totalLive = liveRows.rc.length + liveRows.vk.length + liveRows.cli.length;
  const distinctProjects = useMemo(() => {
    const all: LiveRow[] = [...liveRows.rc, ...liveRows.vk, ...liveRows.cli];
    const seen = new Set<string>();
    for (const r of all) seen.add(r.slug ?? `__orphan:${r.key}`);
    return seen.size;
  }, [liveRows]);

  // Project bucket derivation
  const buckets = useMemo(() => {
    const now = Date.now();
    const lq = searchQuery.trim().toLowerCase();
    const matchSearch = (p: ProjectInfo): boolean => {
      if (!lq) return true;
      return (
        p.name.toLowerCase().includes(lq) ||
        (p.display_slug ?? "").toLowerCase().includes(lq) ||
        p.path.toLowerCase().includes(lq)
      );
    };
    const ageOf = (iso: string | null): number =>
      iso ? Math.max(0, now - new Date(iso).getTime()) : Number.POSITIVE_INFINITY;
    const byAge = (a: ProjectInfo, b: ProjectInfo) =>
      ageOf(a.last_file_activity) - ageOf(b.last_file_activity);

    const filtered = projects.value.filter(matchSearch);
    const pinnedRows = filtered.filter((p) => p.pinned === 1).sort(byAge);
    const rest = filtered.filter((p) => p.pinned !== 1);

    const today: ProjectInfo[] = [];
    const week: ProjectInfo[] = [];
    const month: ProjectInfo[] = [];
    const older: ProjectInfo[] = [];
    for (const p of rest) {
      const a = ageOf(p.last_file_activity);
      if (a < 24 * HOUR) today.push(p);
      else if (a < 7 * DAY) week.push(p);
      else if (a < 30 * DAY) month.push(p);
      else older.push(p);
    }
    today.sort(byAge);
    week.sort(byAge);
    month.sort(byAge);
    older.sort(byAge);

    return { pinned: pinnedRows, today, week, month, older, totalAfterFilter: filtered.length };
  }, [projects.value, searchQuery]);

  // --- Handlers --------------------------------------------------------

  const handleContextMenu = useCallback((e: MouseEvent, sessionId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  }, []);

  const handleTouchStart = useCallback((sessionId: string) => {
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      setContextMenu({
        x: window.innerWidth / 2 - 70,
        y: window.innerHeight / 3,
        sessionId,
      });
    }, 500);
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleKill = async (sessionId: string) => {
    setContextMenu(null);
    try {
      await killSession(sessionId);
      fetchSessions().then((s) => (sessions.value = s)).catch(() => {});
      rehydrateProjectSessions();
    } catch (_) {}
  };

  const handleSessionCreated = (session: any) => {
    setShowModal(false);
    fetchSessions().then((s) => (sessions.value = s)).catch(() => {});
    onSelect(session.id);
  };

  const handlePinToggle = async (e: MouseEvent, p: ProjectInfo) => {
    e.stopPropagation();
    e.preventDefault();
    if (pinning.has(p.path)) return;
    const nextPinned = p.pinned === 1 ? 0 : 1;
    // Optimistic flip
    projects.value = projects.value.map((q) =>
      q.path === p.path ? { ...q, pinned: nextPinned } : q,
    );
    setPinning((s) => new Set(s).add(p.path));
    try {
      await setPinned(p.path, nextPinned === 1);
      const fresh = await fetchProjects();
      projects.value = fresh as ProjectInfo[];
    } catch (_) {
      // Revert on failure
      projects.value = projects.value.map((q) =>
        q.path === p.path ? { ...q, pinned: p.pinned } : q,
      );
    } finally {
      setPinning((s) => {
        const next = new Set(s);
        next.delete(p.path);
        return next;
      });
    }
  };

  const toggleCollapsed = () => {
    setProjectsCollapsed((v) => {
      writeCollapsed(!v);
      return !v;
    });
  };

  // --- Subviews --------------------------------------------------------

  const renderLiveRow = (row: LiveRow) => {
    const onClick = () => {
      if (longPressTriggered.current) {
        longPressTriggered.current = false;
        return;
      }
      row.navigate();
    };
    return (
      <Clickable
        key={row.key}
        class={`sess-row is-${row.origin}${row.isCurrent ? " is-current" : ""}`}
        onClick={onClick}
        onContextMenu={
          row.killSessionId
            ? (e: MouseEvent) => handleContextMenu(e, row.killSessionId!)
            : undefined
        }
        onTouchStart={
          row.killSessionId ? () => handleTouchStart(row.killSessionId!) : undefined
        }
        onTouchEnd={row.killSessionId ? handleTouchEnd : undefined}
      >
        <div class="sess-top">
          <span class="sess-dot" />
          <span class="sess-proj">{isDemoMode() ? redactSlug(row.projectName) : row.projectName}</span>
          {row.pendingCount > 0 && <span class="sess-badge">{row.pendingCount}</span>}
          {row.shortSid && <span class="sess-sid">{isDemoMode() ? redactId(row.shortSid) : row.shortSid}</span>}
        </div>
        <div class={`sess-verb${row.thinking ? " thinking" : ""}`}>
          {!row.thinking && <span class="blink">●</span>}
          {!row.thinking && " "}
          {row.verb}
        </div>
      </Clickable>
    );
  };

  const renderProjectRow = (p: ProjectInfo) => {
    const _rawSlug = p.display_slug || basename(p.path);
    const slug = isDemoMode() ? redactSlug(_rawSlug) : _rawSlug;
    const ago = formatAgo(p.last_file_activity);
    const onClick = () => {
      if (p.display_slug) nav.goProject(p.display_slug);
    };
    return (
      <Clickable key={p.path} class="proj-row" onClick={onClick}>
        <span class="slug-mark">/p/</span>
        <span class="slug-name">{slug}</span>
        <button
          class={`pin-btn${p.pinned === 1 ? " pinned" : ""}`}
          title={p.pinned === 1 ? "Unpin" : "Pin"}
          aria-label={p.pinned === 1 ? "Unpin project" : "Pin project"}
          onClick={(e) => handlePinToggle(e as any, p)}
        >
          {p.pinned === 1 ? "★" : "☆"}
        </button>
        <span class="ago">{ago}</span>
      </Clickable>
    );
  };

  const renderBucket = (
    label: string,
    icon: string,
    rows: ProjectInfo[],
    pinned = false,
  ) => {
    if (rows.length === 0) return null;
    return (
      <div class="bucket">
        <div class={`bucket-head${pinned ? " pinned" : ""}`}>
          <span class="bk-icon">{icon}</span>
          <span>{label}</span>
          <span class="rule" />
          <span class="bk-count">{rows.length}</span>
        </div>
        {rows.map(renderProjectRow)}
      </div>
    );
  };

  const showZeroResults =
    searchQuery.trim().length > 0 && buckets.totalAfterFilter === 0;

  return (
    <div class="sidebar">
      <div class="sidebar-head">
        <button
          class="brand"
          onClick={() => {
            currentSessionId.value = null;
            previewSession.value = null;
            nav.goHome();
          }}
          title="Back to dashboard"
        >
          <span class="dot" />VAKKA
        </button>
        <button
          class="new-btn"
          onClick={() => setShowModal(true)}
          title="New session"
          aria-label="New session"
        >
          +
        </button>
      </div>

      {/* ── LIVE AREA ── */}
      <div class="live-area">
        <div class={`live-tagline${totalLive === 0 ? " empty" : ""}`}>
          <em style="font-style: italic;">live now</em>{" "}
          <span class="count">
            {totalLive === 0
              ? "nothing running"
              : `${totalLive} session${totalLive === 1 ? "" : "s"} · ${distinctProjects} project${distinctProjects === 1 ? "" : "s"}`}
          </span>
        </div>

        {liveRows.rc.length > 0 && (
          <div class="origin-group">
            <div class="origin-head">
              <span class="tag rc">RC</span>
              <span class="desc">hijack</span>
              <span class="rule" />
            </div>
            {liveRows.rc.map(renderLiveRow)}
          </div>
        )}

        {liveRows.vk.length > 0 && (
          <div class="origin-group">
            <div class="origin-head">
              <span class="tag vk">VK</span>
              <span class="desc">spawn</span>
              <span class="rule" />
            </div>
            {liveRows.vk.map(renderLiveRow)}
          </div>
        )}

        {liveRows.cli.length > 0 && (
          <div class="origin-group">
            <div class="origin-head">
              <span class="tag cli">CLI</span>
              <span class="desc">snoop</span>
              <span class="rule" />
            </div>
            {liveRows.cli.map(renderLiveRow)}
          </div>
        )}
      </div>

      {/* ── PROJECTS AREA ── */}
      <div class="projects-area">
        <div class="proj-head">
          <Clickable
            class={`proj-tagline${projectsCollapsed ? " collapsed" : ""}`}
            onClick={toggleCollapsed}
            title={projectsCollapsed ? "Expand projects" : "Collapse projects"}
          >
            <em style="font-style: italic;">all projects</em>
            <span class="count">{projects.value.length}</span>
            <span class="caret">{projectsCollapsed ? "▸" : "▾"}</span>
          </Clickable>
          {!projectsCollapsed && (
            <label class="filter-wrap">
              <span class="glyph">⌕</span>
              <input
                class="filter-input"
                type="text"
                placeholder="filter projects…"
                value={searchQuery}
                onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
              />
              {searchQuery && (
                <button
                  class="filter-clear"
                  onClick={() => setSearchQuery("")}
                  title="Clear"
                  aria-label="Clear filter"
                >
                  ×
                </button>
              )}
            </label>
          )}
        </div>

        {!projectsCollapsed && (
          <div class="proj-scroll">
            {showZeroResults ? (
              <div class="sb-empty">
                <div class="line">no matches</div>
                <div class="hint">try a shorter query</div>
              </div>
            ) : projects.value.length === 0 ? (
              <div class="sb-empty">
                <div class="line">no projects yet</div>
                <div class="hint">click + to start one</div>
              </div>
            ) : (
              <>
                {renderBucket("Pinned", "★", buckets.pinned, true)}
                {renderBucket("Today", "◌", buckets.today)}
                {renderBucket("This week", "◎", buckets.week)}
                {renderBucket("This month", "◯", buckets.month)}
                {renderBucket("Older", "○", buckets.older)}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── FOOTER ── */}
      <div class="sidebar-foot">
        <button class="foot-link" onClick={() => setShowDevicePanel(true)}>
          {pendingDeviceCount > 0 && <span class="pending-dot" />}
          devices
          {pendingDeviceCount > 0 ? ` (${pendingDeviceCount})` : ""}
        </button>
        <span class="foot-sep">·</span>
        <button class="foot-link" onClick={() => setShowDebugPanel(true)}>
          debug
        </button>
        <span class="foot-sep">·</span>
        <button
          class="foot-link logout"
          onClick={() => {
            logout();
            location.reload();
          }}
        >
          logout
        </button>
      </div>

      {/* ── Context menu (kill) ── */}
      {contextMenu && (
        // biome-ignore lint/a11y/noStaticElementInteractions: positioned popup sink — the only onClick stops bubbling so document-level click-out dismiss doesn't immediately close it. Children handle real intent.
        // biome-ignore lint/a11y/useKeyWithClickEvents: see above.
        <div
          class="context-menu"
          style={`left: ${contextMenu.x}px; top: ${contextMenu.y}px;`}
          onClick={(e) => e.stopPropagation()}
        >
          <Clickable
            class="context-menu-item danger"
            onClick={() => handleKill(contextMenu.sessionId)}
          >
            Kill Session
          </Clickable>
        </div>
      )}

      {showModal && (
        <ProjectPickerModal
          onClose={() => setShowModal(false)}
          onCreated={handleSessionCreated}
        />
      )}
      {showDevicePanel && <DevicePanel onClose={() => setShowDevicePanel(false)} />}
      {showDebugPanel && <DebugPanel onClose={() => setShowDebugPanel(false)} />}
    </div>
  );
}
