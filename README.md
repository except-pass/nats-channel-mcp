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

★ At least one of `--subscribe` or `--topics-file` is required.  
☆ At least one of `--instructions-file` or `--instructions` is strongly recommended.

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
| **Fire-and-forget delivery** | No subscriber = lost message. Start subscribers before dispatching, or use [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) for durable delivery. |
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
- [ ] NATS JetStream support for durable delivery
- [ ] NATS authentication via credentials file (`--nats-creds`)
