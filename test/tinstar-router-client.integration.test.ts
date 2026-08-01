import { afterEach, describe, expect, it } from 'bun:test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { connect, type NatsConnection } from 'nats'
import {
  type MessageRouteRequest,
  type MessageRouteResponse,
} from '../tinstar-router-client.ts'

const natsServerAvailable = spawnSync(
  'nats-server',
  ['-v'],
  { stdio: 'ignore' },
).status === 0

const children: ChildProcess[] = []
const connections: NatsConnection[] = []
const mcpClients: Client[] = []
const ROUTER_AUTH = '33'.repeat(32)

function authFor(payload: unknown, secret = ROUTER_AUTH): string {
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex')
}

function encodeEnvelope(payload: unknown, secret = ROUTER_AUTH): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    payload,
    auth: authFor(payload, secret),
  }))
}

afterEach(async () => {
  for (const client of mcpClients.splice(0)) await client.close()
  for (const connection of connections.splice(0)) await connection.close()
  for (const child of children.splice(0)) child.kill('SIGTERM')
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
  return address.port
}

async function connectEventually(url: string): Promise<NatsConnection> {
  let lastError: unknown
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const connection = await connect({
        servers: url,
        maxReconnectAttempts: 0,
        timeout: 250,
      })
      connections.push(connection)
      return connection
    } catch (error) {
      lastError = error
      await Bun.sleep(25)
    }
  }
  throw lastError
}

