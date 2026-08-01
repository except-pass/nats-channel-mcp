import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export const MESSAGE_ROUTE_PROTOCOL_VERSION = 1 as const
export const DEFAULT_MESSAGE_ROUTE_TIMEOUT_MS = 15_000

export const TINSTAR_MESSAGE_ROUTER_SUBJECT_ENV = 'TINSTAR_MESSAGE_ROUTER_SUBJECT'
export const TINSTAR_SESSION_NAME_ENV = 'TINSTAR_SESSION_NAME'
export const TINSTAR_AGENT_INCARNATION_ENV = 'TINSTAR_AGENT_INCARNATION'
export const TINSTAR_MESSAGE_ROUTER_AUTH_ENV = 'TINSTAR_MESSAGE_ROUTER_AUTH'

const MANAGED_REPLY_ENVIRONMENT = [
  TINSTAR_MESSAGE_ROUTER_SUBJECT_ENV,
  TINSTAR_SESSION_NAME_ENV,
  TINSTAR_AGENT_INCARNATION_ENV,
  TINSTAR_MESSAGE_ROUTER_AUTH_ENV,
] as const

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export interface MessageRouteRequest {
  version: typeof MESSAGE_ROUTE_PROTOCOL_VERSION
  requestId: string
  sender: {
    sessionId: string
    incarnation: string
  }
  destination: {
    subject: string
  }
  text: string
}

export interface MessageRouteReceipt {
  requestId: string
  messageId: string
  acceptedAt: string
  destinationKind: 'dm' | 'broadcast' | 'breakout'
  deliveryIds: string[]
  recipients: Array<{
    providerId: string
    sessionId: string
    incarnation: string
  }>
  exclusions: Array<{
    sessionId: string
    reason: string
  }>
}

export type MessageRouteAcceptedResponse = {
  version: typeof MESSAGE_ROUTE_PROTOCOL_VERSION
  status: 'accepted' | 'partial'
  requestId: string
  receipt: MessageRouteReceipt
}

export type MessageRouteErrorResponse = {
  version: typeof MESSAGE_ROUTE_PROTOCOL_VERSION
  status: 'error'
  requestId: string | null
  error: {
    code: string
    message: string
    destinationKind?: 'dm' | 'broadcast' | 'breakout'
    subject?: string
    sessionId?: string
    reason?: string
    exclusions?: Array<{ sessionId: string; reason: string }>
    rejection?: { reason: string; detail?: string }
  }
}

export type MessageRouteResponse =
  | MessageRouteAcceptedResponse
  | MessageRouteErrorResponse

export interface ReplyToolInput {
  to: string
  text: string
  /** Stable caller idempotency key. Reuse it after an ambiguous timeout. */
  requestId?: string
}

export interface ReplyToolResult {
  [key: string]: unknown
  isError?: true
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: MessageRouteResponse
}

export interface NatsRouteRequestClient {
  request(
    subject: string,
    data: Uint8Array,
    options: { timeout: number },
  ): Promise<AsyncIterable<{ data: Uint8Array }>>
}

export type RouteRequest = NatsRouteRequestClient['request']

export type MessageRouteTransportErrorCode =
  | 'no-responder'
  | 'timeout'
  | 'request-failed'
  | 'invalid-response'
  | 'authentication-failed'

export class MessageRouteTransportError extends Error {
  override readonly name = 'MessageRouteTransportError'

  constructor(
    readonly code: MessageRouteTransportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecipient(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.providerId)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.incarnation)
}

function isExclusion(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.reason)
}

function isMessageRouteResponse(value: unknown): value is MessageRouteResponse {
  if (!isRecord(value)
    || value.version !== MESSAGE_ROUTE_PROTOCOL_VERSION
    || (value.status !== 'accepted'
      && value.status !== 'partial'
      && value.status !== 'error')) return false

  if (value.status === 'error') {
    if (value.requestId !== null && !isNonEmptyString(value.requestId)) return false
    return isRecord(value.error)
      && isNonEmptyString(value.error.code)
      && isNonEmptyString(value.error.message)
  }

  if (!isNonEmptyString(value.requestId) || !isRecord(value.receipt)) return false
  const receipt = value.receipt
  return receipt.requestId === value.requestId
    && isNonEmptyString(receipt.messageId)
    && isNonEmptyString(receipt.acceptedAt)
    && (receipt.destinationKind === 'dm'
      || receipt.destinationKind === 'broadcast'
      || receipt.destinationKind === 'breakout')
    && Array.isArray(receipt.deliveryIds)
    && receipt.deliveryIds.length > 0
    && receipt.deliveryIds.every(isNonEmptyString)
    && Array.isArray(receipt.recipients)
    && receipt.recipients.length > 0
    && receipt.recipients.every(isRecipient)
    && Array.isArray(receipt.exclusions)
    && receipt.exclusions.every(isExclusion)
}

