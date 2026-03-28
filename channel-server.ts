#!/usr/bin/env bun
/**
 * NATS Channel Server — MCP bridge that subscribes to NATS subjects and
 * delivers messages into a Claude Code session as <channel> tags.
 *
 * Usage:
 *   bun channel-server.ts --name a1 --subscribe agents.a1 [--nats nats://localhost:4222]
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { connect, StringCodec } from 'nats'

// ── CLI args ──────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'

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

// ── NATS connection ───────────────────────────────────────────────────────────

const nc = await connect({ servers: natsUrl })
const sc = StringCodec()

// Track active subscriptions so we can hot-manage them later
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

// ── Connect to Claude Code over stdio (must happen before subscribing) ────────

await mcp.connect(new StdioServerTransport())

// Start with all initial subscriptions
for (const subject of initialSubjects) {
  await subscribe(subject)
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
  console.error(`[${agentName}] shutting down`)
  for (const sub of activeSubs.values()) sub.unsubscribe()
  await nc.drain()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)
