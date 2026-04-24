#!/usr/bin/env bash
# E2E Test: --jetstream
#
# Verifies the JetStream-backed delivery path end-to-end:
#   - server boots with --jetstream and creates the channel-mcp stream
#   - durable consumer is created per --subscribe arg
#   - messages published while the server is paused get buffered and
#     delivered on resume (the original "fix the breakout-resume bug" goal)
#   - delete-durable control-socket action removes the durable
#
# Requires: bun, nc, nats CLI, AND nats-server with --jetstream (-js) enabled.
#
# Usage: ./test/e2e/jetstream.sh
# Exit:  0 = PASS, 1 = FAIL

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_NAME="js-e2e-$$"
SUBJECT="js-e2e-$$.msgs"
SOCK="/tmp/nats-channel-js-e2e-$$.sock"
STDERR_LOG="/tmp/nats-channel-js-e2e-$$.stderr.log"
TIMEOUT_SECONDS=10
STREAM_NAME="channel-mcp"
DURABLE_NAME="${AGENT_NAME}__js-e2e-$$_msgs"

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
    kill -CONT "$SERVER_PID" 2>/dev/null || true
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  # Best-effort cleanup of the durable + the test's stream subjects.
  # Leave the stream itself alone so other tests / dev work isn't disrupted.
  nats consumer rm "$STREAM_NAME" "$DURABLE_NAME" --force 2>/dev/null || true
  rm -f "$SOCK" "$STDERR_LOG"
}

trap teardown EXIT

echo ""
echo "══════════════════════════════════════════"
echo "  E2E Test: --jetstream"
echo "══════════════════════════════════════════"
echo ""

# ── Prerequisites ─────────────────────────────────────────────────────────────

if ! pgrep -x nats-server > /dev/null; then
  echo ""
  echo -e "${RED}✗ FAIL${NC}: NATS server is not running."
  echo "  Start it with JetStream enabled:  nats-server -js"
  echo ""
  exit 1
fi
pass "NATS server is running"

if ! nats account info 2>&1 | grep -qi "jetstream.*enabled"; then
  fail "NATS server is running without JetStream. Restart with: nats-server -js"
fi
pass "JetStream is enabled on the server"

for cmd in bun nc nats; do
  if ! command -v "$cmd" > /dev/null; then
    fail "Required command not found: $cmd"
  fi
done
pass "bun, nc, nats CLI all available"

# ── Launch channel-server with --jetstream ───────────────────────────────────

info "Starting channel-server with --jetstream..."
bun run "$ROOT/channel-server.ts" \
    --name "$AGENT_NAME" \
    --subscribe "$SUBJECT" \
    --nats nats://localhost:4222 \
    --control-socket "$SOCK" \
    --jetstream \
    < /dev/null > /dev/null 2> "$STDERR_LOG" &
SERVER_PID=$!

elapsed=0
while ! grep -q "JetStream mode enabled" "$STDERR_LOG" 2>/dev/null; do
  sleep 0.2
  elapsed=$((elapsed + 1))
  if [ "$elapsed" -ge "$((TIMEOUT_SECONDS * 5))" ]; then
    fail "Server never logged 'JetStream mode enabled'. stderr: $(cat "$STDERR_LOG")"
  fi
done
pass "Server bootstrapped JetStream"

if ! grep -q "JS-subscribed to $SUBJECT" "$STDERR_LOG"; then
  fail "Initial JS subscribe not in stderr"
fi
pass "Durable consumer created for initial --subscribe"

# Verify the durable exists in JetStream
if ! nats consumer ls "$STREAM_NAME" 2>/dev/null | grep -q "$DURABLE_NAME"; then
  fail "Expected durable $DURABLE_NAME not found in $STREAM_NAME"
fi
pass "Durable $DURABLE_NAME visible in stream"

# ── Live delivery roundtrip ───────────────────────────────────────────────────

info "Publishing a live message..."
nats --server=nats://localhost:4222 pub "$SUBJECT" "live-msg" > /dev/null
sleep 0.5

if ! grep -q "received on $SUBJECT: live-msg" "$STDERR_LOG"; then
  fail "Live message did not reach the server. Log: $(cat "$STDERR_LOG")"
fi
pass "Live message delivered"

# ── Buffered delivery: pause, publish, resume ─────────────────────────────────

info "Pausing the server (SIGSTOP) and publishing 3 messages while paused..."
kill -STOP "$SERVER_PID"

# Brief pause so the SIGSTOP takes effect before publishes.
sleep 0.2
nats --server=nats://localhost:4222 pub "$SUBJECT" "buffered-1" > /dev/null
nats --server=nats://localhost:4222 pub "$SUBJECT" "buffered-2" > /dev/null
nats --server=nats://localhost:4222 pub "$SUBJECT" "buffered-3" > /dev/null

# Resume.
info "Resuming the server (SIGCONT)..."
kill -CONT "$SERVER_PID"
sleep 1.5

for n in 1 2 3; do
  if ! grep -q "received on $SUBJECT: buffered-$n" "$STDERR_LOG"; then
    fail "Buffered message buffered-$n not redelivered after resume. Log: $(cat "$STDERR_LOG")"
  fi
done
pass "All 3 buffered messages redelivered after resume"

# ── delete-durable cleans up ──────────────────────────────────────────────────

info "Sending delete-durable via control socket..."
echo "{\"action\":\"delete-durable\",\"subject\":\"$SUBJECT\"}" | nc -U -q 1 "$SOCK"
sleep 0.5

if ! grep -q "deleted durable $DURABLE_NAME" "$STDERR_LOG"; then
  fail "delete-durable not honored. Log: $(cat "$STDERR_LOG")"
fi
pass "Server logged delete-durable"

if nats consumer ls "$STREAM_NAME" 2>/dev/null | grep -q "$DURABLE_NAME"; then
  fail "Durable still present after delete-durable"
fi
pass "Durable removed from JetStream"

# ── delete-durable refuses cross-server names ─────────────────────────────────
# Ensure the scope guard works: try to delete a durable whose name doesn't
# match this server's prefix. We do this by sending a subject that would
# resolve to a foreign-prefixed durable. We simulate by deleting a subject
# whose durable name was never created by this server.

info "Sending delete-durable for an unknown subject (must be no-op)..."
echo "{\"action\":\"delete-durable\",\"subject\":\"never-subscribed-$$\"}" | nc -U -q 1 "$SOCK"
sleep 0.3

if ! grep -q "delete-durable refused" "$STDERR_LOG"; then
  fail "Server didn't refuse delete-durable on unknown subject. Log: $(cat "$STDERR_LOG")"
fi
pass "Scope guard refused unknown delete-durable"

# ── Graceful shutdown ─────────────────────────────────────────────────────────

info "Sending SIGTERM..."
kill -TERM "$SERVER_PID"
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

if [ -e "$SOCK" ]; then
  fail "Socket file still exists after shutdown: $SOCK"
fi
pass "Socket file unlinked on shutdown"

echo ""
echo -e "${GREEN}════════════ ALL JETSTREAM TESTS PASSED ════════════${NC}"
echo ""
