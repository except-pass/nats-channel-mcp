#!/usr/bin/env bash
# E2E Test: intro-chain
#
# Verifies the full A1 → A2 → done chain works end-to-end:
#   - A1 introduces itself as Montgomery Wafflesworth-Pudding
#   - A1 forwards to A2
#   - A2 introduces itself as Countess Beets McGillicuddy
#   - A2 publishes to done.chain-001
#   - The done message is received and verified
#
# Usage: ./test/e2e/intro-chain.sh
# Exit: 0 = PASS, 1 = FAIL

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXAMPLES="$ROOT/examples/intro-chain"
CHANNEL_KEY="nats"
DONE_SUBJECT="done.chain-001"
DONE_OUTPUT="/tmp/nats-e2e-done-$$"
TIMEOUT_SECONDS=60

# ── Colours ────────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; }
fail() { echo -e "${RED}✗ FAIL${NC}: $1"; teardown; exit 1; }
info() { echo -e "${YELLOW}→${NC} $1"; }

# ── Teardown ───────────────────────────────────────────────────────────────────

teardown() {
  info "Tearing down..."
  tmux kill-session -t e2e-a1 2>/dev/null || true
  tmux kill-session -t e2e-a2 2>/dev/null || true
  rm -f "$DONE_OUTPUT"
}

trap teardown EXIT

# ── Setup ──────────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════"
echo "  E2E Test: intro-chain"
echo "══════════════════════════════════════════"
echo ""

# NATS server — must be running before the test starts
if ! pgrep -x nats-server > /dev/null; then
  echo ""
  echo -e "${RED}✗ FAIL${NC}: NATS server is not running."
  echo ""
  echo "  Start it first:  nats-server"
  echo "  Then retry:      bun test:e2e"
  echo ""
  exit 1
fi
pass "NATS server is running"

# Generate .mcp.json files with absolute paths
info "Generating .mcp.json files..."
for agent in a1 a2; do
  AGENT_DIR="$EXAMPLES/agents/$agent"
  cat > "$AGENT_DIR/.mcp.json" <<EOF
{
  "mcpServers": {
    "$CHANNEL_KEY": {
      "command": "bun",
      "args": [
        "$ROOT/channel-server.ts",
        "--name", "$agent",
        "--topics-file", "$AGENT_DIR/topics.txt",
        "--nats", "nats://localhost:4222",
        "--instructions-file", "$AGENT_DIR/AGENT.md"
      ]
    }
  }
}
EOF
done
pass ".mcp.json files generated"

# ── Helper: wait for text in tmux pane ────────────────────────────────────────

wait_for_pane() {
  local session="$1"
  local text="$2"
  local label="$3"
  local elapsed=0
  while ! tmux capture-pane -t "$session" -p -S -100 2>/dev/null | grep -q "$text"; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
      fail "Timeout waiting for '$text' in $session"
    fi
  done
  pass "$label"
}

# ── Helper: auto-confirm dev channels prompt ──────────────────────────────────

auto_confirm() {
  local session="$1"
  local elapsed=0
  while ! tmux capture-pane -t "$session" -p -S -20 2>/dev/null | grep -q "I am using this for local development"; do
    sleep 0.5
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge 30 ]; then
      fail "Timeout waiting for dev channels confirmation in $session"
    fi
  done
  tmux send-keys -t "$session" "1" ""
  sleep 0.3
  tmux send-keys -t "$session" "" ""
}

# ── Launch agents ──────────────────────────────────────────────────────────────

tmux kill-session -t e2e-a1 2>/dev/null || true
tmux kill-session -t e2e-a2 2>/dev/null || true

info "Launching A1 (Montgomery Wafflesworth-Pudding)..."
tmux new-session -d -s e2e-a1 -x 200 -y 50 \
  "cd $EXAMPLES/agents/a1 && claude --mcp-config .mcp.json --dangerously-skip-permissions --dangerously-load-development-channels server:${CHANNEL_KEY}"

info "Launching A2 (Countess Beets McGillicuddy)..."
tmux new-session -d -s e2e-a2 -x 200 -y 50 \
  "cd $EXAMPLES/agents/a2 && claude --mcp-config .mcp.json --dangerously-skip-permissions --dangerously-load-development-channels server:${CHANNEL_KEY}"

# Auto-confirm dev channels prompts
info "Waiting for dev channel confirmation prompts..."
auto_confirm e2e-a1
auto_confirm e2e-a2

# Wait for both agents to be fully listening
info "Waiting for agents to be ready..."
wait_for_pane e2e-a1 "Listening for channel messages" "A1 is listening"
wait_for_pane e2e-a2 "Listening for channel messages" "A2 is listening"

# ── Dispatch and capture ───────────────────────────────────────────────────────

info "Starting done-subject listener..."
nats sub --count=1 "$DONE_SUBJECT" > "$DONE_OUTPUT" 2>&1 &
LISTENER_PID=$!
sleep 1  # give listener time to subscribe

info "Dispatching trigger to A1..."
nats pub agents.a1 "Please introduce yourself."

# Wait for the done message
info "Waiting for chain completion (timeout: ${TIMEOUT_SECONDS}s)..."
ELAPSED=0
while ! [ -s "$DONE_OUTPUT" ]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge "$TIMEOUT_SECONDS" ]; then
    fail "Timeout: done message never arrived on $DONE_SUBJECT"
  fi
done

# Give a moment for the full message to flush
sleep 1
DONE_MSG=$(cat "$DONE_OUTPUT")

# ── Assertions ─────────────────────────────────────────────────────────────────

echo ""
info "Received on $DONE_SUBJECT:"
echo "  $DONE_MSG"
echo ""

if echo "$DONE_MSG" | grep -qi "Countess Beets McGillicuddy"; then
  pass "A2 introduced itself correctly (Countess Beets McGillicuddy)"
else
  fail "Expected 'Countess Beets McGillicuddy' in done message, got: $DONE_MSG"
fi

# Also verify A1 introduced itself in its pane
if tmux capture-pane -t e2e-a1 -p -S -200 | grep -qi "Montgomery Wafflesworth-Pudding"; then
  pass "A1 introduced itself correctly (Montgomery Wafflesworth-Pudding)"
else
  fail "Expected 'Montgomery Wafflesworth-Pudding' in A1's output"
fi

# ── Result ─────────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════"
echo -e "  ${GREEN}ALL ASSERTIONS PASSED${NC}"
echo "══════════════════════════════════════════"
echo ""