describe.skipIf(!natsServerAvailable)('Tinstar replies with real NATS', () => {
  it('routes the executable MCP reply tool without raw-publish fallback', async () => {
    const port = await freePort()
    const url = `nats://127.0.0.1:${port}`
    children.push(spawn(
      'nats-server',
      ['-a', '127.0.0.1', '-p', String(port)],
      { stdio: 'ignore' },
    ))

    const [client, router] = await Promise.all([
      connectEventually(url),
      connectEventually(url),
    ])
    const subject = '_TINSTAR.delivery.route.integration'
    const destination = 'tinstar.space.init.epic.task.receiver'
    const requests: MessageRouteRequest[] = []
    const requestAuthenticators: string[] = []
    let rawPublications = 0
    const rawSubscription = router.subscribe(destination, {
      callback: () => { rawPublications++ },
    })
    const subscription = router.subscribe(subject)
    void (async () => {
      for await (const message of subscription) {
        const envelope = JSON.parse(
          new TextDecoder().decode(message.data),
        ) as { payload: MessageRouteRequest; auth: string }
        const request = envelope.payload
        requests.push(request)
        requestAuthenticators.push(envelope.auth)
        const response: MessageRouteResponse = request.text === 'reject this'
          ? {
              version: 1,
              status: 'error',
              requestId: request.requestId,
              error: {
                code: 'recipient-unavailable',
                message: 'Receiver is stopped.',
                destinationKind: 'dm',
                subject: request.destination.subject,
                exclusions: [{ sessionId: 'receiver', reason: 'stopped' }],
              },
            }
          : {
              version: 1,
              status: 'accepted',
              requestId: request.requestId,
              receipt: {
                requestId: request.requestId,
                messageId: 'message-real',
                acceptedAt: '2026-08-01T12:00:00.000Z',
                destinationKind: 'dm',
                deliveryIds: ['message-real/delivery/1'],
                recipients: [{
                  providerId: 'codex',
                  sessionId: 'receiver',
                  incarnation: 'receiver-v1',
                }],
                exclusions: [],
              },
            }
        if (request.text === 'forged then legitimate') {
          message.respond(encodeEnvelope(response, '44'.repeat(32)))
          await Bun.sleep(10)
        }
        message.respond(encodeEnvelope(response))
      }
    })()
    await router.flush()

    const transport = new StdioClientTransport({
      command: 'bun',
      args: [
        fileURLToPath(new URL('../channel-server.ts', import.meta.url)),
        '--name', 'sender',
        '--subscribe', 'agents.sender',
        '--nats', url,
      ],
      env: {
        ...getDefaultEnvironment(),
        TINSTAR_MESSAGE_ROUTER_SUBJECT: subject,
        TINSTAR_SESSION_NAME: 'sender',
        TINSTAR_AGENT_INCARNATION: 'sender-v1',
        TINSTAR_MESSAGE_ROUTER_AUTH: ROUTER_AUTH,
      },
      stderr: 'pipe',
    })
    transport.stderr?.on('data', () => {})
    const mcpClient = new Client({ name: 'router-e2e', version: '1.0.0' })
    mcpClients.push(mcpClient)
    await mcpClient.connect(transport)
    await expect(mcpClient.listTools()).resolves.toMatchObject({
      tools: [{
        name: 'reply',
        description: expect.stringContaining('durable acceptance receipt'),
        inputSchema: {
          properties: { requestId: { type: 'string' } },
        },
      }],
    })

    await expect(mcpClient.callTool({
      name: 'reply',
      arguments: {
        to: destination,
        text: 'real transport proof',
      },
    })).resolves.toMatchObject({
      structuredContent: {
        status: 'accepted',
        receipt: { messageId: 'message-real' },
      },
    })
    await expect(mcpClient.callTool({
      name: 'reply',
      arguments: {
        to: destination,
        text: 'second transport proof',
      },
    })).resolves.toMatchObject({
      structuredContent: { status: 'accepted' },
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(mcpClient.callTool({
        name: 'reply',
        arguments: {
          to: destination,
          text: 'caller-owned retry',
          requestId: 'stable-request-id',
        },
      })).resolves.toMatchObject({
        structuredContent: {
          status: 'accepted',
          requestId: 'stable-request-id',
        },
      })
    }
    await expect(mcpClient.callTool({
      name: 'reply',
      arguments: { to: destination, text: 'reject this' },
    })).resolves.toMatchObject({
      isError: true,
      content: [{ text: 'Receiver is stopped.' }],
      structuredContent: {
        status: 'error',
        error: { code: 'recipient-unavailable' },
      },
    })
    await expect(mcpClient.callTool({
      name: 'reply',
      arguments: { to: destination, text: 'forged then legitimate' },
    })).resolves.toMatchObject({
      structuredContent: { status: 'accepted' },
    })
    expect(requests).toHaveLength(6)
    expect(requestAuthenticators).toEqual(
      requests.map(request => authFor(request)),
    )
    expect(requests[0]).toMatchObject({
      version: 1,
      sender: { sessionId: 'sender', incarnation: 'sender-v1' },
      destination: { subject: destination },
      text: 'real transport proof',
    })
    expect(requests[0]!.requestId).not.toBe(requests[1]!.requestId)
    expect(requests.slice(2, 4).map(request => request.requestId)).toEqual([
      'stable-request-id',
      'stable-request-id',
    ])
    expect(rawPublications).toBe(0)

    subscription.unsubscribe()
    await router.flush()
    await expect(mcpClient.callTool({
      name: 'reply',
      arguments: { to: destination, text: 'must not disappear' },
    })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('no responder') }],
    })
    await client.flush()
    await Bun.sleep(25)
    expect(rawPublications).toBe(0)
    rawSubscription.unsubscribe()
  })

  it('fails closed when the executable inherits a partial managed environment', async () => {
    const port = await freePort()
    const url = `nats://127.0.0.1:${port}`
    children.push(spawn(
      'nats-server',
      ['-a', '127.0.0.1', '-p', String(port)],
      { stdio: 'ignore' },
    ))
    const observer = await connectEventually(url)
    const destination = 'partial-env.receiver'
    let rawPublications = 0
    const subscription = observer.subscribe(destination, {
      callback: () => { rawPublications++ },
    })
    await observer.flush()

    const transport = new StdioClientTransport({
      command: 'bun',
      args: [
        fileURLToPath(new URL('../channel-server.ts', import.meta.url)),
        '--name', 'partial-sender',
        '--subscribe', 'partial.sender',
        '--nats', url,
      ],
      env: {
        ...getDefaultEnvironment(),
        TINSTAR_SESSION_NAME: 'partial-sender',
      },
      stderr: 'pipe',
    })
    transport.stderr?.on('data', () => {})
    const mcpClient = new Client({ name: 'partial-env-e2e', version: '1.0.0' })
    mcpClients.push(mcpClient)
    await mcpClient.connect(transport)

    await expect(mcpClient.callTool({
      name: 'reply',
      arguments: { to: destination, text: 'must fail closed' },
    })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('TINSTAR_MESSAGE_ROUTER_AUTH') }],
    })
    await Bun.sleep(25)
    expect(rawPublications).toBe(0)
    subscription.unsubscribe()
  })

  it('preserves raw NATS reply behavior outside managed Tinstar mode', async () => {
    const port = await freePort()
    const url = `nats://127.0.0.1:${port}`
    children.push(spawn(
      'nats-server',
      ['-a', '127.0.0.1', '-p', String(port)],
      { stdio: 'ignore' },
    ))
    const observer = await connectEventually(url)
    const destination = 'legacy.receiver'
    const publications: Array<{ text: string; from?: string }> = []
    const subscription = observer.subscribe(destination, {
      callback: (_error, message) => {
        publications.push({
          text: new TextDecoder().decode(message.data),
          from: message.headers?.get('x-from'),
        })
      },
    })
    await observer.flush()

    const transport = new StdioClientTransport({
      command: 'bun',
      args: [
        fileURLToPath(new URL('../channel-server.ts', import.meta.url)),
        '--name', 'legacy-sender',
        '--subscribe', 'legacy.sender',
        '--nats', url,
      ],
      env: getDefaultEnvironment(),
      stderr: 'pipe',
    })
    transport.stderr?.on('data', () => {})
    const mcpClient = new Client({ name: 'legacy-e2e', version: '1.0.0' })
    mcpClients.push(mcpClient)
    await mcpClient.connect(transport)

    await expect(mcpClient.callTool({
      name: 'reply',
      arguments: { to: destination, text: 'legacy publication' },
    })).resolves.toMatchObject({
      content: [{ text: `published to ${destination}` }],
    })
    for (let attempt = 0; attempt < 20 && publications.length === 0; attempt++) {
      await Bun.sleep(10)
    }
    expect(publications).toEqual([{
      text: 'legacy publication',
      from: 'legacy-sender',
    }])
    subscription.unsubscribe()
  })
})
