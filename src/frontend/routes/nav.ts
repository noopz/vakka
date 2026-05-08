// Navigation helpers built on preact-iso's useLocation().
//
// Two ways to navigate:
//
// 1. Inside a component, call `useNav()` and invoke its returned methods —
//    this is the cleanest path because preact-iso's `route()` is bound to
//    the LocationProvider context.
//
// 2. From a non-hook context (rare), use `route(url)` directly — it falls
//    back to history.pushState + a popstate event so LocationProvider
//    re-renders. Used only as an escape hatch.
import { useLocation } from "preact-iso";

export function projectHref(slug: string): string {
  return `/p/${encodeURIComponent(slug)}`;
}

export function sessionHref(slug: string, sdkId: string): string {
  return `/p/${encodeURIComponent(slug)}/s/${encodeURIComponent(sdkId)}`;
}

export function useNav() {
  const loc = useLocation();
  return {
    goHome: (replace?: boolean) => loc.route("/", replace),
    goProject: (slug: string, replace?: boolean) =>
      loc.route(projectHref(slug), replace),
    goSession: (slug: string, sdkId: string, replace?: boolean) =>
      loc.route(sessionHref(slug, sdkId), replace),
    goRc: (cseId: string, replace?: boolean) =>
      loc.route(`/rc/${encodeURIComponent(cseId)}`, replace),
    goCli: (sdkId: string, replace?: boolean) =>
      loc.route(`/cli/${encodeURIComponent(sdkId)}`, replace),
  };
}
