import { createHmac, timingSafeEqual } from 'node:crypto'

export const CLAUDE_CHANNEL_DELIVERY_VERSION = 1 as const

export interface ClaudeChannelDeliveryPayload {
  version: typeof CLAUDE_CHANNEL_DELIVERY_VERSION
  messageId: string
  deliveryId: string
  attempt: number
  acceptedAt: string
  sender: { sessionId: string; incarnation: string }
  destination: { subject: string }
  recipient: {
    providerId: string
    sessionId: string
    incarnation: string
  }
  text: string
}

export interface ClaudeChannelDeliveryCommand {
  action: 'deliver'
  envelope: { payload: ClaudeChannelDeliveryPayload; auth: string }
}

export type ClaudeChannelDeliveryResponse =
  | {
      version: typeof CLAUDE_CHANNEL_DELIVERY_VERSION
      status: 'accepted'
      messageId: string
      deliveryId: string
      attempt: number
      recipient: ClaudeChannelDeliveryPayload['recipient']
      acceptedAt: string
    }
  | {
      version: typeof CLAUDE_CHANNEL_DELIVERY_VERSION
      status: 'rejected'
      messageId: string
      deliveryId: string
      attempt: number
      recipient: ClaudeChannelDeliveryPayload['recipient']
      checkedAt: string
      reason: string
      retryable: boolean
    }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function payloadFrom(command: unknown): ClaudeChannelDeliveryPayload | null {
  if (!record(command) || command.action !== 'deliver' || !record(command.envelope)) return null
  const payload = command.envelope.payload
  if (!record(payload)
    || payload.version !== CLAUDE_CHANNEL_DELIVERY_VERSION
    || !nonEmpty(payload.messageId)
    || !nonEmpty(payload.deliveryId)
    || !Number.isInteger(payload.attempt)
    || Number(payload.attempt) < 1
    || !nonEmpty(payload.acceptedAt)
    || !record(payload.sender)
    || !nonEmpty(payload.sender.sessionId)
    || !nonEmpty(payload.sender.incarnation)
    || !record(payload.destination)
    || !nonEmpty(payload.destination.subject)
    || !record(payload.recipient)
    || !nonEmpty(payload.recipient.providerId)
    || !nonEmpty(payload.recipient.sessionId)
    || !nonEmpty(payload.recipient.incarnation)
    || !nonEmpty(payload.text)) return null
  return payload as unknown as ClaudeChannelDeliveryPayload
}

function authenticated(command: unknown, payload: ClaudeChannelDeliveryPayload, key: Uint8Array): boolean {
  if (!record(command) || !record(command.envelope) || typeof command.envelope.auth !== 'string') {
    return false
  }
  const expected = Buffer.from(createHmac('sha256', key)
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex'), 'hex')
  const actual = /^[0-9a-f]{64}$/.test(command.envelope.auth)
    ? Buffer.from(command.envelope.auth, 'hex')
    : Buffer.alloc(expected.byteLength)
  return timingSafeEqual(expected, actual)
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

export function formatClaudeChannelDelivery(payload: ClaudeChannelDeliveryPayload): string {
  return `<tinstar-message id="${escapeAttribute(payload.messageId)}" `
    + `delivery="${escapeAttribute(payload.deliveryId)}" attempt="${payload.attempt}" `
    + `from="${escapeAttribute(payload.sender.sessionId)}">\n`
    + `${payload.text}\n</tinstar-message>`
}

export interface DeliveryControlDependencies {
  agentName: string
  incarnation: string
  authKey: Uint8Array
  subscriptions: () => readonly string[]
  notify: (input: {
    content: string
    meta: Record<string, string | number>
  }) => Promise<void>
  now?: () => string
}

export function createDeliveryControlHandler(dependencies: DeliveryControlDependencies) {
  if (!nonEmpty(dependencies.incarnation) || dependencies.authKey.byteLength !== 32) {
    throw new Error('managed delivery requires a live incarnation and a 32-byte authentication key')
  }
  const now = dependencies.now ?? (() => new Date().toISOString())
  return async (command: unknown): Promise<ClaudeChannelDeliveryResponse | null> => {
    const payload = payloadFrom(command)
    if (!payload) return null
    const reject = (reason: string, retryable: boolean): ClaudeChannelDeliveryResponse => ({
      version: CLAUDE_CHANNEL_DELIVERY_VERSION,
      status: 'rejected',
      messageId: payload.messageId,
      deliveryId: payload.deliveryId,
      attempt: payload.attempt,
      recipient: payload.recipient,
      checkedAt: now(),
      reason,
      retryable,
    })
    if (payload.recipient.providerId !== 'claude'
      || payload.recipient.sessionId !== dependencies.agentName) {
      return reject('delivery recipient does not match this Claude channel', false)
    }
    if (payload.recipient.incarnation !== dependencies.incarnation) {
      return reject('delivery recipient was replaced', false)
    }
    if (!authenticated(command, payload, dependencies.authKey)) {
      return reject('delivery authentication failed', false)
    }
    if (!dependencies.subscriptions().includes(payload.destination.subject)) {
      return reject(`Claude channel is not subscribed to ${payload.destination.subject}`, true)
    }
    // Once notification starts, an error cannot prove that no bytes reached
    // Claude's MCP transport. Throw and withhold a receipt so Tinstar retains
    // the attempt as ambiguous instead of blindly retrying it.
    await dependencies.notify({
      content: formatClaudeChannelDelivery(payload),
      meta: {
        subject: payload.destination.subject,
        from: payload.sender.sessionId,
        messageId: payload.messageId,
        deliveryId: payload.deliveryId,
        attempt: payload.attempt,
      },
    })
    return {
      version: CLAUDE_CHANNEL_DELIVERY_VERSION,
      status: 'accepted',
      messageId: payload.messageId,
      deliveryId: payload.deliveryId,
      attempt: payload.attempt,
      recipient: payload.recipient,
      acceptedAt: now(),
    }
  }
}

export interface ManagedDeliveryControlDependencies
  extends Omit<DeliveryControlDependencies, 'incarnation' | 'authKey'> {
  incarnation?: string
  authenticationKeyHex?: string
}

export function createManagedDeliveryControlHandler(
  dependencies: ManagedDeliveryControlDependencies,
): ReturnType<typeof createDeliveryControlHandler> | null {
  const {
    incarnation: rawIncarnation,
    authenticationKeyHex: rawAuthenticationKeyHex,
    ...handlerDependencies
  } = dependencies
  const incarnation = rawIncarnation?.trim() ?? ''
  const authenticationKeyHex = rawAuthenticationKeyHex?.trim() ?? ''
  if (!incarnation || !/^[0-9a-f]{64}$/i.test(authenticationKeyHex)) return null

  const authKey = Buffer.from(authenticationKeyHex, 'hex')
  if (authKey.byteLength !== 32) return null

  return createDeliveryControlHandler({
    ...handlerDependencies,
    incarnation,
    authKey,
  })
}
