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
 * subscriptions at runtime. Actions: subscribe, unsubscribe, delete-durable.
 *
 * Optional --jetstream enables durable consumers (resume buffered messages
 * after reconnect within InactiveThreshold) and registers a `replay` MCP
 * tool for explicit history lookback. See README "JetStream Mode" section.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  connect, StringCodec, headers,
  AckPolicy, DeliverPolicy, RetentionPolicy, StorageType, DiscardPolicy, ReplayPolicy,
  type NatsConnection, type JetStreamClient, type JetStreamManager, type ConsumerInfo,
} from 'nats'

// ── CLI args ──────────────────────────────────────────────────────────────────

import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { randomBytes } from 'node:crypto'

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

// Self-echo suppression: by default, an agent will not receive messages it
// published itself (detected via the `x-from` header we stamp on every
// publish). Pass --allow-self-echo to disable and receive own messages.
const allowSelfEcho = args.includes('--allow-self-echo')

// JetStream mode: opt-in durable consumers + replay tool. Off by default
// preserves the original fire-and-forget core-NATS behavior unchanged.
const useJetStream = args.includes('--jetstream')

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
        for (const iter of activeJsConsumers.values()) {
          try { await iter.stop() } catch { /* iterator may be torn down */ }
        }
        activeJsConsumers.clear()
        js = null
        jsm = null
        try {
          nc = await connectNats()
          if (useJetStream) {
            jsm = await nc.jetstreamManager()
            js = nc.jetstream()
          }
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

// ── JetStream mode ───────────────────────────────────────────────────────────
// Hardcoded constants. To survive longer pauses, raise JS_INACTIVE_THRESHOLD_NS.
// To keep messages around longer, raise JS_STREAM_MAX_AGE_NS.
const JS_STREAM_NAME = 'channel-mcp'
const JS_STREAM_MAX_AGE_NS = 3 * 60 * 60 * 1_000_000_000   // 3h
const JS_INACTIVE_THRESHOLD_NS = 60 * 60 * 1_000_000_000   // 1h
const JS_ACK_WAIT_NS = 30 * 1_000_000_000                  // 30s
const JS_MAX_DELIVER = 3
const JS_REPLAY_DEFAULT_SINCE_MS = 60 * 60 * 1000          // 1h
const JS_REPLAY_DEFAULT_LIMIT = 50
const JS_REPLAY_MAX_LIMIT = 500

let js: JetStreamClient | null = null
let jsm: JetStreamManager | null = null
const createdDurables = new Set<string>()
type ConsumerMessagesHandle = { stop: () => void | Promise<void> }
const activeJsConsumers = new Map<string, ConsumerMessagesHandle>()

// Slug a NATS subject into a durable-name suffix. NATS durable names disallow
// '.', '*', '>', so map them to safe strings while preserving uniqueness.
function durableNameFor(subject: string): string {
  const slug = subject.replace(/\./g, '_').replace(/\*/g, 'STAR').replace(/>/g, 'GT')
  return `${agentName}__${slug}`
}

async function ensureStream(subjects: string[]): Promise<void> {
  if (!jsm) throw new Error('jsm not initialized')
  let existingSubjects: string[] = []
  let exists = false
  try {
    const info = await jsm.streams.info(JS_STREAM_NAME)
    existingSubjects = info.config.subjects ?? []
    exists = true
  } catch (err) {
    const msg = (err as Error).message
    if (!/not found|stream not found|no responders/i.test(msg)) throw err
  }
  if (!exists) {
    await jsm.streams.add({
      name: JS_STREAM_NAME,
      subjects,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_age: JS_STREAM_MAX_AGE_NS,
      num_replicas: 1,
    })
    console.error(`[${agentName}] created stream ${JS_STREAM_NAME} with subjects ${subjects.join(', ')}`)
    return
  }
  const merged = Array.from(new Set([...existingSubjects, ...subjects]))
  if (merged.length === existingSubjects.length) return
  await jsm.streams.update(JS_STREAM_NAME, { subjects: merged })
  console.error(`[${agentName}] extended stream ${JS_STREAM_NAME} subjects → ${merged.join(', ')}`)
}

async function ensureDurable(subject: string): Promise<string> {
  if (!jsm) throw new Error('jsm not initialized')
  const name = durableNameFor(subject)
  try {
    await jsm.consumers.add(JS_STREAM_NAME, {
      durable_name: name,
      filter_subject: subject,
      deliver_policy: DeliverPolicy.New,
      ack_policy: AckPolicy.Explicit,
      ack_wait: JS_ACK_WAIT_NS,
      max_deliver: JS_MAX_DELIVER,
      inactive_threshold: JS_INACTIVE_THRESHOLD_NS,
      replay_policy: ReplayPolicy.Instant,
    })
    console.error(`[${agentName}] created durable ${name} for ${subject}`)
  } catch (err) {
    const msg = (err as Error).message
    if (!/already in use|already exists|consumer name already/i.test(msg)) throw err
  }
  createdDurables.add(name)
  return name
}

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
const replyTool = {
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
}

// Replay tool — only registered when --jetstream. Pulls historical messages
// from the JetStream buffer and returns as MCP tool output, NOT as a channel
// notification, so it does not double-fire into the live inbox.
const replayTool = {
  name: 'replay',
  description: 'Fetch historical messages on a subject from the JetStream buffer (--jetstream only).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      subject: { type: 'string', description: 'NATS subject (wildcards OK)' },
      since:   { type: 'string', description: 'Duration ("1h", "30m") or ISO timestamp. Default "1h".' },
      limit:   { type: 'integer', description: `Max messages. Default ${JS_REPLAY_DEFAULT_LIMIT}, max ${JS_REPLAY_MAX_LIMIT}.` },
    },
    required: ['subject'],
  },
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: useJetStream ? [replyTool, replayTool] : [replyTool],
}))

