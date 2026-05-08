# CC Remote Control Protocol — live capture (v0.1.A complete)

> Captured 2026-05-02 against CC 2.1.126 → Anthropic production via mitmproxy.
> Three captures:
> - `~/.vakka/rc-flows.har` — worker-side only, no turn.
> - `~/.vakka/rc-flows2.har` — full round-trip, one short turn.
> - `~/.vakka/rc-flows3.mitm` + `~/.vakka/rc-sse.ndjson` — multi-turn capture
>   including SSE frames teed via `tools/mitm/sse-tee.py` mitmproxy addon.
>   `accept-encoding: identity` strip on `/worker/events/stream` was required —
>   gzipped SSE can't be teed chunk-by-chunk by mitmproxy.
>
> Auth tokens redacted.

## Capture method

`HTTPS_PROXY=http://127.0.0.1:8080 NODE_EXTRA_CA_CERTS=$HOME/.mitmproxy/mitmproxy-ca-cert.pem`
honored by Bun's static BoringSSL. JS-level hooks (fetch / `node:http.request` /
`ClientRequest.prototype` / WebSocket) are **all unreachable**: Bun's `node:http` shim
buffers into a private symbol then dispatches via a Zig binding (`fetch.zig
nodeHttpClient`) without invoking any JS-visible HTTP path. ESM module-namespace
bindings (e.g. `http.request`) are non-configurable and silently reject writes.
Conclusion for future capture: `HTTPS_PROXY`+CA is the practical method. `SSLKEYLOGFILE`
is **not** honored.

## Endpoints (live, all on `api.anthropic.com`)

| Method | Path                                                                   | Auth         | Purpose                                                  |
| ------ | ---------------------------------------------------------------------- | ------------ | -------------------------------------------------------- |
| POST   | `/v1/code/sessions`                                                    | OAuth        | Create code session. Returns `{session: {id: cse_*, …}}`.|
| POST   | `/v1/code/sessions/{cseId}/bridge`                                     | OAuth        | Mint worker JWT. Returns `{worker_jwt, api_base_url, expires_in, worker_epoch}`. |
| GET    | `/v1/code/sessions/{cseId}/worker/events/stream`                       | worker_jwt   | SSE stream — server→worker events (controller turns, etc.). |
| POST   | `/v1/code/sessions/{cseId}/worker/events`                              | worker_jwt   | Worker→server batch of events. Body `{worker_epoch, events:[{payload}]}`. |
| POST   | `/v1/code/sessions/{cseId}/worker/events/delivery`                     | worker_jwt   | Worker ACK of server-pushed events received via SSE. Body `{worker_epoch, updates: [{event_id, status: "received"}]}`. **Required** — without these the server presumably treats the event as undelivered and may resend on reconnect (Last-Event-ID resume mechanism). |
| POST   | `/v1/code/sessions/{cseId}/worker/heartbeat`                           | worker_jwt   | Periodic heartbeat. Body `{session_id, worker_epoch}`. Resp `{}`. Cadence ≈ every few seconds while attached (9 hits in a ~30s session). |
| GET    | `/v1/code/sessions/{cseId}/worker`                                     | worker_jwt   | Worker poll. Returns `{worker: {session_id, worker_epoch, worker_status}}`. |
| PUT    | `/v1/code/sessions/{cseId}/worker`                                     | worker_jwt   | Worker status update. Body `{worker_status, worker_epoch, external_metadata}`. Distinct from `/heartbeat` — used for state changes (idle → working → idle). |
| POST   | `/v1/code/sessions/{cseId}/client/presence`                            | OAuth        | Controller-side presence ping. Body `{client_id, connected_at}`. Resp `{refresh_after_seconds: 20}`. |
| PATCH  | `/v1/sessions/{sessionId}`                                             | OAuth        | Update session metadata. Observed: `{title: "<derived from first user msg>"}` posted by CC after autotitle. |
| POST   | `/v1/sessions/{sessionId}/archive`                                     | OAuth        | Archive on `/exit-remote-control` or shutdown. Note: `session_*` id, not `cse_*`. |

