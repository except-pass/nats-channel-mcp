import { createHmac } from 'node:crypto'
import { describe, expect, it, mock } from 'bun:test'
import {
  createDeliveryControlHandler,
  createManagedDeliveryControlHandler,
  type ClaudeChannelDeliveryCommand,
  type ClaudeChannelDeliveryPayload,
} from '../delivery-control.ts'

const KEY = Buffer.from('23'.repeat(32), 'hex')
const NOW = '2026-08-01T12:00:01.000Z'

function payload(): ClaudeChannelDeliveryPayload {
  return {
    version: 1,
    messageId: 'msg-7',
    deliveryId: 'msg-7/d/1',
    attempt: 1,
    acceptedAt: '2026-08-01T12:00:00.000Z',
    sender: { sessionId: 'sender', incarnation: 'sender-v2' },
    destination: { subject: 'agents.receiver' },
    recipient: {
      providerId: 'claude',
      sessionId: 'receiver',
      incarnation: 'receiver-v3',
    },
    text: 'hello once',
  }
}

function command(overrides: Partial<ClaudeChannelDeliveryPayload> = {}): ClaudeChannelDeliveryCommand {
  const stamped = { ...payload(), ...overrides }
  return {
    action: 'deliver',
    envelope: {
      payload: stamped,
      auth: createHmac('sha256', KEY).update(JSON.stringify(stamped), 'utf8').digest('hex'),
    },
  }
}

describe('acknowledged delivery control command', () => {
  it('only enables managed delivery with a live incarnation and a 32-byte auth key', () => {
    const dependencies = {
      agentName: 'receiver',
      subscriptions: () => ['agents.receiver'],
      notify: async () => {},
    }

    for (const [incarnation, authenticationKeyHex] of [
      ['', '23'.repeat(32)],
      ['   ', '23'.repeat(32)],
      ['receiver-v3', ''],
      ['receiver-v3', '23'.repeat(31)],
      ['receiver-v3', '23'.repeat(33)],
      ['receiver-v3', `${'23'.repeat(31)}2`],
      ['receiver-v3', `${'23'.repeat(31)}zz`],
    ]) {
      expect(createManagedDeliveryControlHandler({
        ...dependencies,
        incarnation,
        authenticationKeyHex,
      })).toBeNull()
    }

    expect(createManagedDeliveryControlHandler({
      ...dependencies,
      incarnation: ' receiver-v3 ',
      authenticationKeyHex: ` ${'23'.repeat(32)} `,
    })).toBeFunction()
    expect(createManagedDeliveryControlHandler({
      ...dependencies,
      incarnation: 'receiver-v3',
      authenticationKeyHex: 'AB'.repeat(32),
    })).toBeFunction()
  })

  it('authenticates, verifies the live recipient/subscription, then acknowledges MCP push', async () => {
    const notify = mock(async () => {})
    const handle = createDeliveryControlHandler({
      agentName: 'receiver',
      incarnation: 'receiver-v3',
      authKey: KEY,
      subscriptions: () => ['agents.receiver'],
      notify,
      now: () => NOW,
    })

    await expect(handle(command())).resolves.toEqual({
      version: 1,
      status: 'accepted',
      messageId: 'msg-7',
      deliveryId: 'msg-7/d/1',
      attempt: 1,
      recipient: payload().recipient,
      acceptedAt: NOW,
    })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith({
      content: expect.stringContaining('<tinstar-message id="msg-7"'),
      meta: {
        subject: 'agents.receiver',
        from: 'sender',
        messageId: 'msg-7',
        deliveryId: 'msg-7/d/1',
        attempt: 1,
      },
    })
  })

  it('rejects bad authentication without pushing', async () => {
    const notify = mock(async () => {})
    const handle = createDeliveryControlHandler({
      agentName: 'receiver', incarnation: 'receiver-v3', authKey: KEY,
      subscriptions: () => ['agents.receiver'], notify, now: () => NOW,
    })
    const invalid = command()
    invalid.envelope.auth = '00'.repeat(32)

    await expect(handle(invalid)).resolves.toMatchObject({
      status: 'rejected', reason: 'delivery authentication failed', retryable: false,
    })
    expect(notify).not.toHaveBeenCalled()
  })

  it('rejects replacement incarnations terminally before checking the replacement auth key', async () => {
    const notify = mock(async () => {})
    const handle = createDeliveryControlHandler({
      agentName: 'receiver', incarnation: 'receiver-v4', authKey: Buffer.from('45'.repeat(32), 'hex'),
      subscriptions: () => [], notify, now: () => NOW,
    })
    await expect(handle(command())).resolves.toMatchObject({
      status: 'rejected', reason: 'delivery recipient was replaced', retryable: false,
    })
    expect(notify).not.toHaveBeenCalled()
  })

  it('rejects missing subscriptions without pushing', async () => {
    const notify = mock(async () => {})
    const current = createDeliveryControlHandler({
      agentName: 'receiver', incarnation: 'receiver-v3', authKey: KEY,
      subscriptions: () => [], notify, now: () => NOW,
    })
    await expect(current(command())).resolves.toMatchObject({
      status: 'rejected', reason: expect.stringContaining('not subscribed'), retryable: true,
    })
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not acknowledge success when the native Claude notification fails', async () => {
    const handle = createDeliveryControlHandler({
      agentName: 'receiver', incarnation: 'receiver-v3', authKey: KEY,
      subscriptions: () => ['agents.receiver'],
      notify: async () => { throw new Error('stdio closed') },
      now: () => NOW,
    })
    await expect(handle(command())).rejects.toThrow('stdio closed')
  })
})
