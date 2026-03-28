# E2E Tests

End-to-end tests for nats-channel-mcp. Each test spins up real NATS and real
Claude Code sessions, runs the full chain, and asserts on the output.

## Prerequisites

All of the main prerequisites apply (NATS server, Bun, Claude Code ≥ v2.1.80,
nats CLI). **NATS server must be running before you start the tests** — the test will fail with a clear message if it's not. Start it with `nats-server`.

## Running

```bash
# From the repo root:
bun test:e2e

# Or directly:
./test/e2e/intro-chain.sh
```

Exit code 0 = pass, 1 = fail.

## Tests

### `intro-chain.sh`

Runs the full two-agent introduction chain:

```
trigger → A1 (Montgomery Wafflesworth-Pudding) → A2 (Countess Beets McGillicuddy) → done
```

**Asserts:**
- A2's done message contains "Countess Beets McGillicuddy"
- A1's terminal output contains "Montgomery Wafflesworth-Pudding"

**What it does automatically:**
- Checks NATS is running (fails clearly if not)
- Generates `.mcp.json` files with correct absolute paths
- Launches both Claude sessions in tmux
- Auto-confirms the dev channels prompt
- Subscribes to the done subject before dispatching
- Times out with a clear error if any step hangs
- Tears down cleanly on pass or fail

## Notes

- Tests use `--dangerously-skip-permissions` to suppress tool approval prompts.
  This is safe for local testing but should not be used in production.
- Each test run uses a fresh set of tmux sessions (`e2e-a1`, `e2e-a2`).
  Kill them manually with `tmux kill-session -t e2e-a1` if needed.
- Token cost: each test run consumes Claude Max tokens for both agents.
