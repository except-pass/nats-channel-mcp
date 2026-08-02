import { describe, expect, it, mock } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  createReplyToolHandler,
  MESSAGE_ROUTE_PROTOCOL_VERSION,
  type MessageRouteRequest,
  type MessageRouteResponse,
} from '../tinstar-router-client.ts'

const ROUTER_SUBJECT = '_TINSTAR.delivery.route.test'
const DESTINATION = 'tinstar.space.init.epic.task.receiver'
const ROUTER_AUTH = '11'.repeat(32)

function managedEnvironment(): Record<string, string> {
  return {
    TINSTAR_MESSAGE_ROUTER_SUBJECT: ROUTER_SUBJECT,
    TINSTAR_SESSION_NAME: 'sender',
    TINSTAR_AGENT_INCARNATION: 'sender-v2',
    TINSTAR_MESSAGE_ROUTER_AUTH: ROUTER_AUTH,
  }
}

function authFor(payload: unknown, secret = ROUTER_AUTH): string {
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex')
}

function decodeRequest(data: Uint8Array): MessageRouteRequest {
  const envelope = JSON.parse(new TextDecoder().decode(data)) as {
    payload: MessageRouteRequest
    auth: string
  }
  expect(envelope.auth).toBe(authFor(envelope.payload))
  return envelope.payload
}

function acceptedResponse(
  requestId = 'request-7',
  status: 'accepted' | 'partial' = 'accepted',
): MessageRouteResponse {
  return {
    version: MESSAGE_ROUTE_PROTOCOL_VERSION,
    status,
    requestId,
    receipt: {
      requestId,
      messageId: 'message-7',
      acceptedAt: '2026-08-01T12:00:00.000Z',
      destinationKind: 'dm',
      deliveryIds: ['message-7/delivery/1'],
      recipients: [{
        providerId: 'forge',
        sessionId: 'receiver',
        incarnation: 'receiver-v3',
      }],
      exclusions: status === 'partial'
        ? [{ sessionId: 'stopped-peer', reason: 'stopped' }]
        : [],
    },
  }
}

function encodedResponse(
  response: unknown,
  secret = ROUTER_AUTH,
): AsyncIterable<{ data: Uint8Array }> {
  return encodedResponses([{ response, secret }])
}

function encodedResponses(
  responses: Array<{ response: unknown; secret?: string; uppercaseAuth?: boolean }>,
): AsyncIterable<{ data: Uint8Array }> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const { response, secret = ROUTER_AUTH, uppercaseAuth = false } of responses) {
        const auth = authFor(response, secret)
        yield {
          data: new TextEncoder().encode(JSON.stringify({
            payload: response,
            auth: uppercaseAuth ? auth.toUpperCase() : auth,
          })),
        }
      }
    },
  }
}

