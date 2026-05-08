---
name: chat-debug
description: When the user reports a chat-view bug (stuck "thinking", duplicate cards, cancel/STOP not working, message rendering wrong, prompt cards not resolving), check ALL these data sources before guessing. Each layer reveals different facts; conclusions from one alone are guesses.
---

# Chat Debug — multi-source triage

When something looks wrong in the chat (stuck thinking indicator, duplicate question/permission cards, cancel does nothing, messages render wrong, refresh resurrects resolved cards), do not reason from intuition or memory. Read the wire and read the DB. Then form a hypothesis.

The chat pipeline has five layers. A bug usually shows up at one layer but is caused at an earlier one. **Always read upstream layers first** — DB and NDJSON are the ground truth, frontend behavior is downstream of both.

## Layers and where to look

### 1. CC ↔ relay wire (NDJSON)
`~/.vakka/rc-relay-events.ndjson` — every SSE event from the CC worker, every `worker_put`, every relay HTTP call. Append-only; one JSON record per line.

```bash
# Trace one toolUseId through its whole lifecycle
grep '"toolu_<id>"' ~/.vakka/rc-relay-events.ndjson | jq -c '{ts, kind, payload_type: .payload.type, sequence_num}'

# Every event for one cseId in time order
grep '"cse_<id>"' ~/.vakka/rc-relay-events.ndjson | jq -c '{ts, kind}' | head -40

# Find duplicate control_request events (manager-restart replay)
grep "control_request" ~/.vakka/rc-relay-events.ndjson | jq -c 'select(.kind=="worker_event") | {ts, request_id: .payload.request_id, tool_use_id: .payload.request.tool_use_id}'
```