function parseSince(s: string | undefined): number {
  if (!s) return JS_REPLAY_DEFAULT_SINCE_MS
  // Duration first — Date.parse will mis-coerce bare numerics like "2024" or
  // "1" into valid dates on V8, surprising callers who meant a count of years.
  const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(s)
  if (m) {
    const n = parseInt(m[1]!, 10)
    const unit = m[2]!
    const mul = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
    return n * mul
  }
  const iso = Date.parse(s)
  if (!Number.isNaN(iso)) return Math.max(0, Date.now() - iso)
  throw new Error(`invalid 'since' value: ${s}`)
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'reply') {
    const { to, text } = req.params.arguments as { to: string; text: string }
    const hdrs = headers()
    hdrs.set('x-from', agentName)
    nc.publish(to, sc.encode(text), { headers: hdrs })
    console.error(`[${agentName}] published to ${to}: ${text.slice(0, 80)}`)
    return { content: [{ type: 'text' as const, text: `published to ${to}` }] }
  }

  if (req.params.name === 'replay') {
    if (!useJetStream || !js || !jsm) {
      throw new Error('replay requires --jetstream')
    }
    const { subject, since, limit } = req.params.arguments as { subject: string; since?: string; limit?: number }
    const sinceMs = parseSince(since)
    const startTime = new Date(Date.now() - sinceMs).toISOString()
    const max = Math.min(limit ?? JS_REPLAY_DEFAULT_LIMIT, JS_REPLAY_MAX_LIMIT)
    const ephemeralName = `replay-${agentName}-${randomBytes(4).toString('hex')}`
    try {
      await jsm.consumers.add(JS_STREAM_NAME, {
        name: ephemeralName,
        filter_subject: subject,
        deliver_policy: DeliverPolicy.StartTime,
        opt_start_time: startTime,
        ack_policy: AckPolicy.None,
        inactive_threshold: 60 * 1_000_000_000,
        replay_policy: ReplayPolicy.Instant,
      })
      const c = await js.consumers.get(JS_STREAM_NAME, ephemeralName)
      const iter = await c.fetch({ max_messages: max, expires: 2_000 })
      const items: Array<{ subject: string; from: string | null; ts: string; seq: number; text: string }> = []
      for await (const m of iter) {
        items.push({
          subject: m.subject,
          from: m.headers?.get('x-from') || null,
          ts: new Date(Math.floor(m.info.timestampNanos / 1e6)).toISOString(),
          seq: m.seq,
          text: sc.decode(m.data),
        })
      }
      console.error(`[${agentName}] replay ${subject} since=${since ?? '1h'} returned ${items.length} msgs`)
      return { content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }] }
    } finally {
      try {
        await jsm.consumers.delete(JS_STREAM_NAME, ephemeralName)
      } catch (err) {
        // Best-effort cleanup. The ephemeral has InactiveThreshold=60s so a
        // leak self-reaps within a minute. We log so it's not invisible.
        console.error(`[${agentName}] replay cleanup failed for ${ephemeralName}: ${(err as Error).message}`)
      }
    }
  }

  throw new Error(`unknown tool: ${req.params.name}`)
})