**Out-of-scope (not relay traffic — direct to Anthropic):**
- `POST /v1/messages?beta=true` — actual LLM calls. **OAuth-authed** (Bearer `sk-ant-oat01-…`), `User-Agent: claude-cli/2.1.126 (external, cli)`, `anthropic-version: 2023-06-01`. Goes through CC's normal SDK client, not the worker channel. **Vakka's relay does NOT need to proxy these** — billing/usage stays normal.
- `POST /api/event_logging/v2/batch`, Datadog logs, Statsig — telemetry, leave untouched.
- `GET /api/claude_code_grove`, `/api/claude_code_penguin_mode`, `/api/claude_cli/bootstrap`, `/api/claude_code/notification/preferences`, `/api/oauth/account/settings` — config/feature gates.

Observed but **not** in this user-driven flow (need controller turn to capture):
`mark_read`, `teleport-events`, controller→worker POSTs (the chat input path), and
the actual SSE frame vocabulary.

## Two ID spaces

- **`cse_*`** — code-session id, used in `/v1/code/sessions/{cseId}/...` paths.
- **`session_*`** — general session id, used in `/v1/sessions/{sessionId}/archive`.
  Numerically the same suffix here (`015TEESpo5mX9KZR3PBY9qnx`); they're aliases
  with different prefixes for routing namespaces. Treat as one session, two URI
  shapes.

## Two auth tokens

CC holds the user's OAuth bearer (`sk-ant-oat01-…`). After `/bridge`, CC also
holds a worker JWT (`sk-ant-si-…`, ES256, kid `27IeYLpfXcVeN78zOxADrdnjKsy1AFlV4aKAeKxS7_I`,
4-hour TTL via `expires_in: 14400`).

Worker-side calls (`/worker/events*`, `/worker`) authenticate with the **worker JWT**
and `User-Agent: claude-code/2.1.126`.

Control-plane calls (`/v1/code/sessions`, `/bridge`, `/client/presence`, `/archive`)
authenticate with **OAuth** and `User-Agent: axios/1.13.6` — i.e. they're the axios
client in `bridgeApi.ts` / `codeSessionApi.ts`.

JWT decoded payload:
```json
{
  "account_uuid": "<user-uuid>",
  "application": "ccr",
  "aud": ["anthropic-api"],
  "exp": 1777773599, "iat": 1777759199,
  "iss": "ccr-service",
  "organization_uuid": "<org-uuid>",
  "role": "worker",
  "session_id": "cse_015TEESpo5mX9KZR3PBY9qnx"
}
```

## Bridge handshake (the critical exchange)

```
POST /v1/code/sessions/{cseId}/bridge
Authorization: Bearer sk-ant-oat01-…
Content-Type: application/json
{}
→ 200
{
  "api_base_url": "https://api.anthropic.com",
  "expires_in": 14400,
  "worker_epoch": "1",
  "worker_jwt": "sk-ant-si-eyJ…"
}
```

`api_base_url` is the field that — per Option 1 in the original recon — Vakka
overrides to point CC at our local relay for subsequent worker traffic. Body is
literally `{}`.

## Event-payload shape (huge for v0.1.B)