describe('Tinstar reply routing', () => {
  it('uses legacy publication only when no Tinstar router is configured', async () => {
    const request = mock(async () => encodedResponse(acceptedResponse()))
    const legacyReply = mock(async () => ({
      content: [{ type: 'text' as const, text: 'published to legacy subject' }],
    }))
    const reply = createReplyToolHandler({ request, legacyReply, env: {} })

    const result = await reply({ to: 'legacy.subject', text: 'hello' })

    expect(result.content[0]?.text).toContain('published to legacy subject')
    expect(legacyReply).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
  })

  it('sends protocol v1 with a generated request ID and fenced sender identity', async () => {
    const seen: MessageRouteRequest[] = []
    const request = mock(async (subject: string, data: Uint8Array) => {
      expect(subject).toBe(ROUTER_SUBJECT)
      const parsed = decodeRequest(data)
      seen.push(parsed)
      return encodedResponse(acceptedResponse(parsed.requestId))
    })
    const legacyReply = mock(async () => {
      throw new Error('legacy publication must not run for a managed Tinstar reply')
    })
    const reply = createReplyToolHandler({
      env: managedEnvironment(),
      request,
      legacyReply,
      createRequestId: () => 'request-7',
    })

    const result = await reply({ to: DESTINATION, text: 'durable hello' })

    expect(seen).toEqual([{
      version: 1,
      requestId: 'request-7',
      sender: { sessionId: 'sender', incarnation: 'sender-v2' },
      destination: { subject: DESTINATION },
      text: 'durable hello',
    }])
    expect(result).toMatchObject({
      content: [{ text: expect.stringContaining('accepted by Tinstar') }],
      structuredContent: {
        version: 1,
        status: 'accepted',
        requestId: 'request-7',
        receipt: { messageId: 'message-7' },
      },
    })
    expect(result).not.toHaveProperty('isError')
    expect(legacyReply).not.toHaveBeenCalled()
  })

  it('generates a fresh request ID for every reply invocation', async () => {
    const requestIds = ['request-a', 'request-b']
    const seen: string[] = []
    const reply = createReplyToolHandler({
      env: managedEnvironment(),
      request: async (_subject, data) => {
        const request = decodeRequest(data)
        seen.push(request.requestId)
        return encodedResponse(acceptedResponse(request.requestId))
      },
      legacyReply: async () => { throw new Error('must not publish') },
      createRequestId: () => requestIds.shift()!,
    })

    await reply({ to: DESTINATION, text: 'first' })
    await reply({ to: DESTINATION, text: 'second' })

    expect(seen).toEqual(['request-a', 'request-b'])
  })

  it('reuses a caller-owned request ID for an ambiguous retry', async () => {
    const seen: string[] = []
    const reply = createReplyToolHandler({
      env: managedEnvironment(),
      request: async (_subject, data) => {
        const request = decodeRequest(data)
        seen.push(request.requestId)
        return encodedResponse(acceptedResponse(request.requestId))
      },
      legacyReply: async () => { throw new Error('must not publish') },
      createRequestId: () => { throw new Error('caller id must win') },
    })

    await reply({ to: DESTINATION, text: 'retry me', requestId: 'caller-stable' })
    await reply({ to: DESTINATION, text: 'retry me', requestId: 'caller-stable' })

    expect(seen).toEqual(['caller-stable', 'caller-stable'])
  })

  it('returns partial acceptance as structured output', async () => {
    const reply = createReplyToolHandler({
      env: managedEnvironment(),
      request: async () => encodedResponse(acceptedResponse('request-8', 'partial')),
      legacyReply: async () => { throw new Error('must not publish') },
      createRequestId: () => 'request-8',
    })

    await expect(reply({ to: DESTINATION, text: 'hello everyone' })).resolves.toMatchObject({
      content: [{ text: expect.stringContaining('partially accepted with 1 exclusion') }],
      structuredContent: {
        status: 'partial',
        receipt: { exclusions: [{ sessionId: 'stopped-peer', reason: 'stopped' }] },
      },
    })
  })

  it('makes router error receipts visible and structured', async () => {
    const response: MessageRouteResponse = {
      version: 1,
      status: 'error',
      requestId: 'request-9',
      error: {
        code: 'recipient-unavailable',
        message: 'No live recipient accepted the message.',
        destinationKind: 'dm',
        subject: DESTINATION,
        exclusions: [{ sessionId: 'receiver', reason: 'stopped' }],
      },
    }
    const reply = createReplyToolHandler({
      env: managedEnvironment(),
      request: async () => encodedResponse(response),
      legacyReply: async () => { throw new Error('must not publish') },
      createRequestId: () => 'request-9',
    })

    await expect(reply({ to: DESTINATION, text: 'hello' })).resolves.toMatchObject({
      isError: true,
      content: [{ text: 'No live recipient accepted the message.' }],
      structuredContent: response,
    })
  })

  it('makes no-responder and timeout failures visible without raw-publish fallback', async () => {
    const legacyReply = mock(async () => {
      throw new Error('must not publish')
    })
    const env = managedEnvironment()
    const noResponder = createReplyToolHandler({
      env,
      request: async () => {
        throw Object.assign(new Error('503'), { code: '503' })
      },
      legacyReply,
      createRequestId: () => 'request-10',
    })
    const timeout = createReplyToolHandler({
      env,
      request: async () => {
        throw Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })
      },
      legacyReply,
      createRequestId: () => 'request-11',
      timeoutMs: 123,
    })

    await expect(noResponder({ to: DESTINATION, text: 'hello' })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('no responder') }],
    })
    await expect(timeout({ to: DESTINATION, text: 'hello' })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('within 123ms') }],
    })
    expect(legacyReply).not.toHaveBeenCalled()
  })

  it('ignores invalid replies until a valid authenticated matching receipt arrives', async () => {
    const legacyReply = mock(async () => {
      throw new Error('must not publish')
    })
    const reply = createReplyToolHandler({
      env: managedEnvironment(),
      request: async () => encodedResponses([
        { response: acceptedResponse('request-14'), secret: '22'.repeat(32) },
        { response: { version: 1, status: 'accepted', requestId: 'request-14', receipt: {} } },
        { response: acceptedResponse('someone-else') },
        { response: acceptedResponse('request-14'), uppercaseAuth: true },
        { response: acceptedResponse('request-14') },
      ]),
      legacyReply,
      createRequestId: () => 'request-14',
    })

    await expect(reply({ to: DESTINATION, text: 'hello' })).resolves.toMatchObject({
      structuredContent: { status: 'accepted', requestId: 'request-14' },
    })
    expect(legacyReply).not.toHaveBeenCalled()
  })

  it('times out visibly when every reply is invalid', async () => {
    const reply = createReplyToolHandler({
      env: managedEnvironment(),
      request: async () => encodedResponse(
        acceptedResponse('request-14'),
        '22'.repeat(32),
      ),
      legacyReply: async () => { throw new Error('must not publish') },
      createRequestId: () => 'request-14',
      timeoutMs: 123,
    })

    await expect(reply({ to: DESTINATION, text: 'hello' })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('within 123ms') }],
    })
  })

  it('fails closed when any managed variable is present without the full set', async () => {
    const request = mock(async () => encodedResponse(acceptedResponse('request-15')))
    const legacyReply = mock(async () => ({
      content: [{ type: 'text' as const, text: 'must not publish' }],
    }))
    for (const name of [
      'TINSTAR_MESSAGE_ROUTER_SUBJECT',
      'TINSTAR_SESSION_NAME',
      'TINSTAR_AGENT_INCARNATION',
      'TINSTAR_MESSAGE_ROUTER_AUTH',
    ]) {
      const reply = createReplyToolHandler({
        env: { [name]: 'present' },
        request,
        legacyReply,
        createRequestId: () => 'request-15',
      })

      await expect(reply({ to: DESTINATION, text: 'hello' })).resolves.toMatchObject({
        isError: true,
        content: [{
          text: expect.stringContaining('managed reply environment is incomplete'),
        }],
      })
    }

    const invalidAuth = createReplyToolHandler({
      env: {
        ...managedEnvironment(),
        TINSTAR_MESSAGE_ROUTER_AUTH: 'not-lowercase-hex',
      },
      request,
      legacyReply,
    })
    await expect(invalidAuth({ to: DESTINATION, text: 'hello' })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('64 lowercase hex characters') }],
    })
    expect(request).not.toHaveBeenCalled()
    expect(legacyReply).not.toHaveBeenCalled()
  })
})