function payloadAuthenticator(payload: unknown, authenticationKey: Uint8Array): string {
  return createHmac('sha256', authenticationKey)
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex')
}

function authenticatedRequest(
  payload: MessageRouteRequest,
  authenticationKey: Uint8Array,
): Uint8Array {
  return textEncoder.encode(JSON.stringify({
    payload,
    auth: payloadAuthenticator(payload, authenticationKey),
  }))
}

function decodeMessageRouteResponse(
  data: Uint8Array,
  authenticationKey: Uint8Array,
): MessageRouteResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(textDecoder.decode(data))
  } catch {
    throw new MessageRouteTransportError(
      'invalid-response',
      'Tinstar message router returned invalid UTF-8 JSON',
    )
  }
  if (!isRecord(parsed)
    || !Object.hasOwn(parsed, 'payload')
    || typeof parsed.auth !== 'string') {
    throw new MessageRouteTransportError(
      'invalid-response',
      'Tinstar message router returned an unsupported authenticated response',
    )
  }

  const expected = Buffer.from(
    payloadAuthenticator(parsed.payload, authenticationKey),
    'hex',
  )
  const lowercaseSha256 = /^[0-9a-f]{64}$/.test(parsed.auth)
  const received = lowercaseSha256
    ? Buffer.from(parsed.auth, 'hex')
    : Buffer.alloc(expected.byteLength)
  const authenticated = timingSafeEqual(expected, received)
  if (!lowercaseSha256 || !authenticated) {
    throw new MessageRouteTransportError(
      'authentication-failed',
      'Tinstar message router response failed authentication',
    )
  }
  if (!isMessageRouteResponse(parsed.payload)) {
    throw new MessageRouteTransportError(
      'invalid-response',
      'Tinstar message router returned an unsupported response',
    )
  }
  return parsed.payload
}

function transportCode(error: unknown): MessageRouteTransportErrorCode {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : ''
  const message = error instanceof Error ? error.message : String(error)
  if (code === '503' || /no responders?/i.test(message)) return 'no-responder'
  if (code === 'TIMEOUT' || /timeout/i.test(message)) return 'timeout'
  return 'request-failed'
}

function messageRouteTransportError(
  error: unknown,
  timeoutMs: number,
): MessageRouteTransportError {
  const code = transportCode(error)
  let detail: string
  if (code === 'no-responder') {
    detail = 'has no responder; Tinstar may be offline'
  } else if (code === 'timeout') {
    detail = `did not respond within ${timeoutMs}ms`
  } else {
    detail = `request failed: ${error instanceof Error ? error.message : String(error)}`
  }
  return new MessageRouteTransportError(
    code,
    `Tinstar message router ${detail}`,
    { cause: error },
  )
}

export async function requestMessageRoute(
  request: RouteRequest,
  subject: string,
  message: MessageRouteRequest,
  authenticationKey: Uint8Array,
  timeoutMs = DEFAULT_MESSAGE_ROUTE_TIMEOUT_MS,
): Promise<MessageRouteResponse> {
  let responses: AsyncIterable<{ data: Uint8Array }>
  try {
    responses = await request(
      subject,
      authenticatedRequest(message, authenticationKey),
      { timeout: timeoutMs },
    )
  } catch (error) {
    throw messageRouteTransportError(error, timeoutMs)
  }

  try {
    for await (const response of responses) {
      try {
        const decoded = decodeMessageRouteResponse(response.data, authenticationKey)
        if (decoded.requestId === message.requestId) return decoded
      } catch (error) {
        if (
          error instanceof MessageRouteTransportError
          && (error.code === 'invalid-response' || error.code === 'authentication-failed')
        ) continue
        throw error
      }
    }
  } catch (error) {
    if (error instanceof MessageRouteTransportError) throw error
    throw messageRouteTransportError(error, timeoutMs)
  }

  throw new MessageRouteTransportError(
    'timeout',
    `Tinstar message router did not respond within ${timeoutMs}ms`,
  )
}

type ManagedReplyEnvironment =
  | { mode: 'legacy' }
  | { mode: 'invalid'; message: string }
  | {
    mode: 'managed'
    routerSubject: string
    authenticationKey: Buffer
    sender: MessageRouteRequest['sender']
  }