Worker→server events in `POST /worker/events` carry **payloads identical to the
SDK message envelope**. A full controller-driven turn ("hi" → "Hi! What would you
like to work on?") emits four worker/events POSTs in this order:

1. **`payload.type=assistant`** — synthetic "Remote Control connecting…" on session start.
2. **`payload.type=user`** — `{role:"user", content:"hi"}`. CC's worker echoes the user's
   prompt back as a worker event after receiving it from the SSE stream. (i.e. user
   messages flow controller→server→SSE→CC, *and then* CC re-publishes them via
   `/worker/events` so the server has a canonical record.)
3. **`payload.type=result`** — full result envelope including `total_cost_usd`, `usage`,
   `modelUsage`, `permission_denials`, `duration_ms`, `duration_api_ms`, `num_turns`,
   `stop_reason`, `is_error`, `subtype: "success"`. **This contradicts the earlier
   recon assumption that cost/context-usage was absent at the relay layer.** It IS
   present — Vakka's relay gets it for free in `/worker/events` payloads, no extra
   plumbing needed for chat-view to render cost.
4. **`payload.type=assistant`** — the actual reply text content.

Sample (synthetic "Remote Control connecting…"):

```json
{ "payload": {
    "type": "assistant",
    "message": { "id": "...", "role": "assistant", "model": "<synthetic>",
                 "content": [{ "type": "text", "text": "Remote Control connecting…" }],
                 "usage": { … }, "stop_reason": "stop_sequence", … },
    "session_id": "cse_…",
    "uuid": "…",
    "parent_tool_use_id": null
}}
```

Sample (user echo):

```json
{ "payload": {
    "type": "user",
    "message": { "role": "user", "content": "hi" },
    "session_id": "cse_…",
    "parent_tool_use_id": null,
    "uuid": "…",
    "timestamp": "…"
}}
```

Observed `payload.type` values from live capture: `assistant`, `user`, `result`,
`control_request`, `control_response`, `control_cancel_request`. Per the
static-recon switch, the full vocab also includes `client_event`, `server_event`,
`user_message`, `assistant_message`, `partial_message`, `tool_use`, `tool_result`.
The latter set may be inner forms (e.g. `tool_use` lives inside an `assistant`
message's `content` array, not as a top-level event payload type).

## Full permission-flow capture (rc-relay-spike, 2026-05-02)

A turn that exercised tool-use + permission prompt produced this 13-event sequence
through `POST /worker/events`:

```
seq  payload.type            worker_status (after PUT /worker)   notes
 1   assistant                                                    synthetic "Remote Control connecting…"
                             idle                                 first PUT /worker
 2   user                                                         user msg "hi" — controller echo
                             running
 3   result                                                       turn 1 cost/usage
 4   assistant                                                    reply text
                             idle
 5   user                                                         user msg "ls /tmp" — controller echo
 6   user                                                         (second user event — possibly tool_result canonicalized as user)
                             requires_action                      ← permission gate opened
 7   control_request                                              CC asks controller "approve Bash(ls /tmp)?"
                             (status PUT, value not captured)
 8   assistant                                                    tool_use envelope (Bash) likely embedded here
                             running                              ← controller approved
 9   control_response                                             CC's ACK of the controller's approval response
                             (status PUT)
10   control_cancel_request                                       cleanup of request UI on controller side
11   user                                                         tool_result canonicalized
                             idle
12   result                                                       turn 2 cost/usage
13   assistant                                                    final reply text
```

**Key inferences for v0.1.B / chat-view:**
- `worker_status: "requires_action"` is the canonical signal for "show permission
  card." It transitions in *before* the `control_request` event is emitted.
- `control_request` payloads (worker→server) carry the permission ask. Vakka's
  chat-view should render this as a permission card; the user's approve/deny click
  becomes a `control_response` SSE frame down to CC.
- `control_cancel_request` fires after the response — likely tells the controller
  to dismiss its UI. Vakka should treat it as "permission card resolved, dismiss."
- The double `user` event (seq 5 + 6) suggests CC posts both the controller's typed
  message AND a synthesized canonical record. Both have `payload.type=user`; relay
  republishers should not deduplicate by type alone.

## Permission flow — full shape (rc-relay-spike, 2026-05-02)

When a tool requires permission, the wire sequence is:

**1. Assistant emits a `tool_use` block** inside its `payload.message.content`:
```json
{
  "type": "tool_use",
  "id": "toolu_017wPm…",
  "name": "Bash",
  "input": {"command": "ls /tmp", "description": "List /tmp contents"},
  "caller": {"type": "direct"}
}
```

**2. Worker `PUT /worker` transitions to `requires_action`:**
```json
{
  "worker_epoch": 1,
  "worker_status": "requires_action",
  "requires_action_details": {
    "tool_name": "Bash",
    "display_tool_name": "Bash",
    "action_description": "List /tmp contents",
    "raw_command": "ls /tmp",
    "request_id": "f0a09251-…",
    "tool_use_id": "toolu_017wPm…"
  }
}
```

**3. Worker emits `payload.type=control_request`** in `POST /worker/events`:
```json
{
  "type": "control_request",
  "request_id": "f0a09251-…",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "Bash",
    "display_name": "Bash",
    "input": {"command": "ls /tmp", "description": "List /tmp contents"},
    "tool_use_id": "toolu_017wPm…",
    "description": "List /tmp contents",
    "permission_suggestions": [
      {
        "type": "addRules",
        "rules": [{"toolName": "Read", "ruleContent": "//private/tmp/**"}],
        "behavior": "allow",
        "destination": "session"
      }
    ],
    "blocked_path": "/private/tmp"
  },
  "session_id": "cse_…",
  "uuid": "…"
}
```
Subtype `can_use_tool` is the permission gate (separate from the SSE-side
`set_permission_mode` we saw earlier). `permission_suggestions[]` is CC's
suggested rule additions for the chat-view to surface as one-click options
(e.g. "Always allow Read in /private/tmp"); `destination ∈ {"session", "user", …}`.

**4. Controller responds via SSE `client_event`** (event_type=`control_response`).
The controller's decision lands back as `payload.type=control_response`:
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "f0a09251-…",
    "response": {  // doubly nested — `response.response`
      "behavior": "allow",
      "updatedInput": {"command": "ls /tmp", "description": "List /tmp contents"},
      "updatedPermissions": []
    }
  }
}
```
Or on deny:
```json
{
  "response": {
    "subtype": "success",  // SUCCESS, not error — "deny" is a successful resolution
    "request_id": "16e9ce41-…",
    "response": {"behavior": "deny", "message": "User denied permission"}
  }
}
```
- `behavior: "allow"` carries `updatedInput` (allowing the controller to mutate
  args before execution) and `updatedPermissions` (rules to add for future calls).
- `behavior: "deny"` carries a `message` shown to the user.

**5. Worker emits `control_cancel_request`** (cleanup):
```json
{"type": "control_cancel_request", "request_id": "f0a09251-…", "session_id": "cse_…", "uuid": "…"}
```

**6. Worker `PUT /worker` clears the action**, either with `worker_status: "running"` (approved, executing) or back to a normal state. Clears via `external_metadata.pending_action: null` PUT.

**7. On approval: tool runs**, then `payload.type=user` carries the canonical
`tool_result`:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "tool_use_id": "toolu_017wPm…",
      "type": "tool_result",
      "content": "<stdout text>"
    }]
  },
  "parent_tool_use_id": null,
  "session_id": "cse_…"
}
```
Note `parent_tool_use_id` stays null even for tool_result events — the
correlation key is `message.content[0].tool_use_id`, NOT the top-level field.

