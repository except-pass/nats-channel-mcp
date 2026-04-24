# nats-channel-mcp

An MCP channel server that bridges [NATS](https://nats.io) pub/sub into [Claude Code](https://claude.ai/code) sessions.

Publish a message to a NATS subject → it arrives in Claude as a `<channel>` tag → Claude acts on it and can publish back to any subject using the built-in `reply` tool.

This is the primitive for wiring Claude agents together via NATS.

```
you → nats pub → NATS → channel-server (MCP subprocess) → <channel> tag → Claude acts
                                                                               ↓
you ← nats sub ← NATS ← channel-server ← reply(to, text) tool call ←─────────┘
```

---

## Prerequisites

Install these before anything else:

| Tool | Version | Install |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.0 | `curl -fsSL https://bun.sh/install \| bash` |
| [NATS server](https://nats.io/download/) | any | [download binary](https://nats.io/download/) |
| [Claude Code](https://claude.ai/code) | ≥ 2.1.80 | `npm install -g @anthropic-ai/claude-code` |
| [nats CLI](https://github.com/nats-io/natscli) (optional) | any | for testing/publishing |

Claude Code must be authenticated with a claude.ai account (`claude auth login`). This uses OAuth — **not** an API key.

---

## Install

```bash
git clone <this-repo>
cd nats-channel-mcp
bun install
```

---

## The Most Important Part: Instructions

**The `--instructions` string is your agent's standing orders.** It is injected directly into Claude's system prompt. It tells Claude:

- Who it is (its name, role)
- What the incoming `<channel>` messages mean
- What to do with them
- Where to send results (which NATS subject to publish to when done)

**Get this right and everything else is plumbing.**

### Option A: Instructions file (recommended)

Create a markdown file with the agent's instructions:

```markdown
# AGENT.md
You are **Aria**, a code reviewer specializing in TypeScript.

When you receive a <channel> message:
1. Read the code or diff provided
2. Write a concise review (3-5 bullet points max)
3. Use the reply tool to publish your review to `reviews.done`

Be direct. No preamble.
```

Pass it with `--instructions-file`:
```json
"args": ["--instructions-file", "./AGENT.md", "--name", "aria", "--subscribe", "agents.aria"]
```

### Option B: Inline instructions

For simple agents, inline in `.mcp.json`:
```json
"args": ["--instructions", "You are aria. Review code in <channel> messages and reply to reviews.done.", "--name", "aria", "--subscribe", "agents.aria"]
```

⚠️ Long inline instructions in JSON are hard to read and edit. Use `--instructions-file` for anything real.

---

## Quick Start

**1. Start NATS:**
```bash
nats-server
```

**2. Create your agent directory:**
```
my-agent/
  AGENT.md       ← your instructions (the important part)
  .mcp.json      ← MCP server config
```

**3. Write your instructions** (`AGENT.md`):
```markdown
You are my-agent. When you receive a <channel> message, respond to it
and use the reply tool to publish your response to `agents.done`.
```

**4. Configure the MCP server** (`.mcp.json`):
```json
{
  "mcpServers": {
    "nats": {
      "command": "bun",
      "args": [
        "/absolute/path/to/claude-nats-channel/channel-server.ts",
        "--name", "my-agent",
        "--subscribe", "agents.my-agent",
        "--instructions-file", "./AGENT.md"
      ]
    }
  }
}
```

> **Note:** The path to `channel-server.ts` must be absolute.

**5. Start Claude with channel support:**
```bash
cd my-agent
claude --mcp-config .mcp.json --dangerously-load-development-channels server:nats
```

You'll see a one-time confirmation prompt — choose option 1 to proceed. After that:
```
Listening for channel messages from: server:nats
```

**6. Send a message:**
```bash
nats pub agents.my-agent "Please respond."
```

Claude receives it, acts on it, and can reply via the `reply` tool.

---

## CLI Reference

```
bun channel-server.ts [options]
```

| Flag | Required | Description |
|---|---|---|
| `--name <name>` | ✅ | Agent name. Used in channel source attribute and default instructions. |
| `--subscribe <subject>` | ★ | NATS subject to subscribe to. Repeatable: `--subscribe a --subscribe b`. |
| `--topics-file <path>` | ★ | Path to a topics file (one subject per line, `#` = comment). **Use this for anything beyond one subject.** |
| `--instructions-file <path>` | ☆ | Path to a markdown file whose contents become the MCP instructions (system prompt). Recommended. |
| `--instructions <string>` | ☆ | Inline instructions string. Falls back to a minimal default if neither is given. |
| `--nats <url>` | — | NATS server URL. Default: `nats://localhost:4222` |
| `--control-socket <path>` | — | Enable the Unix-socket control channel for hot subscription management. See [Control Socket](#control-socket) below. |
| `--allow-self-echo` | — | Disable self-echo suppression. By default the server stamps an `x-from: <name>` header on every publish and drops any inbound message whose `x-from` matches its own name, so agents never see their own messages bounce back on shared subjects. |
| `--jetstream` | — | Enable JetStream-backed durable delivery and the `replay` MCP tool. See [JetStream Mode](#jetstream-mode) below. Requires `nats-server -js`. |

★ At least one of `--subscribe` or `--topics-file` is required.  
☆ At least one of `--instructions-file` or `--instructions` is strongly recommended.

---

## Control Socket

Long-running agents often need to join and leave channels without restarting. Pass `--control-socket <path>` and the server will listen on a Unix-domain socket that accepts newline-delimited JSON commands:

```json
{"action": "subscribe",      "subject": "rooms.breakout-42"}
{"action": "unsubscribe",    "subject": "rooms.breakout-42"}
{"action": "delete-durable", "subject": "rooms.breakout-42"}
```

`delete-durable` is only meaningful when `--jetstream` is on. It unsubscribes and removes the durable consumer for the subject, scoped to durables this server created.

This is intended for orchestrators (session managers, dashboards) that coordinate a fleet of agents and need to attach or detach channels at runtime. The socket is created on startup and unlinked on SIGTERM / SIGINT. Any existing file at the path is unlinked first.

**Example:**

```bash
# Start an agent with a control socket
bun channel-server.ts \
    --name aria \
    --subscribe agents.aria \
    --control-socket /tmp/nats-ctrl-aria.sock

# From another process, hot-subscribe
echo '{"action":"subscribe","subject":"rooms.breakout-42"}' \
    | nc -U -q 1 /tmp/nats-ctrl-aria.sock
```

The flag is purely opt-in: if you don't pass `--control-socket`, no socket is created and behavior is unchanged from prior versions. Errors in the control channel never affect NATS or MCP message flow — malformed JSON, unknown actions, and client disconnects are logged to stderr and the server keeps running.

**Security:** the socket is created with the filesystem permissions of the user running the server. Use a directory only that user can reach (e.g. `$XDG_RUNTIME_DIR`) if you need stronger isolation. The protocol has no authentication — anyone who can `connect()` to the path can mutate the subscription list.

---

## JetStream Mode

Pass `--jetstream` and the server uses [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) for durable delivery instead of core pub/sub. This fixes the main fragility of the default mode: messages published while the subscriber is down are buffered and delivered on reconnect.

**Requires** `nats-server` to be running with JetStream enabled (`nats-server -js`).

**What changes:**

- **Durable per subscription.** Each `--subscribe SUBJ` creates a durable consumer named `${name}__${slug(SUBJ)}`. On reconnect (network blip, process restart, session resume) the consumer resumes from its last-acked sequence — messages buffered while the channel-server was offline get delivered automatically.
- **Auto-managed stream.** The server creates a stream called `channel-mcp` on startup if it doesn't exist, with 3h retention and file storage. Subjects are the union of every `--subscribe` arg any channel-server in the fleet has seen; the subject set only grows. To change retention, use `nats stream edit channel-mcp` out of band.
- **`replay` MCP tool.** A second tool appears on the MCP surface. Claude can call `replay(subject, since?, limit?)` to fetch historical messages. Results land as tool output, not as a channel injection, so they don't double-fire into the live inbox. The response is a JSON array of `{subject, from, ts, seq, text}` per message. `seq` is the NATS stream sequence — useful if an agent wants to dedupe across replay/live overlap.
- **`delete-durable` socket action.** Orchestrators that manage a fleet of agents can remove a subject's durable immediately via the control socket (see above). Scoped to durables this server created.

**Limitations:**

- **Pauses longer than 1h lose messages.** The per-consumer `InactiveThreshold` is 1h (hardcoded). If a subscriber is gone for longer, JetStream deletes the durable; the next bind starts at "now" and messages published during the gap are skipped. Raise the constant in `channel-server.ts` if you need to survive longer pauses.
- **At-least-once.** A duplicate delivery is possible after a crash/ack-timeout. If a message triggers a non-idempotent side-effect, the producer should include its own dedup key in the payload; this server is content-blind.
- **`msg.ack()` is OS-pipe-level.** channel-server acks once `process.stdout.write()` accepts the buffer for the MCP notification. If Claude Code crashes between pipe receive and consumption, the ack has already fired and the message is lost to that session. This is an MCP-protocol limitation, not a JetStream one.

**Example:**

```bash
# Start NATS with JetStream
nats-server -js

# Start the channel-server in JetStream mode
bun channel-server.ts \
    --name aria \
    --subscribe agents.aria \
    --jetstream
```

---

## The `reply` Tool

Claude uses this to publish back to NATS:

```
reply(to: "<nats-subject>", text: "<message>")
```

Your instructions should tell Claude exactly which subject to publish to and when. Example:

> "When you finish your analysis, use reply(to='pipeline.done', text='<your summary>')."

On first use, Claude will ask for permission. Choose "Yes, and don't ask again" to suppress future prompts for that session.

---

## How Messages Appear in Claude

```xml
<channel source="nats" subject="agents.my-agent">
  the message content here
</channel>
```

The `subject` attribute shows which subscription delivered the message — useful when an agent subscribes to multiple subjects.

---

## Topics / Subscriptions

The second thing worth getting right (after instructions) is which subjects your agent subscribes to.

### Option A: Single subject (simple)

```json
"args": ["--subscribe", "agents.my-agent", ...]
```

### Option B: Topics file (recommended for multi-level setups)

Create `topics.txt` alongside `AGENT.md`:

```
# topics.txt — one subject per line, # = comment, blank lines ignored

# Direct (messages specifically for this agent)
agents.my-agent

# Team channel (shared with other agents on the same task)
myapp.project-01.epic-xyz.task-abc.*

# Epic-level broadcast
myapp.project-01.epic-xyz.>

# Workspace-wide announcements
myapp.>

# Breakout rooms (add/remove as needed)
# myapp.breakout.sprint-planning
```

Pass it with `--topics-file`:
```json
"args": ["--topics-file", "./topics.txt", ...]
```

### Wildcard subjects

NATS wildcards work as you'd expect:

| Pattern | Matches |
|---|---|
| `agents.my-agent` | Exactly that subject |
| `agents.*` | Any single token after `agents.` |
| `agents.>` | Any subject starting with `agents.` (including nested) |

A message published to `agents.team` is received by any agent subscribed to `agents.team`, `agents.*`, or `agents.>`.

### The channel source attribute

When a message arrives via a wildcard subscription, the `<channel>` tag shows the **actual subject** it was published to:

```xml
<channel source="nats" subject="agents.team">
  broadcast to the whole team
</channel>
```

Your instructions can tell Claude to behave differently based on which subject a message came from.

---

## Multi-Agent Chains

Each agent subscribes to its own subject. You "introduce" agents by telling each one about the next step in their instructions:

**Agent 1 (`AGENT.md`):**
```markdown
You are step-1. When you receive a task in a <channel> message:
1. Process it
2. Use reply(to="agents.step-2", text="<your output>") to pass it forward
```

**Agent 2 (`AGENT.md`):**
```markdown
You are step-2. When you receive input in a <channel> message:
1. Build on it
2. Use reply(to="pipeline.done", text="<final output>") when complete
```

**Start both agents before dispatching.** Messages published before an agent is subscribed are lost (fire-and-forget). For durability, use NATS JetStream.

See [`examples/intro-chain/`](./examples/intro-chain/) for a working end-to-end example.

---

## Known Limitations & Gotchas

| Issue | Details |
|---|---|
| **Tool approval prompts** | Claude asks permission before calling `reply`. Choose "don't ask again" to suppress. In sandboxed environments use `--dangerously-skip-permissions`. |
| **Fire-and-forget by default** | Without `--jetstream`, no subscriber = lost message. Start subscribers before dispatching, or pass `--jetstream` for durable delivery (see below). |
| **One-time startup confirmation** | `--dangerously-load-development-channels` prompts once per session. Automate: `echo 1 \| claude ...` |
| **Research preview** | Requires Claude Code ≥ v2.1.80. The `--dangerously-load-development-channels` flag is for local development. Approved channels use `--channels plugin:name@marketplace`. |
| **Absolute path in `.mcp.json`** | The path to `channel-server.ts` must be absolute — relative paths don't resolve correctly when Claude Code spawns the subprocess. |
| **NATS auth not implemented** | `--nats` only accepts a URL. For authenticated NATS servers, credentials file support (`--nats-creds`) is on the roadmap. For now: local NATS only. |

### The Key Name Coupling (important)

The MCP server key in `.mcp.json` and the `--dangerously-load-development-channels server:<key>` flag **must match exactly**. If they don't, Claude starts silently — no channel listener, no error.

```json
{ "mcpServers": { "nats": { ... } } }
//                  ^^^^
//              This must match ──────────────────────────────────────┐
```
```bash
claude --dangerously-load-development-channels server:nats
#                                                      ^^^^
```

**Convention:** always use `nats` as the key name. The examples follow this convention.

**If you need a different key name** (e.g. running multiple channel servers per session), use a `CHANNEL_KEY` variable in your launch script so both places stay in sync automatically — see `examples/intro-chain/run.sh` for the pattern.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   Claude Code session                     │
│                                                           │
│  System prompt includes: <instructions from AGENT.md>    │
│                                                           │
│  Receives:  <channel source="nats" subject="agents.x">   │
│               message content                             │
│             </channel>                                    │
│                                                           │
│  Sends:     reply(to="agents.y", text="response")  ──────┼──→ NATS
└──────────────────────────────────────────────────────────┘    ↑
        ↑  notifications/claude/channel (MCP)                   │
        │                                                        │
┌───────────────────────────────┐                               │
│       channel-server.ts       │  ←── NATS ────────────────────┘
│       (MCP subprocess)        │
│                               │
│  nc.subscribe(subject)        │
│  → mcp.notification()         │
│                               │
│  reply tool                   │
│  → nc.publish(to, text)       │
└───────────────────────────────┘
```

The channel server runs as a subprocess spawned by Claude Code (via `.mcp.json`). It owns the NATS connection. Claude Code never touches NATS directly.

---

## Roadmap

- [ ] `--subscribe` repeatable for multiple initial subjects
- [ ] Hot subscription management via Unix socket (add/remove without restart)
- [x] NATS JetStream support for durable delivery (`--jetstream`)
- [ ] NATS authentication via credentials file (`--nats-creds`)
