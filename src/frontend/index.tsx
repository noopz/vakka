import { render } from "preact";
import { App } from "./App.js";
import { applyBodyClasses } from "./utils/demo-mode.js";

applyBodyClasses();
render(<App />, document.getElementById("app")!);

// Unregister any leftover service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) reg.unregister();
  });
  caches.keys().then((keys) => {
    for (const key of keys) caches.delete(key);
  });
}