**On deny: synthetic interrupt user-event** is emitted:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{"type": "text", "text": "[Request interrupted by user for tool use]"}]
  }
}
```

## `payload.type=user` — three content shapes

Disambiguate by `message.content`:

| `message.content` shape                          | meaning                          |
| ------------------------------------------------ | -------------------------------- |
| string                                           | typed prompt OR synthesized text |
| `[{type:"tool_result", tool_use_id, content}]`   | tool execution result            |
| `[{type:"text", text}]`                          | system-synthesized notice (interrupt, deny, etc.) |

`parent_tool_use_id` is always null in this capture — do NOT use it for
disambiguation. Inspect `content[0].type` instead.

## Auto-approve mode

When the user has set the controller into "auto-approve" mode for a tool, the
permission flow short-circuits server-side: the worker still emits
`control_request` and `requires_action_details` PUT, but the controller responds
with `behavior: "allow"` automatically and CC never enters `worker_status:
"requires_action"` — instead emits a `PUT /worker` carrying ONLY
`{worker_epoch, external_metadata: {pending_action: {…}}}` (no `worker_status`
field) for telemetry, then a follow-up PUT with `pending_action: null` to clear.

This means Vakka chat-view should look at BOTH:
- `requires_action_details` (when transitioning to that status — show card)
- `external_metadata.pending_action` (auto-mode telemetry — optionally show inline tool-call indicator)

## Compact behavior (rc-relay-spike, 2026-05-02)

`/compact` produced no `control_request` / `tengu_compact` / dedicated event type
on the wire. The slash command is handled entirely inside CC; only the *result*
of compaction reaches the relay:

```
seq  payload.type    worker_status   notes
14   result                          cost/usage of compact's summarization call
                     running
