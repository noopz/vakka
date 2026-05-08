
import { useState, useEffect } from "preact/hooks";
import { Clickable } from "./clickable.js";

interface SWInfo {
  state: string;
  scriptURL: string;
}

interface CacheInfo {
  name: string;
  count: number;
  urls: string[];
}

export function DebugPanel({ onClose }: { onClose: () => void }) {
  const [swInfo, setSwInfo] = useState<SWInfo | null>(null);
  const [caches, setCaches] = useState<CacheInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);

    // Service worker info
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg?.active) {
        setSwInfo({ state: reg.active.state, scriptURL: reg.active.scriptURL });
      } else if (reg?.waiting) {
        setSwInfo({ state: "waiting", scriptURL: reg.waiting.scriptURL });
      } else if (reg?.installing) {
        setSwInfo({ state: "installing", scriptURL: reg.installing.scriptURL });
      } else {
        setSwInfo(null);
      }
    }

    // Cache info
    if ("caches" in window) {
      const names = await window.caches.keys();
      const infos: CacheInfo[] = [];
      for (const name of names) {
        const cache = await window.caches.open(name);
        const keys = await cache.keys();
        infos.push({
          name,
          count: keys.length,
          urls: keys.map((r) => new URL(r.url).pathname),
        });
      }
      setCaches(infos);
    }

    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  const unregisterSW = async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    await refresh();
  };

  const clearCaches = async () => {
    const names = await window.caches.keys();
    await Promise.all(names.map((n) => window.caches.delete(n)));
    await refresh();
  };

  const nukeEverything = async () => {
    await unregisterSW();
    await clearCaches();
    localStorage.clear();
    sessionStorage.clear();
    location.reload();
  };

  return (
    <Clickable
      class="modal-overlay"
      tabIndex={-1}
      onClick={(e: Event) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="modal" style="max-width: 520px; max-height: 80vh; overflow-y: auto;">
        <h2>Debug</h2>

        {loading ? (
          <div style="color: var(--text-secondary)">Loading...</div>
        ) : (
          <div style="font-size: 13px; line-height: 1.6;">
            {/* Service Worker */}
            <div style="margin-bottom: 12px;">
              <div style="font-weight: 600; margin-bottom: 4px; color: var(--text-primary);">
                Service Worker
              </div>
              {swInfo ? (
                <div>
                  <div>State: <code>{swInfo.state}</code></div>
                  <div style="color: var(--text-secondary); word-break: break-all;">
                    {swInfo.scriptURL}
                  </div>
                </div>
              ) : (
                <div style="color: var(--text-secondary);">Not registered</div>
              )}
            </div>

            {/* Caches */}
            <div style="margin-bottom: 12px;">
              <div style="font-weight: 600; margin-bottom: 4px; color: var(--text-primary);">
                Caches
              </div>
              {caches.length === 0 ? (
                <div style="color: var(--text-secondary);">Empty</div>
              ) : (
                caches.map((c) => (
                  <div key={c.name} style="margin-bottom: 6px;">
                    <div><code>{c.name}</code> ({c.count} entries)</div>
                    <div style="color: var(--text-secondary); font-size: 12px; padding-left: 8px;">
                      {c.urls.map((u) => <div key={u}>{u}</div>)}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Storage */}
            <div style="margin-bottom: 16px;">
              <div style="font-weight: 600; margin-bottom: 4px; color: var(--text-primary);">
                Storage
              </div>
              <div style="color: var(--text-secondary); font-size: 12px;">
                <div>localStorage: {localStorage.length} keys</div>
                <div>sessionStorage: {sessionStorage.length} keys</div>
              </div>
            </div>

            {/* Actions */}
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <button class="btn btn-small" onClick={unregisterSW} disabled={!swInfo}>
                Unregister SW
              </button>
              <button class="btn btn-small" onClick={clearCaches} disabled={caches.length === 0}>
                Clear caches
              </button>
              <button class="btn btn-small btn-danger" onClick={nukeEverything} style="white-space: nowrap;">
                Nuke everything
              </button>
            </div>
          </div>
        )}

        <div class="modal-actions">
          <button class="btn btn-small" onClick={onClose}>Close</button>
        </div>
      </div>
    </Clickable>
  );
}
