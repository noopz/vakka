# Future consideration: replace mosquitto with embedded Aedes broker

Status: deferred. Tracked for revisit if mosquitto's operational footprint
becomes painful or if Vekka needs to ship as a single-process binary.

## Context

Vekka uses Mosquitto as its MQTT broker. The auth-hardening plan (Commit 3,
Approach 3a) adds password auth + localhost-only listener config to a
system-managed mosquitto. This works but has operational downsides:

- User must `brew services start mosquitto` (or systemd equivalent) and
  re-run after upgrades.
- A separate config file lives at `/opt/homebrew/etc/mosquitto/mosquitto.conf`
  (macOS) or `/etc/mosquitto/mosquitto.conf` (Linux), outside Vekka's repo.
- `mosquitto_passwd` must be on PATH for first-boot credential generation.
- Cross-platform install path is annoying (Docker, brew, apt, …).

## Approach 3b — embed Aedes

Replace mosquitto with [Aedes](https://github.com/moscajs/aedes), a Node MQTT
broker. Boot it inside the web process (or the manager process) on a
localhost port, accept only credentials issued from `~/.vakka/auth.json`.

### Sketch

```ts
// src/shared/mqtt-broker.ts (NEW)
import Aedes from "aedes";
import { createServer } from "node:net";
import { loadAuthConfig } from "../web/auth.js";

export function startEmbeddedBroker(port = 1883): Promise<void> {
  const aedes = Aedes();
  aedes.authenticate = (client, username, password, cb) => {
    const creds = loadAuthConfig().mqtt;
    const ok = username === creds.username
      && password?.toString() === creds.password;
    cb(null, ok);
  };
  const server = createServer(aedes.handle);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });
}
```

Boot from `src/web/index.ts` BEFORE `createMQTTClient("web")` connects.

### Tradeoffs vs 3a (mosquitto + creds)

| Concern | 3a (mosquitto) | 3b (Aedes) |
|---|---|---|
| Install footprint | Brew/apt + service manager | Single npm dep |
| Cross-platform | Per-OS install path | Uniform (Node) |
| Memory overhead | ~5 MB (system process) | Shared with web process |
| Persistence | Built-in, configurable | In-memory by default; need `aedes-persistence-*` for durability |
| Cluster support | Yes (mosquitto bridges) | aedes-cluster but immature |
| Operator familiarity | High (industry standard) | Lower |
| Crash isolation | Independent process | Tied to web process — broker dies if web crashes |
| Failed-connect retry | mqtt.js handles it | Same — but if web process restarts, all subscribers reconnect together |
| Performance ceiling | ~200k msg/s on commodity HW | ~30–80k msg/s for Aedes (Node-bound) |

### Why deferred

1. mosquitto already works and is configured (the `vakka` repo has run on it
   for the lifetime of the project).
2. Vekka is single-user dev tooling; performance ceiling is irrelevant.
3. The "embed in web process" path couples broker lifetime to web process
   lifetime — a web restart would knock all subscribers offline simultaneously,
   amplifying the manager-restart race that already exists.
4. Approach 3a closes the security gap with ~30 lines of config + a one-time
   user `brew services restart mosquitto`.

### Triggers for revisit

- Vekka starts shipping to other users and the brew/apt install step becomes
  the #1 onboarding friction point.
- Vekka grows a "single binary install" packaging story.
- mosquitto's own auth config bites us (e.g. password rotation, multi-user).
- We want to add MQTT-level features (retained messages with TTL, custom
  authorizer plugins) that mosquitto doesn't expose conveniently from
  Bun/Node.

### Migration path if/when this happens

1. Add `src/shared/mqtt-broker.ts` per the sketch above.
2. Boot embedded broker in `src/web/index.ts` BEFORE `createMQTTClient`.
3. Move `loadAuthConfig().mqtt` creds to be the embedded broker's source of
   truth (still file-backed, still part of auth.json — no schema change).
4. Document mosquitto removal in README; provide a one-shot
   `vakka migrate-from-mosquitto` script that backs up the old conf and
   confirms Aedes is reachable.
5. Add `tests/embedded-broker.test.ts` covering the auth flow.

Estimated effort: ~1 day, including test coverage and README.