15   user                            \  four canonical-record user events
16   user                            |  carrying the synthesized condensed
17   user                            |  history that seeds the new context
18   user                            /
```

**Implication for v0.1.B / chat-view:** slash commands processed by CC ARE
detectable — they emit synthesized `user` events with structured XML-like tags
in `message.content`. The pattern (per slash invocation):

1. `<local-command-caveat>Caveat: The messages below were generated by the user
   while running local commands. DO NOT respond to these messages...</local-command-caveat>`
   — header marker.
2. `<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>`
   — parsable command record. Args may be empty (`/compact`) or string (`/model haiku`,
   `/effort xhigh`).
3. (For `/compact` only:) the full conversation summary as a long string starting
   `"This session is being continued from a previous conversation..."`
4. `<local-command-stdout>Set model to Haiku 4.5</local-command-stdout>` (or
   `Compacted (ctrl+o to see full summary)`, or `Set effort level to xhigh: ...`)
   — human-readable result.

To detect a slash command in chat-view, scan `payload.message.content` (string)
for `<command-name>`. To extract structured info, regex out `<command-name>`,
`<command-args>`, and `<local-command-stdout>`. Other CC-internal tags also seen:
`<system-reminder>` (instructions CC sends to itself), `<local-command-caveat>`.

`/compact` produces 4 user events; `/model` and `/effort` produce 3 each. Vakka can't display "/compact ran" unless it parses the
content of the synthesized `user` events or detects the pattern (sudden burst of
several `user` events without a corresponding controller-side prompt). Three
distinct origins for `payload.type=user` are now confirmed:
1. Controller-typed prompt (echoed by CC after SSE delivery).
2. Tool result canonicalized as user-shaped event.
3. System-synthesized compaction summary.

Distinguishing them requires inspecting `payload.message.content` shape and
`parent_tool_use_id` — relay republishers should not collapse these.

**Implication for v0.1.B MQTT bridging:** the worker-events bodies map almost
1:1 onto the existing SDK-wrapper envelope shape. No translation layer needed —
the relay can republish payloads to `vakka/sessions/<id>/output` directly with the
same outer envelope as SDK-mode sessions. Cost / context-usage gaps documented
separately in `docs/cc-rc-bridge.md`.

## Worker-events response shape

```json
{ "results": [
    { "duplicate": false, "event_id": "<uuid>", "sequence_num": "1" }
]}
```

`sequence_num` is server-assigned, used for resume / dedup.

## Worker heartbeat

Two distinct mechanisms, both required:

**Periodic ping** — keeps the session marked alive on the server. Cadence: ~9 hits
in a ~30s session, so roughly every 3-4s.

```
POST /v1/code/sessions/{cseId}/worker/heartbeat
Authorization: Bearer sk-ant-si-…  (worker JWT)
{ "session_id": "cse_…", "worker_epoch": 1 }
→ 200 {}
```

**Status update** — fired on state transitions, not on a timer.

```
PUT /v1/code/sessions/{cseId}/worker
{ "worker_status": "idle", "worker_epoch": 1,
  "external_metadata": { "pending_action": null, "task_summary": null } }
→ 200 {}
```

`worker_status` values captured live (rc-relay-spike, full permission turn):
- `WORKER_STATUS_UNSPECIFIED` — initial.
- `idle` — connected, awaiting input.
- `running` — turn in flight, model generating / tools executing.
- `requires_action` — turn paused, awaiting controller approval of a `control_request`
  (e.g. permission prompt for a tool use). **Vakka chat-view should render a
  permission card whenever the worker enters this state.**

Likely also `error`, `offline` — still uncaptured.

## SSE stream — server→worker frame format

`GET /v1/code/sessions/{cseId}/worker/events/stream` opens with `Content-Type:
text/event-stream` and `Connection: keep-alive`. Two parallel streams open at
session start. **Frame format captured live (rc-sse.ndjson):**

Heartbeat (frequent, gaps of 5-15s):
```
:keepalive

