#!/usr/bin/env bash
# Intro Chain example — two agents introduce themselves in sequence.
#
# Agent A1: Montgomery Wafflesworth-Pudding
# Agent A2: Countess Beets McGillicuddy
#
# Chain: you → A1 → A2 → done.chain-001
#
# Usage: ./run.sh

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ── Configuration ──────────────────────────────────────────────────────────────
# CHANNEL_KEY is the MCP server key name in .mcp.json.
# It MUST match the value passed to --dangerously-load-development-channels server:<key>.
# Change it here — it flows into both places automatically.
CHANNEL_KEY="nats"

echo "=== Intro Chain Example ==="
echo ""

# ── Prerequisites ──────────────────────────────────────────────────────────────

if ! pgrep -x nats-server > /dev/null; then
  echo "→ Starting NATS server..."
  nats-server -p 4222 &
  sleep 1
fi
echo "✓ NATS running"

# ── Generate .mcp.json files with correct absolute paths ──────────────────────

for agent in a1 a2; do
  AGENT_DIR="$ROOT/examples/intro-chain/agents/$agent"
  if [ "$agent" = "a1" ]; then
    NAME="a1"
  else
    NAME="a2"
  fi

  cat > "$AGENT_DIR/.mcp.json" <<EOF
{
  "mcpServers": {
    "$CHANNEL_KEY": {
      "command": "bun",
      "args": [
        "$ROOT/channel-server.ts",
        "--name", "$NAME",
        "--topics-file", "$AGENT_DIR/topics.txt",
        "--nats", "nats://localhost:4222",
        "--instructions-file", "$AGENT_DIR/AGENT.md"
      ]
    }
  }
}
EOF
done
echo "✓ .mcp.json files generated"

# ── Launch agents ──────────────────────────────────────────────────────────────

tmux kill-session -t chain-a1 2>/dev/null || true
tmux kill-session -t chain-a2 2>/dev/null || true

echo "→ Launching A1 (Montgomery Wafflesworth-Pudding)..."
tmux new-session -d -s chain-a1 -x 200 -y 50 \
  "cd $ROOT/examples/intro-chain/agents/a1 && claude --mcp-config .mcp.json --dangerously-load-development-channels server:${CHANNEL_KEY}"

echo "→ Launching A2 (Countess Beets McGillicuddy)..."
tmux new-session -d -s chain-a2 -x 200 -y 50 \
  "cd $ROOT/examples/intro-chain/agents/a2 && claude --mcp-config .mcp.json --dangerously-load-development-channels server:${CHANNEL_KEY}"

echo ""
echo "⚠  Both agents will prompt for dev channel confirmation."
echo "   In two other terminals, run:"
echo "     tmux attach -t chain-a1   (press 1 + Enter to confirm)"
echo "     tmux attach -t chain-a2   (press 1 + Enter to confirm)"
echo ""
echo "   Once both show 'Listening for channel messages', run:"
echo "     nats sub done.chain-001 &"
echo "     nats pub agents.a1 'Please introduce yourself.'"
echo ""
echo "   Expected completion message on done.chain-001:"
echo "     Greetings! I am Countess Beets McGillicuddy, at your service."