`~/.vakka/rc-sse.ndjson` — raw SSE bytes (much larger; use only when rc-relay-events doesn't tell the story).
`~/.vakka/rc-unknowns.ndjson` — events the relay couldn't classify; first place to look for "we never see X" bugs.
`~/.vakka/rc-capture.ndjson` — request/response capture from the bridge proxy.

Disable with `VK_RC_NO_LOG=1` (don't, normally).

### 2. Server logs (web + manager)
The user usually pastes these. Two prefixes:
- `[web    ]` — Express/WS process. Sources: `src/web/{api,websocket}.ts`, `src/relay/cc-rc-relay.ts`.
- `[manager]` — manager process. Source: `src/manager/{mqtt-handler,rc-attached,...}.ts`.

Key markers to grep for in pasted logs:
- `mqtt-handler` `output → N row(s) (kind)` — confirms a row was inserted
- `mqtt-handler` `question row #N → answered (lookup: toolUseId|questionId)` — confirms a status update landed
- `mqtt-handler` `question response NOT persisted` — the response had no matching row to update
- `rc-attached` `forwarded ... (request_id=...)` — request_id is the rc-relay correlation; `missing` means stale
- `ws` `Client subscribed to session` / `Unsubscribed` — frontend subscription window
- `status →` transitions for the session

### 3. SQLite DB (chat_messages)
`$VAKKA_DB_PATH` (defaults to `./data/vakka.db` relative to the repo root; override via env var). Table: `chat_messages`. This is the source of truth for what the frontend renders on refresh.

```bash
DB="${VAKKA_DB_PATH:-./data/vakka.db}"

# Every row for one toolUseId (DUPLICATE prompt-card rows are a known failure mode)
sqlite3 "$DB" "SELECT id, kind, datetime(created_at), substr(payload_json,1,100) FROM chat_messages WHERE tool_use_id = '<toolu_id>' ORDER BY id;"

# Last N rows for a session
sqlite3 "$DB" "SELECT id, kind, tool_use_id, substr(text,1,40) FROM chat_messages WHERE session_id = '<sid>' ORDER BY id DESC LIMIT 30;"

# Find sessions with duplicate prompt cards (the manager-restart-replay bug)
sqlite3 "$DB" "SELECT session_id, tool_use_id, COUNT(*) c FROM chat_messages WHERE kind IN ('question','permission_request','plan_proposal') GROUP BY session_id, tool_use_id HAVING c > 1;"
```

Schema discriminator: `kind`. Prompt cards: `question`, `permission_request`, `plan_proposal`. Status lives in `payload_json`. Correlations: `tool_use_id` (cross-kind), `question_id` (legacy question subtopic), `parent_id` (assistant ↔ tool_use).

### 4. WebSocket frame
`/ws` on the web process. The frontend's only live channel. Frame shapes:
- `{type:'chat_messages', sessionId, messages: NormalizedMessage[]}` — row insert OR row update (upsert by id on the frontend)
- `{type:'manager_online', ...}` — banner state
- raw streaming-delta envelopes via `output` subtopic — `text_delta`, `content_block_*`, `stream_event`, `message_start/stop`
- `status`, `cost`, `context`, `stream_snapshot` subtopics

Open Chrome DevTools → Network → WS to see frames. If the user reports a "frontend didn't update" bug, check whether the broadcast actually went out by grepping the manager log for the `mqtt-handler` row-update line that should have triggered `rebroadcastById`.

### 5. Frontend state
`src/frontend/views/chat-view.tsx`. Key signals:
- `messages.value` — the row stream; QuestionCard/PermissionCard/PlanProposalCard each render one entry
- `agentBusy` — drives "thinking" indicator. Set on `status=running`, cleared on `status=idle|completed|failed`
- `currentAction` — `useComputed` derived from `messages.value`: latest pending tool_use whose toolUseId isn't in the resolved set (resolved = matching tool_result OR a resolved prompt card in terminal state)
- `streamingMessageId` / `streamingContent` — token-stream accumulator

QuestionCard local state: `status` signal seeded from `initialStatus` prop, re-synced via `useEffect([initialStatus])`. Cancel sets `status="answered"` synchronously after the API call resolves.

## Triage recipe

When the user reports a chat bug:

1. **Get the toolUseId / sessionId from the user's screenshot or paste.** Most bugs are scoped to one tool_use lifecycle.
2. **Read upstream first.** NDJSON → server logs → DB. Don't open the frontend file until you have the answer to: *what does the DB actually say happened?*
3. **Form a hypothesis from the artifact gap.** Example: "DB has 3 question rows for one toolUseId, frontend shows 3 pending cards, cancel only flips one — duplicate insert at the manager layer." This is *not* a frontend bug; don't edit the frontend.
4. **Verify the hypothesis with one more grep before editing.** E.g. find every code path that inserts into `chat_messages` for that kind; check if any of them dedupe.
5. **Write the fix at the layer where the bug is, not where it shows up.**

## Common failure modes (and where they live)

| Symptom | Likely layer | First grep |
|---|---|---|
| Duplicate question/permission cards | manager (rc-relay SSE replay on reconnect, no dedupe in mqtt-handler insert) | `sqlite3 ... WHERE tool_use_id=...` for row count |
| Cancel/answer "doesn't update" the card | `updateChatMessageStatus` only hits `LIMIT 1`; sibling pending rows survive | DB row count for that toolUseId |
| "Stuck thinking" after CC is idle | `agentBusy` not cleared OR `currentAction` finds an unresolved tool_use | grep server log for `status → idle`; check WS frames; check `currentAction` resolved-set logic |
| Cancel hits `request_id=missing` | rc-attached's `requestIdByToolUseId` map already consumed; second cancel is stale | NDJSON for the `control_request` event's `request_id` field |
| Refresh resurrects a resolved card | row's `payload_json.status` is still `pending`, OR there's a sibling pending row | DB row dump |
| `requires_action_details.request_id` is `""` | wire quirk: real request_id only in `control_request` event payload, not worker_put body | NDJSON `worker_put` vs `worker_event` for that toolUseId |
| Tool_result shows raw JSON for AskUserQuestion/ExitPlanMode | frontend `renderMessage` should suppress these by toolName | `chat-view.tsx` tool_result render switch |
| Manager doesn't pick up backend code change | manager process intentionally NOT hot-reloaded (would SIGTERM agent children) | `POST /api/system/restart-manager` (exit-42 sentinel preserves children) |

## What NOT to do

- **Don't reason about the frontend before checking the DB.** Most "frontend bugs" are duplicate or stale rows.
- **Don't fix `updateChatMessageStatus` to update all rows.** That hides the upstream duplicate-insert bug. Fix the insert.
- **Don't propose `DROP TABLE` or schema migrations.** The user wipes the DB themselves; per `feedback_db_nuke_over_migration.md`, never write migration code. Cleanup deletes for orphan rows are fine.
- **Don't restart the manager on the user's behalf** unless they've confirmed they want it. The manager doesn't hot-reload code; backend edits require an explicit `POST /api/system/restart-manager`.