```
(SSE comment line — single line beginning with `:`, blank line terminator.)

Real event:
```
event: client_event
id: <sequence_num>
data: {"event_id":"<uuid>","sequence_num":"<n>","event_type":"user","source":"client","payload":{...},"created_at":"..."}

```

**Frame fields:**
- `event:` — outer SSE event name. Only `client_event` observed so far. (Likely also
  `server_event`, `mark_read`, `teleport-events` — uncaptured.)
- `id:` — SSE Last-Event-ID, used for resume on reconnect. Server-monotonic.
- `data:` JSON — the inner envelope.

**Inner envelope fields:**
- `event_id` — UUID, used by the worker in `POST /worker/events/delivery` to ACK.
- `sequence_num` — string-encoded server-assigned sequence.
- `event_type` — values seen: `user`, `control_request`. (Likely also `tool_use`,
  `tool_result`, `partial_message`, `assistant`, etc.)
- `source` — values seen: `client` (sent by browser controller).
- `created_at` — ISO timestamp.
- `payload` — type-specific:

  **`event_type=user`:**
  ```json
  {
    "client_platform": "web_claude_ai",
    "message": {"role": "user", "content": "list files in the directory"},
    "parent_tool_use_id": null,
    "session_id": "session_…",
    "type": "user",
    "uuid": "<same as event_id>"
  }
  ```
  (Note `client_platform: "web_claude_ai"` — useful identifier; Vakka's controller
  should pick a distinct value like `vakka` to avoid spoofing the browser.)

  **`event_type=control_request`:**
  ```json
  {
    "request": {"mode": "default", "subtype": "set_permission_mode"},
    "request_id": "set-perm-mode-1777762035522-8l17b",
    "type": "control_request",
    "uuid": "<same as event_id>"
  }
  ```
  Subtypes seen: `set_permission_mode` with `request.mode ∈ {"default", …}`.
  Other subtypes likely exist (per static recon: interrupt, fork, etc.).

**Worker→server `payload.type=control_response`** (in `POST /worker/events`):
```json
{
  "type": "control_response",
  "response": {"subtype": "success", "request_id": "<echoes the request>"},
  "session_id": "cse_…",
  "uuid": "…"
}
```

**ID-space note:** SSE-frame `payload.session_id` uses `session_*` prefix; worker→server
`POST /worker/events` `payload.session_id` uses `cse_*`. Same numeric suffix, different
prefix. Both are accepted; relay should mirror whichever direction.

## Session lifecycle

1. `POST /v1/code/sessions` — create (`status: "active"`, `worker_status:
   WORKER_STATUS_UNSPECIFIED`).
2. `POST /v1/code/sessions/{cseId}/bridge` — mint worker JWT.
3. Two parallel `GET /worker/events/stream` SSE connections opened (redundancy?
   one is liveness, one is data?). Both 200 with empty body in this run because no
   server→worker events flowed before exit.
4. `POST /worker/events` — initial "Remote Control connecting…" assistant message.
5. `POST /client/presence` — controller (browser) registers. Response says ping
   every 20s.
6. `PUT /worker` — worker reports `idle`.
7. On `/exit`: `POST /v1/sessions/{sessionId}/archive` (note: `session_*` id).
8. After archive, any further `POST /worker/events` 409s with
   `"Session ... is not active"`. Worker keeps trying briefly and gets fatal-rejected.

## A3 exit-gate decisions

- **Hostname overlap**: CONFIRMED — relay is `api.anthropic.com` shared with model API.
  DNS-redirect approach dead. Vakka must do per-path interception, not whole-host.
- **Controller auth**: controller authenticates via OAuth (same `sk-ant-oat01-…` as the
  worker uses for control-plane). The browser at `claude.ai/code` reaches the relay
  on the same auth context. Vakka-as-controller path needs no Anthropic-minted controller
  token — just standard OAuth.
- **Transport**: HTTPS POST/PUT/GET + SSE. **No WebSocket** in this capture. Static
  recon's `replBridgeTransport.ts` reference suggests WS code paths exist but aren't
  used by 2.1.126 `/remote-control` (or only used in specific cases — daemon/peer modes).
- **Worker-vs-controller scope**: the worker-events payloads ARE the SDK envelope shape
  (huge win — no chat-view rewrite needed for v0.1.B). Cost / context-usage absent at
  this layer; need to confirm whether a separate channel carries them or they're truly
  worker-only state.
- **Ban-risk**: only signal that would trip relay-side anomaly detection is no
  worker-side traffic for sessions Vakka takes over. Mitigation: when Vakka relays for
  CC, still proxy worker events through to the real relay so Anthropic's pipeline sees
  unchanged shape, while Vakka mirrors them to the local controller. Decide in v0.1.B
  whether to implement now or accept the risk.

**Verdict: PROCEED to v0.1.B.** All exit gates clear with Option 1 (in-process
`api_base_url` rewrite at `/bridge` response time) as the recommended technique.

## What's still unknown (push to v0.1.A.2 follow-up capture)

1. **Tool-use turn shape** — `event_type=tool_use` / `tool_result` / `partial_message`
   on the SSE stream were not captured (the tool-use turn driven during rc-flows3 may
   have been blocked by the same Anthropic-side issue affecting browser→server
   delivery; user confirmed the issue reproduces without proxy on the official binary
   too — appears to be a transient outage 2026-05-02).
2. **Other `control_request` subtypes** beyond `set_permission_mode` — interrupt,
   fork, resume, etc.
3. **`mark_read` and `teleport-events`** — when do they fire? Probably on
   `/exit-remote-control` (handback) or session move.
4. **`SSE Last-Event-ID` resume** — observe a reconnect after a transient network blip
   to see how far back the server replays. The `worker/events/delivery` ACK mechanism
   is the worker-side half of this; reconnect-side half uncaptured.
5. **`worker_status` state machine** — full set of values + transitions.
6. **`SessionsV2Client` is the worker-stream client** but `replBridgeTransport.ts` (WS)
   appears unused. zread.ai notes confirm two transport generations (v1 WS,
   v2 SSE+CCR) — `/remote-control` in 2.1.126 is v2 SSE only.
7. **Multi-session `--spawn worktree` / `--capacity` mode** — `bridgeMain.ts` references
   `pollConfig.multisession_poll_interval_ms_at_capacity` and `capacityWake.signal()`
   suggesting a polling endpoint at capacity. Not yet captured (would require driving
   `vk-claude --spawn worktree --capacity 2+`).

## Vakka v0.1.B sketch (informed by capture)

Vakka stands up these endpoints (all on Vakka's existing HTTP server, mounted on a
new path or new port):

- `POST /v1/code/sessions/{cseId}/bridge` — pure spoof. Returns
  `{ api_base_url: "http://127.0.0.1:<vakka-port>", expires_in: 14400, worker_epoch:
  "<vakka-epoch>", worker_jwt: "<vakka-minted>" }`. CC's bridge response is what
  drives all subsequent worker-side traffic; redirecting it is the lever.
- `GET /v1/code/sessions/{cseId}/worker/events/stream` — Vakka-side SSE (frames Vakka
  generates from controller actions).
- `POST /v1/code/sessions/{cseId}/worker/events` — receives worker→server events,
  republishes onto MQTT `vakka/sessions/<cseId>/output` in the SDK envelope shape, and
  optionally proxies to real Anthropic for telemetry parity.
- `GET /v1/code/sessions/{cseId}/worker` + `PUT /v1/code/sessions/{cseId}/worker` —
  no-op heartbeat handlers.

The shim's job in v0.1.B is just: when CC's bridge POST response comes back from
Anthropic, rewrite `api_base_url` to point at the Vakka relay. After that, CC does
the rest with Vakka playing the relay role. (Or, alternative: the shim intercepts
the `/bridge` POST itself and short-circuits to a Vakka-minted response without
calling Anthropic at all — simpler, but loses the real `cse_*` / `worker_jwt` so
Anthropic-side telemetry/state is divergent.)

For minimum-viable v0.1.B: short-circuit `/bridge`. For ban-risk-aware v0.1.B:
proxy `/bridge` to Anthropic + rewrite `api_base_url` in the response.
