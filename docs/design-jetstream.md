# Design: JetStream-backed retention + replay tool

**Lifecycle:** delete this doc once implemented; fold the user-facing parts into `README.md`.

## Problem

`channel-server.ts` uses core NATS pub/sub. Messages published while the subscriber is down are lost. Stop a parent session, child publishes, resume the parent → message is gone.

## What this design does

1. Add `--jetstream` flag to channel-server. When set, replace `nc.subscribe()` with a JetStream durable push consumer per `--subscribe` arg. Stream auto-created on startup with hardcoded defaults (3h retention, file storage). On reconnect/resume, durables resume from their last-acked sequence — buffered messages get delivered automatically.
2. Add a `replay` MCP tool that pulls historical messages from the stream as MCP tool output (won't double-fire into the live inbox).
3. Add a `delete-durable` action to the control socket. Tinstar's session-delete path calls it for every subject the deleted session was subscribed to.

## Limitations

- **Pauses longer than 1h lose messages.** That's `InactiveThreshold`; after it, JetStream deletes the durable and the next bind starts at "now."
- **At-least-once.** No dedup; producers needing exactly-once include their own key in the payload.

## Design

### Stream

```
Name:        channel-mcp
Subjects:    union of all --subscribe args this server has seen
Retention:   Limits / Discard=Old / MaxAge=3h / File / Replicas=1
```

Created via `jsm.streams.add()` if absent; otherwise `jsm.streams.update()` with the union of existing subjects + this server's `--subscribe` args. Subject set only grows. Retention and storage are never modified after creation — change them with `nats stream edit channel-mcp` out of band.

### Live consumers

For each `--subscribe SUBJ`, bind a durable push consumer:

```
DurableName:        ${agentName}__${slug(SUBJ)}
FilterSubject:      <SUBJ>            (wildcards OK)
DeliverPolicy:      New               (only matters at first creation)
AckPolicy:          Explicit
AckWait:            30s
MaxDeliver:         3
InactiveThreshold:  1h
ReplayPolicy:       Instant
```

Push handler is the same as today (channel-server.ts:184-212): decode, suppress self-echo via `x-from`, emit `notifications/claude/channel`, `msg.ack()`.

`DeliverPolicy` is frozen at consumer-create time; rebinds resume from last-acked. `New` at first-bind keeps a freshly-spawned hand's inbox empty, matching today's AX.

`msg.ack()` resolves on `process.stdout.write()` accepting the buffer — the OS pipe, not "Claude consumed it." Honest at-least-once between broker and channel-server only.

### `replay` MCP tool

```ts
{
  name: 'replay',
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      since:   { type: 'string', description: 'Duration ("1h") or ISO. Default "1h".' },
      limit:   { type: 'integer', description: 'Default 50, max 500.' },
    },
    required: ['subject'],
  },
}
```

Implementation: ephemeral pull consumer with `FilterSubject=subject`, `DeliverPolicy=ByStartTime` (`OptStartTime = now - since`), `AckPolicy=None`, `InactiveThreshold=1m`. Fetch `limit` messages with a 2s timeout. Return as MCP tool result `content`: a JSON array of `{ subject, from, ts, seq, text }` (`seq` lets a consumer dedupe across replay/live overlap). Delete the consumer in `finally`. Wildcards OK — `FilterSubject` accepts them.

### Control socket: `delete-durable`

```json
{"action":"delete-durable","subject":"rooms.x"}
```

channel-server keeps an in-memory `Set` of durable names it created. On `delete-durable`, resolve subject to `${agentName}__${slug(subject)}`, check membership, call `jsm.consumers.delete()`, remove from set. No-op if missing or not ours. Restart loses the set; `InactiveThreshold` reaps anything we forget.

### Tinstar integration

1. **`src/server/sessions/backends/tmux.ts:158` `generateNatsMcpConfig`** — append `--jetstream` when a new `config.nats.jetstream` field is true. Defaults false.
2. **`src/server/api/routes.ts:2408` session-delete handler** — before async backend stop, iterate `session.nats.subscriptions` ∪ `run.breakoutRooms` and fire `delete-durable` per entry via the existing `trySendNatsSocketCommand`. Add `'delete-durable'` to the action union at routes.ts:113 and routes.ts:222. Subscriptions list is accurate at delete time thanks to commit 5125825.

### CLI

```
--jetstream     Off by default. Enables everything above.
```

No other flags. Constants live in code.

## Tests

`test/e2e/jetstream.sh` matching `test/e2e/control-socket.sh`'s shell pattern: boot `nats-server -js`, boot channel-server with `--jetstream --subscribe jstest.$$`, `kill -STOP` it, `nats pub` 3 messages, `kill -CONT`, grep stderr for all 3, send `delete-durable`, assert via `nats consumer ls channel-mcp`. Replay tool needs MCP-stdio test infra that doesn't exist today — verify manually first, add a Bun harness later if needed.

## README

Flip README.md:318 ("fire-and-forget") to a "JetStream mode" section, tick roadmap line 380, resolve tinstar/docs/nats-agent-channels.md:412.
