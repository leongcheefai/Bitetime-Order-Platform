import { describe, it, expect } from 'vitest'
import { notifyOrderPlaced, notifyOrderShipped, type NotifyTransport } from './notifications'

// In-memory transport: records calls, lets a test force a failure per channel.
function recorder(fail: { telegram?: boolean; email?: boolean } = {}) {
  const calls: any[] = []
  const transport: NotifyTransport = {
    async sendTelegram(token, chatId, text) {
      calls.push({ channel: 'telegram', token, chatId, text })
      if (fail.telegram) throw new Error('tg down')
    },
    async sendEmail(serviceId, templateId, params, publicKey) {
      calls.push({ channel: 'email', serviceId, templateId, params, publicKey })
      if (fail.email) throw new Error('email down')
    },
  }
  return { transport, calls }
}

describe('notifyOrderPlaced', () => {
  it('sends both channels when configured, returning an ok result per channel', async () => {
    const { transport, calls } = recorder()
    const results = await notifyOrderPlaced(transport,
      { telegram: { token: 'T', chatId: 'C' }, email: { serviceId: 'S', publicKey: 'K' } },
      { telegram: { text: 'hi' }, email: { templateId: 'tmpl', params: { to_name: 'Sam' } } },
    )
    expect(calls).toEqual([
      { channel: 'telegram', token: 'T', chatId: 'C', text: 'hi' },
      { channel: 'email', serviceId: 'S', templateId: 'tmpl', params: { to_name: 'Sam' }, publicKey: 'K' },
    ])
    expect(results).toEqual([
      { channel: 'telegram', ok: true },
      { channel: 'email', ok: true },
    ])
  })

  it('skips a channel when its credentials are missing', async () => {
    const { transport, calls } = recorder()
    const results = await notifyOrderPlaced(transport,
      { email: { serviceId: 'S', publicKey: 'K' } }, // no telegram cfg
      { telegram: { text: 'hi' }, email: { templateId: 't', params: {} } },
    )
    expect(calls.map(c => c.channel)).toEqual(['email'])
    expect(results.map(r => r.channel)).toEqual(['email'])
  })

  it('skips a channel when its payload is absent even if configured', async () => {
    const { transport, calls } = recorder()
    const results = await notifyOrderPlaced(transport,
      { telegram: { token: 'T', chatId: 'C' }, email: { serviceId: 'S', publicKey: 'K' } },
      { telegram: { text: 'hi' } }, // no email payload
    )
    expect(calls.map(c => c.channel)).toEqual(['telegram'])
    expect(results).toEqual([{ channel: 'telegram', ok: true }])
  })

  it('reports a failed channel without throwing or blocking the other', async () => {
    const { transport } = recorder({ telegram: true })
    const results = await notifyOrderPlaced(transport,
      { telegram: { token: 'T', chatId: 'C' }, email: { serviceId: 'S', publicKey: 'K' } },
      { telegram: { text: 'hi' }, email: { templateId: 't', params: {} } },
    )
    expect(results).toEqual([
      { channel: 'telegram', ok: false, error: 'tg down' },
      { channel: 'email', ok: true },
    ])
  })
})

describe('notifyOrderShipped', () => {
  it('sends the shipping email when configured', async () => {
    const { transport, calls } = recorder()
    const results = await notifyOrderShipped(transport,
      { email: { serviceId: 'S', publicKey: 'K' } },
      { email: { templateId: 'ship', params: { tracking_number: 'AWB1' } } },
    )
    expect(calls).toEqual([{ channel: 'email', serviceId: 'S', templateId: 'ship', params: { tracking_number: 'AWB1' }, publicKey: 'K' }])
    expect(results).toEqual([{ channel: 'email', ok: true }])
  })

  it('returns no results when nothing is configured', async () => {
    const { transport } = recorder()
    expect(await notifyOrderShipped(transport, {}, {})).toEqual([])
  })
})