// ── Subscribe to a NATS subject and bridge to Claude ─────────────────────────

async function deliverToClaude(subject: string, data: Uint8Array, hdrs: ReturnType<typeof headers> | undefined, replySubject: string | undefined): Promise<boolean> {
  const content = sc.decode(data)
  const fromHeader = hdrs?.get('x-from')
  if (!allowSelfEcho && fromHeader === agentName) {
    console.error(`[${agentName}] dropped self-echo on ${subject}: ${content.slice(0, 80)}`)
    return false
  }
  console.error(`[${agentName}] received on ${subject}: ${content.slice(0, 80)}`)
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content, meta: { subject, from: replySubject ?? '' } },
  })
  return true
}

async function subscribeCore(subject: string): Promise<void> {
  if (activeSubs.has(subject)) return
  const sub = nc.subscribe(subject)
  activeSubs.set(subject, sub)
  console.error(`[${agentName}] subscribed to ${subject}`)
  ;(async () => {
    for await (const msg of sub) {
      await deliverToClaude(msg.subject, msg.data, msg.headers, msg.reply)
    }
  })()
}

async function subscribeJetStream(subject: string): Promise<void> {
  if (!js || !jsm) throw new Error('jetstream not initialized')
  if (activeJsConsumers.has(subject)) return
  await ensureStream([subject])
  const durable = await ensureDurable(subject)
  const consumer = await js.consumers.get(JS_STREAM_NAME, durable)
  const iter = await consumer.consume()
  activeJsConsumers.set(subject, iter)
  console.error(`[${agentName}] JS-subscribed to ${subject} via ${durable}`)
  ;(async () => {
    for await (const m of iter) {
      try {
        await deliverToClaude(m.subject, m.data, m.headers ?? undefined, undefined)
        // Ack only on success (and on self-echo, which returns false but does
        // not throw). Throws here mean the MCP transport rejected the
        // notification — leave unacked so JetStream redelivers after AckWait.
        m.ack()
      } catch (err) {
        console.error(`[${agentName}] deliver failed on ${m.subject} seq=${m.seq}, leaving unacked: ${(err as Error).message}`)
      }
    }
  })()
}

async function subscribe(subject: string): Promise<void> {
  trackedSubjects.add(subject)
  if (useJetStream) await subscribeJetStream(subject)
  else await subscribeCore(subject)
}

async function unsubscribe(subject: string): Promise<void> {
  trackedSubjects.delete(subject)
  if (useJetStream) {
    const iter = activeJsConsumers.get(subject)
    if (!iter) return
    await iter.stop()
    activeJsConsumers.delete(subject)
    console.error(`[${agentName}] JS-unsubscribed from ${subject} (durable kept until InactiveThreshold)`)
    return
  }
  const sub = activeSubs.get(subject)
  if (!sub) return
  sub.unsubscribe()
  activeSubs.delete(subject)
  console.error(`[${agentName}] unsubscribed from ${subject}`)
}

async function deleteDurable(subject: string): Promise<void> {
  if (!useJetStream || !jsm) {
    console.error(`[${agentName}] delete-durable ignored — --jetstream not enabled`)
    return
  }
  // Stop live consumption first so we don't fight an active iterator.
  await unsubscribe(subject)
  const name = durableNameFor(subject)
  if (!createdDurables.has(name)) {
    console.error(`[${agentName}] delete-durable refused — ${name} not in this server's created set`)
    return
  }
  try {
    await jsm.consumers.delete(JS_STREAM_NAME, name)
    createdDurables.delete(name)
    console.error(`[${agentName}] deleted durable ${name}`)
  } catch (err) {
    console.error(`[${agentName}] delete-durable failed for ${name}: ${(err as Error).message}`)
  }
}

// ── Connect to Claude Code over stdio (must happen before subscribing) ────────

await mcp.connect(new StdioServerTransport())

// Bootstrap JetStream before any subscribe lands the durables that follow.
if (useJetStream) {
  jsm = await nc.jetstreamManager()
  js = nc.jetstream()
  await ensureStream(initialSubjects)
  console.error(`[${agentName}] JetStream mode enabled (stream=${JS_STREAM_NAME})`)
}

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
          } else if (cmd.action === 'delete-durable' && typeof cmd.subject === 'string') {
            deleteDurable(cmd.subject).catch(err =>
              console.error(`[${agentName}] ctrl delete-durable failed: ${err}`))
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
  for (const iter of activeJsConsumers.values()) {
    try { await iter.stop() } catch { /* best-effort */ }
  }
  await nc.drain()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)
