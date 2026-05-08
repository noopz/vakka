import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { getToken, getDeviceId, getDeviceSecret } from "./services/auth.js";
import { wsManager } from "./services/websocket-manager.js";
import { fetchSessions, fetchProjects, fetchLiveView, verifyDevice } from "./services/api.js";
import {
  isPhone,
  sessions,
  projects,
  liveView,
  currentSessionId,
  managerRestarting,
  managerStartedAt,
} from "./signals/index.js";
import { LoginView } from "./views/login-view.js";
import { SessionList } from "./views/session-list.js";
import { LocationProvider, Router, Route } from "preact-iso";
import { HomeRoute } from "./routes/home-route.js";
import { ProjectHomeRoute } from "./routes/project-home-route.js";
import { ChatRoute } from "./routes/chat-route.js";
import { RcRoute } from "./routes/rc-route.js";
import { CliRoute } from "./routes/cli-route.js";

export function App() {
  const authenticated = useSignal(false);
  const checking = useSignal(true);

  useEffect(() => {
    // Legacy hash links (#/session/<id>) from the old PhoneRouter — redirect to
    // home so old bookmarks land cleanly on the new path-based router.
    if (location.hash.startsWith("#/")) {
      history.replaceState(null, "", "/");
    }

    // Detect phone
    const phone = /iPhone|Android/i.test(navigator.userAgent);
    isPhone.value = phone;
    document.documentElement.setAttribute(
      "data-layout",
      phone ? "phone" : "desktop"
    );

    // Verify device credentials are actually trusted before showing the app
    // Bootstrap: await sessions + projects together before flipping `checking`
    // off, so the sidebar paints once with both signals populated. Without
    // this, projects land first → sidebar shows everything as idle, sessions
    // land → rows shuffle, per-project hydration lands → rows shuffle again.
    const bootstrap = async () => {
      wsManager.connect(getToken() || undefined);
      const [s, p] = await Promise.all([
        fetchSessions().catch(() => [] as any[]),
        fetchProjects().catch(() => [] as any[]),
      ]);
      sessions.value = s;
      projects.value = p;
    };

    (async () => {
      const id = getDeviceId();
      const secret = getDeviceSecret();
      if (id && secret) {
        try {
          const result = await verifyDevice(id, secret);
          if (result.status === "trusted") {
            authenticated.value = true;
            await bootstrap();
          }
        } catch {
          // Server unreachable — fall through to login
        }
      } else if (getToken()) {
        // Legacy bearer token — trust it (no verify endpoint)
        authenticated.value = true;
        await bootstrap();
      }
      checking.value = false;
    })();
  }, []);

  // Manager hot-restart banner — listen for manager_online events from the
  // server. The "Restart manager" menu item sets managerRestarting to true; we
  // clear it once we see a "up" beacon with a startedAt different from the one
  // we had at click time (so a stale "up" doesn't dismiss the banner early).
  useEffect(() => {
    const onMessage = (e: Event) => {
      const data = (e as CustomEvent).detail;
      if (data?.type !== "manager_online") return;
      if (data.status === "up" && typeof data.startedAt === "number") {
        const prev = managerStartedAt.value;
        managerStartedAt.value = data.startedAt;
        if (managerRestarting.value && prev !== null && data.startedAt !== prev) {
          managerRestarting.value = false;
        }
      }
    };
    wsManager.addEventListener("message", onMessage);
    return () => wsManager.removeEventListener("message", onMessage);
  }, []);

  // Top-level poller for the unified live-view feed (GET /api/live).
  // Visibility-gated — hidden tabs don't burn requests.
  useEffect(() => {
    if (!authenticated.value) return;
    const poll = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      fetchLiveView()
        .then((r) => { liveView.value = r; })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [authenticated.value]);

  if (checking.value) {
    return null;
  }

  if (!authenticated.value) {
    return <LoginView />;
  }

  const banner = managerRestarting.value ? (
    <div class="manager-restart-banner" role="status" aria-live="polite">
      Restarting manager… active conversations will reattach automatically.
    </div>
  ) : null;

  return (
    <LocationProvider>
      <div class="app-shell">
        {banner}
        <SessionList
          onSelect={(id) => {
            currentSessionId.value = id;
          }}
        />
        <Router>
          <Route path="/" component={HomeRoute} />
          <Route path="/p/:slug" component={ProjectHomeRoute} />
          <Route path="/p/:slug/s/:sdkId" component={ChatRoute} />
          <Route path="/rc/:cseId" component={RcRoute} />
          <Route path="/cli/:sdkId" component={CliRoute} />
          <Route default component={HomeRoute} />
        </Router>
      </div>
    </LocationProvider>
  );
}
