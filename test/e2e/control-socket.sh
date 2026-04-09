#!/usr/bin/env bash
# E2E Test: control-socket
#
# Verifies the --control-socket flag end-to-end:
#   - server starts and creates the socket file
#   - a JSON subscribe command over the socket adds a live subscription
#   - NATS messages on that subject reach the server and get logged
#   - a JSON unsubscribe command removes the subscription
#   - subsequent NATS messages are NOT received
#   - SIGTERM shuts the server down and unlinks the socket
#
# Does NOT require Claude Code — only bun, nats-server, nats CLI, and nc.
#
# Usage: ./test/e2e/control-socket.sh
# Exit: 0 = PASS, 1 = FAIL

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_NAME="ctrl-e2e-$$"
SOCK="/tmp/nats-channel-ctrl-e2e-$$.sock"
STDERR_LOG="/tmp/nats-channel-ctrl-e2e-$$.stderr.log"
INIT_SUBJECT="ctrl-e2e-$$.init"
HOT_SUBJECT="ctrl-e2e-$$.hot"
TIMEOUT_SECONDS=10

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; }
fail() { echo -e "${RED}✗ FAIL${NC}: $1"; teardown; exit 1; }
info() { echo -e "${YELLOW}→${NC} $1"; }

SERVER_PID=""

teardown() {
  info "Tearing down..."
  if [ -n "$SERVER_PID" ]; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$SOCK" "$STDERR_LOG"
}

trap teardown EXIT

echo ""
echo "══════════════════════════════════════════"
echo "  E2E Test: control-socket"
echo "══════════════════════════════════════════"
echo ""

# ── Prerequisites ─────────────────────────────────────────────────────────────

if ! pgrep -x nats-server > /dev/null; then
  echo ""
  echo -e "${RED}✗ FAIL${NC}: NATS server is not running."
  echo "  Start it first:  nats-server"
  echo ""
  exit 1
fi
pass "NATS server is running"

for cmd in bun nc nats; do
  if ! command -v "$cmd" > /dev/null; then
    fail "Required command not found: $cmd"
  fi
done
pass "bun, nc, nats CLI all available"

# ── Launch channel-server with control socket ────────────────────────────────

info "Starting channel-server with --control-socket..."
bun run "$ROOT/channel-server.ts" \
    --name "$AGENT_NAME" \
    --subscribe "$INIT_SUBJECT" \
    --nats nats://localhost:4222 \
    --control-socket "$SOCK" \
    < /dev/null > /dev/null 2> "$STDERR_LOG" &
SERVER_PID=$!

# Wait for the "ctrl socket listening" line
elapsed=0
while ! grep -q "ctrl socket listening" "$STDERR_LOG" 2>/dev/null; do
  sleep 0.2
  elapsed=$((elapsed + 1))
  if [ "$elapsed" -ge "$((TIMEOUT_SECONDS * 5))" ]; then
    fail "Server never logged 'ctrl socket listening'. stderr: $(cat "$STDERR_LOG")"
  fi
done
pass "Server logged 'ctrl socket listening'"

if [ ! -S "$SOCK" ]; then
  fail "Socket file not created at $SOCK"
fi
pass "Socket file exists at $SOCK"

if ! grep -q "subscribed to $INIT_SUBJECT" "$STDERR_LOG"; then
  fail "Initial --subscribe subject not in stderr"
fi
pass "Initial --subscribe honored"

# ── Hot-subscribe via control socket ─────────────────────────────────────────

info "Sending hot-subscribe command..."
echo "{\"action\":\"subscribe\",\"subject\":\"$HOT_SUBJECT\"}" | nc -U -q 1 "$SOCK"
sleep 0.3

if ! grep -q "subscribed to $HOT_SUBJECT" "$STDERR_LOG"; then
  fail "Hot-subscribe not reflected in stderr. Log: $(cat "$STDERR_LOG")"
fi
pass "Hot-subscribe honored"

# ── Publish on hot-subscribed subject ────────────────────────────────────────

info "Publishing NATS message on $HOT_SUBJECT..."
nats --server=nats://localhost:4222 pub "$HOT_SUBJECT" "hello-from-control-socket-test" > /dev/null
sleep 0.5

if ! grep -q "received on $HOT_SUBJECT: hello-from-control-socket-test" "$STDERR_LOG"; then
  fail "Published message did not reach the server. Log: $(cat "$STDERR_LOG")"
fi
pass "Published NATS message received on hot-subscribed subject"

# ── Hot-unsubscribe via control socket ───────────────────────────────────────

info "Sending hot-unsubscribe command..."
echo "{\"action\":\"unsubscribe\",\"subject\":\"$HOT_SUBJECT\"}" | nc -U -q 1 "$SOCK"
sleep 0.3

if ! grep -q "unsubscribed from $HOT_SUBJECT" "$STDERR_LOG"; then
  fail "Hot-unsubscribe not reflected in stderr"
fi
pass "Hot-unsubscribe honored"

# ── Verify post-unsubscribe messages are NOT received ────────────────────────

info "Publishing post-unsubscribe message (should NOT be received)..."
nats --server=nats://localhost:4222 pub "$HOT_SUBJECT" "should-not-be-received" > /dev/null
sleep 0.5

# Count lines matching the sentinel — must be zero
if grep -q "should-not-be-received" "$STDERR_LOG"; then
  fail "Server received a message after unsubscribe. Log: $(cat "$STDERR_LOG")"
fi
pass "Post-unsubscribe messages correctly NOT received"

# ── Bad JSON is tolerated ────────────────────────────────────────────────────

info "Sending malformed JSON (server should log and keep running)..."
echo "not-json-at-all" | nc -U -q 1 "$SOCK"
sleep 0.3

if ! grep -q "ctrl bad JSON" "$STDERR_LOG"; then
  fail "Server did not log bad-JSON warning"
fi

# Verify server is still alive by sending another subscribe
echo "{\"action\":\"subscribe\",\"subject\":\"$HOT_SUBJECT.2\"}" | nc -U -q 1 "$SOCK"
sleep 0.3
if ! grep -q "subscribed to $HOT_SUBJECT.2" "$STDERR_LOG"; then
  fail "Server died after bad-JSON input"
fi
pass "Server tolerates malformed JSON and stays up"

# ── Graceful shutdown unlinks the socket ─────────────────────────────────────

info "Sending SIGTERM..."
kill -TERM "$SERVER_PID"
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

if [ -e "$SOCK" ]; then
  fail "Socket file still exists after shutdown: $SOCK"
fi
pass "Socket file unlinked on shutdown"

if ! grep -q "shutting down" "$STDERR_LOG"; then
  fail "Server did not log 'shutting down'"
fi
pass "Server logged graceful shutdown"

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════"
echo -e "  ${GREEN}ALL ASSERTIONS PASSED${NC}"
echo "══════════════════════════════════════════"
echo ""
