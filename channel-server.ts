#!/usr/bin/env bun
/**
 * NATS Channel Server — MCP bridge that subscribes to NATS subjects and
 * delivers messages into a Claude Code session as <channel> tags.
 *
 * Usage:
 *   bun channel-server.ts --name a1 --subscribe agents.a1 [--nats nats://localhost:4222]
 *
 * Optional --control-socket <path> enables a Unix-domain socket accepting
 * newline-delimited JSON {action, subject} commands for hot-managing
 * subscriptions at runtime.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { connect, StringCodec, type NatsConnection } from 'nats'

// ── CLI args ──────────────────────────────────────────────────────────────────

import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'

const args = process.argv.slice(2)

function arg(flag: string, fallback?: string): string {
  const i = args.indexOf(flag)
  if (i !== -1 && args[i + 1]) return args[i + 1]!
  if (fallback !== undefined) return fallback
  console.error(`Missing required argument: ${flag}`)
  process.exit(1)
}

function argOptional(flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i !== -1 && args[i + 1]) return args[i + 1]!
  return undefined
}

const agentName = arg('--name')
const natsUrl   = arg('--nats', 'nats://localhost:4222')

// Collect all --subscribe values (repeatable)
const initialSubjects: string[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--subscribe' && args[i + 1]) {
    initialSubjects.push(args[i + 1]!)
  }
}

// --topics-file: one subject per line, # = comment, blank lines ignored
const topicsFile = argOptional('--topics-file')
if (topicsFile) {
  try {
    const lines = readFileSync(topicsFile, 'utf-8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) initialSubjects.push(trimmed)
    }
    console.error(`[${agentName}] loaded topics from ${topicsFile}: ${initialSubjects.join(', ')}`)
  } catch (e) {
    console.error(`[${agentName}] error reading --topics-file: ${e}`)
    process.exit(1)
  }
}

if (initialSubjects.length === 0) {
  console.error(`[${agentName}] error: at least one --subscribe subject or --topics-file is required`)
  process.exit(1)
}

// Instructions: --instructions-file takes precedence over --instructions.
// If neither is given, a minimal default is used (customize this).
const instructionsFile = argOptional('--instructions-file')
const defaultInstructions =
  `You are agent ${agentName}. ` +
  `Messages arrive as <channel source="nats" subject="..."> tags. ` +
  `Read each message and act on it. ` +
  `To send a message to another agent or signal completion, ` +
  `use the "reply" tool: reply(to="<nats-subject>", text="<message>").`

let instructions: string
if (instructionsFile) {
  try {
    instructions = readFileSync(instructionsFile, 'utf-8').trim()
    console.error(`[${agentName}] loaded instructions from ${instructionsFile}`)
  } catch (e) {
    console.error(`[${agentName}] error reading --instructions-file: ${e}`)
    process.exit(1)
  }
} else {
  instructions = arg('--instructions', defaultInstructions)
}

// ── NATS connection (with auto-reconnect) ────────────────────────────────────

async function connectNats(): Promise<NatsConnection> {
  for (let attempt = 1; ; attempt++) {
    try {
      const conn = await connect({
        servers: natsUrl,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000,
      })
      console.error(`[${agentName}] connected to ${natsUrl}`)
      ;(async () => {
        for await (const s of conn.status()) {
          if (s.type === 'reconnect') console.error(`[${agentName}] reconnected to NATS`)
          else if (s.type === 'disconnect') console.error(`[${agentName}] disconnected from NATS, will reconnect`)
          else if (s.type === 'reconnecting') console.error(`[${agentName}] reconnecting to NATS...`)
        }
      })()
      conn.closed().then(async (err) => {
        console.error(`[${agentName}] NATS connection closed${err ? `: ${err}` : ''}, performing full reconnect`)
        activeSubs.clear()
        try {
          nc = await connectNats()
          for (const subject of trackedSubjects) await subscribe(subject)
        } catch (e) {
          console.error(`[${agentName}] full reconnect failed: ${e}`)
        }
      })
      return conn
    } catch (err) {
      if (attempt >= 30) throw err
      console.error(`[${agentName}] NATS connect attempt ${attempt} failed, retrying in 2s...`)
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

let nc = await connectNats()
const sc = StringCodec()

const trackedSubjects = new Set<string>(initialSubjects)
const activeSubs = new Map<string, ReturnType<typeof nc.subscribe>>()

// ── MCP server ────────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: `nats-channel-${agentName}`, version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions,
  }
)

// Reply tool — Claude calls this to publish back to NATS
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Publish a message to a NATS subject',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to:   { type: 'string', description: 'NATS subject to publish to' },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'reply') throw new Error(`unknown tool: ${req.params.name}`)
  const { to, text } = req.params.arguments as { to: string; text: string }
  nc.publish(to, sc.encode(text))
  console.error(`[${agentName}] published to ${to}: ${text.slice(0, 80)}`)
  return { content: [{ type: 'text' as const, text: `published to ${to}` }] }
})

// ── Subscribe to a NATS subject and bridge to Claude ─────────────────────────

async function subscribe(subject: string): Promise<void> {
  trackedSubjects.add(subject)
  if (activeSubs.has(subject)) return  // already subscribed
  const sub = nc.subscribe(subject)
  activeSubs.set(subject, sub)
  console.error(`[${agentName}] subscribed to ${subject}`)

  ;(async () => {
    for await (const msg of sub) {
      const content = sc.decode(msg.data)
      console.error(`[${agentName}] received on ${msg.subject}: ${content.slice(0, 80)}`)
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: {
            subject:  msg.subject,
            from:     msg.reply ?? '',
          },
        },
      })
    }
  })()
}

async function unsubscribe(subject: string): Promise<void> {
  trackedSubjects.delete(subject)
  const sub = activeSubs.get(subject)
  if (!sub) return
  sub.unsubscribe()
  activeSubs.delete(subject)
  console.error(`[${agentName}] unsubscribed from ${subject}`)
}

// ── Connect to Claude Code over stdio (must happen before subscribing) ────────

await mcp.connect(new StdioServerTransport())

// Start with all initial subscriptions
for (const subject of initialSubjects) {
  await subscribe(subject)
}

// ── Optional Unix socket control channel ─────────────────────────────────────
// Opt-in via --control-socket <path>. When set, the server listens on a Unix
// domain socket and accepts newline-delimited JSON commands for hot-managing
// subscriptions at runtime:
//
//   {"action": "subscribe",   "subject": "agents.aria"}
//   {"action": "unsubscribe", "subject": "agents.aria"}
//
// This is useful for orchestrators (e.g. session managers, dashboards) that
// need to attach new channels to a long-running agent without restarting it.

const controlSocketPath = argOptional('--control-socket')
let ctrlServer: ReturnType<typeof createNetServer> | undefined

if (controlSocketPath) {
  if (existsSync(controlSocketPath)) {
    try { unlinkSync(controlSocketPath) } catch {}
  }

  ctrlServer = createNetServer((client) => {
    let buf = ''
    client.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8')
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
        if (!line) continue
        try {
          const cmd = JSON.parse(line) as { action?: string; subject?: string }
          if (cmd.action === 'subscribe' && typeof cmd.subject === 'string') {
            subscribe(cmd.subject).catch(err =>
              console.error(`[${agentName}] ctrl subscribe failed: ${err}`))
          } else if (cmd.action === 'unsubscribe' && typeof cmd.subject === 'string') {
            unsubscribe(cmd.subject).catch(err =>
              console.error(`[${agentName}] ctrl unsubscribe failed: ${err}`))
          } else {
            console.error(`[${agentName}] ctrl unknown command: ${line}`)
          }
        } catch (err) {
          console.error(`[${agentName}] ctrl bad JSON: ${line} (${(err as Error).message})`)
        }
      }
    })
    client.on('error', (err: Error) =>
      console.error(`[${agentName}] ctrl client error: ${err.message}`))
  })

  ctrlServer.on('error', (err: Error) =>
    console.error(`[${agentName}] ctrl server error: ${err.message}`))

  ctrlServer.listen(controlSocketPath, () => {
    console.error(`[${agentName}] ctrl socket listening at ${controlSocketPath}`)
  })
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
  console.error(`[${agentName}] shutting down`)
  if (ctrlServer) {
    ctrlServer.close()
    if (controlSocketPath) {
      try { unlinkSync(controlSocketPath) } catch {}
    }
  }
  for (const sub of activeSubs.values()) sub.unsubscribe()
  await nc.drain()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)
