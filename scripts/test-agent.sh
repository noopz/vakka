#!/bin/bash
# Quick smoke test: spawn an agent, send a message, watch for output.
# Requires: mosquitto running, manager running, web server running.
# Usage: ./scripts/test-agent.sh [project_path] [message] [timeout_seconds]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VAKKA_DIR="$(dirname "$SCRIPT_DIR")"
AUTH_FILE="$VAKKA_DIR/config/auth.json"

PROJECT="${1:-/tmp/vakka-test}"
MESSAGE="${2:-Say hello in one sentence}"
TIMEOUT="${3:-90}"

# Create test project dir if it doesn't exist
mkdir -p "$PROJECT"

# Get auth token
TOKEN=$(python3 -c "import json; print(json.load(open('$AUTH_FILE'))['token'])")
AUTH="Authorization: Bearer $TOKEN"

echo "=== Vakka Agent Smoke Test ==="
echo "Project: $PROJECT"
echo "Message: $MESSAGE"
echo "Timeout: ${TIMEOUT}s"
echo ""

# 1. Check health
echo "1. Health check..."
curl -sf -H "$AUTH" http://localhost:3000/api/health | python3 -m json.tool
echo ""

# 2. Spawn a session
echo "2. Spawning session..."
SPAWN_RESULT=$(curl -sf -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"projectPath\":\"$PROJECT\"}" \
  http://localhost:3000/api/sessions)
echo "$SPAWN_RESULT" | python3 -m json.tool

SESSION_ID=$(echo "$SPAWN_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionId','') or json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
if [ -z "$SESSION_ID" ]; then
  echo "ERROR: No sessionId in response"
  exit 1
fi
echo "Session ID: $SESSION_ID"
echo ""

# 3. Wait for agent to start and SDK to initialize
echo "3. Waiting for agent to start (5s)..."
sleep 5

# 4. Check session status
echo "4. Session status:"
curl -sf -H "$AUTH" "http://localhost:3000/api/sessions/$SESSION_ID" | python3 -m json.tool
echo ""

# 5. Subscribe to MQTT output (background, capture for full timeout)
echo "5. Subscribing to MQTT output (${TIMEOUT}s window)..."
MQTT_LOG="/tmp/vakka-test-mqtt.log"
> "$MQTT_LOG"
mosquitto_sub -t "vakka/sessions/$SESSION_ID/#" -v --timeout "$TIMEOUT" > "$MQTT_LOG" 2>/dev/null &
SUB_PID=$!

# 6. Send message
echo "6. Sending message: \"$MESSAGE\""
curl -sf -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"text\":\"$MESSAGE\"}" \
  "http://localhost:3000/api/sessions/$SESSION_ID/messages" | python3 -m json.tool
echo ""

# 7. Wait for output — poll every 5s, stop early if we see a result message
echo "7. Waiting for response (up to ${TIMEOUT}s)..."
ELAPSED=0
while [ $ELAPSED -lt "$TIMEOUT" ]; do
  sleep 5
  ELAPSED=$((ELAPSED + 5))

  # Check if we got any output messages
  OUTPUT_COUNT=$(grep -c "output" "$MQTT_LOG" 2>/dev/null || true)
  OUTPUT_COUNT="${OUTPUT_COUNT:-0}"
  RESULT_COUNT=$(grep -c '"type":"result"' "$MQTT_LOG" 2>/dev/null || true)
  RESULT_COUNT="${RESULT_COUNT:-0}"
  STATUS_COUNT=$(grep -c "status" "$MQTT_LOG" 2>/dev/null || true)
  STATUS_COUNT="${STATUS_COUNT:-0}"

  echo "  [${ELAPSED}s] MQTT messages: output=$OUTPUT_COUNT result=$RESULT_COUNT status=$STATUS_COUNT"

  # If we got a result message, the turn is done
  if [ "$RESULT_COUNT" -gt 0 ]; then
    echo "  Got result message — agent responded!"
    break
  fi
done

# Kill the MQTT subscriber
kill $SUB_PID 2>/dev/null || true
wait $SUB_PID 2>/dev/null || true

echo ""
echo "=== MQTT Messages Received ==="
if [ -s "$MQTT_LOG" ]; then
  # Show topic names and truncated payloads
  while IFS= read -r line; do
    TOPIC=$(echo "$line" | cut -d' ' -f1)
    PAYLOAD=$(echo "$line" | cut -d' ' -f2-)
    # Truncate long payloads
    if [ ${#PAYLOAD} -gt 200 ]; then
      PAYLOAD="${PAYLOAD:0:200}..."
    fi
    echo "  $TOPIC"
    echo "    $PAYLOAD"
  done < "$MQTT_LOG"
else
  echo "(none)"
fi
echo ""

# 8. Check messages in DB
echo "=== Messages in DB ==="
curl -sf -H "$AUTH" "http://localhost:3000/api/sessions/$SESSION_ID/messages" | python3 -m json.tool 2>/dev/null || echo "(failed to fetch)"
echo ""

# 9. Check agent log
AGENT_LOG="$VAKKA_DIR/logs/agents/$SESSION_ID.log"
echo "=== Agent Log ==="
if [ -f "$AGENT_LOG" ]; then
  cat "$AGENT_LOG"
else
  echo "(no agent log found at $AGENT_LOG)"
fi
echo ""

# 10. Kill the session (only after we've collected all output)
echo "10. Killing session..."
curl -sf -H "$AUTH" -H "Content-Type: application/json" \
  -X POST "http://localhost:3000/api/sessions/$SESSION_ID/kill" | python3 -m json.tool 2>/dev/null || echo "(kill failed or session already dead)"

echo ""
echo "Done."