export function hasTinstarManagedReplyEnvironment(
  env: Record<string, string | undefined>,
): boolean {
  return MANAGED_REPLY_ENVIRONMENT.some(name => env[name] !== undefined)
}

function managedReplyEnvironment(
  env: Record<string, string | undefined>,
): ManagedReplyEnvironment {
  if (!hasTinstarManagedReplyEnvironment(env)) return { mode: 'legacy' }

  const routerSubject = env[TINSTAR_MESSAGE_ROUTER_SUBJECT_ENV]?.trim() ?? ''
  const sessionId = env[TINSTAR_SESSION_NAME_ENV]?.trim() ?? ''
  const incarnation = env[TINSTAR_AGENT_INCARNATION_ENV]?.trim() ?? ''
  const authenticationKeyHex = env[TINSTAR_MESSAGE_ROUTER_AUTH_ENV]?.trim() ?? ''
  const missing = [
    ...(!routerSubject ? [TINSTAR_MESSAGE_ROUTER_SUBJECT_ENV] : []),
    ...(!sessionId ? [TINSTAR_SESSION_NAME_ENV] : []),
    ...(!incarnation ? [TINSTAR_AGENT_INCARNATION_ENV] : []),
    ...(!authenticationKeyHex ? [TINSTAR_MESSAGE_ROUTER_AUTH_ENV] : []),
  ]
  if (missing.length > 0) {
    return {
      mode: 'invalid',
      message: `managed reply environment is incomplete; missing ${missing.join(', ')}`,
    }
  }
  if (!/^[0-9a-f]{64}$/.test(authenticationKeyHex)) {
    return {
      mode: 'invalid',
      message: `${TINSTAR_MESSAGE_ROUTER_AUTH_ENV} must be 64 lowercase hex characters`,
    }
  }
  return {
    mode: 'managed',
    routerSubject,
    authenticationKey: Buffer.from(authenticationKeyHex, 'hex'),
    sender: { sessionId, incarnation },
  }
}

function validateReplyInput(input: ReplyToolInput): void {
  if (!input || typeof input !== 'object') throw new Error('reply input must be an object')
  if (!isNonEmptyString(input.to)) throw new Error('reply destination must not be empty')
  if (!isNonEmptyString(input.text)) throw new Error('reply text must not be empty')
  if (input.requestId !== undefined && !isNonEmptyString(input.requestId)) {
    throw new Error('reply request ID must not be empty')
  }
}

export interface ReplyToolHandlerDependencies {
  env?: Record<string, string | undefined>
  request: RouteRequest
  legacyReply: (input: ReplyToolInput) => Promise<ReplyToolResult>
  createRequestId?: () => string
  timeoutMs?: number
}

/**
 * Select the durable Tinstar route when configured. A managed route failure is
 * final for this invocation: raw publication is never used as a fallback.
 */
export function createReplyToolHandler(
  dependencies: ReplyToolHandlerDependencies,
): (input: ReplyToolInput) => Promise<ReplyToolResult> {
  const env = dependencies.env ?? process.env
  const managedEnvironment = managedReplyEnvironment(env)
  if (managedEnvironment.mode === 'legacy') return dependencies.legacyReply
  if (managedEnvironment.mode === 'invalid') {
    return async () => ({
      isError: true,
      content: [{ type: 'text', text: managedEnvironment.message }],
    })
  }

  const createRequestId = dependencies.createRequestId ?? randomUUID
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_MESSAGE_ROUTE_TIMEOUT_MS

  return async (input) => {
    try {
      validateReplyInput(input)
      const requestId = input.requestId ?? createRequestId()
      if (!isNonEmptyString(requestId)) throw new Error('request ID must not be empty')
      const request: MessageRouteRequest = {
        version: MESSAGE_ROUTE_PROTOCOL_VERSION,
        requestId,
        sender: { ...managedEnvironment.sender },
        destination: { subject: input.to },
        text: input.text,
      }
      const response = await requestMessageRoute(
        dependencies.request,
        managedEnvironment.routerSubject,
        request,
        managedEnvironment.authenticationKey,
        timeoutMs,
      )
      if (response.status === 'error') {
        return {
          isError: true,
          content: [{ type: 'text', text: response.error.message }],
          structuredContent: response,
        }
      }
      const qualifier = response.status === 'partial'
        ? `partially accepted with ${response.receipt.exclusions.length} exclusion(s)`
        : 'accepted'
      return {
        content: [{
          type: 'text',
          text: `Message ${response.receipt.messageId} ${qualifier} by Tinstar.`,
        }],
        structuredContent: response,
      }
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: error instanceof Error ? error.message : String(error),
        }],
      }
    }
  }
}
