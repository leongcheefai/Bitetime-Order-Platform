import { describe, it, expect } from 'vitest'
import type { SupportMessage } from '@bitetime/shared'
import { pollDelay, mergeMessages, POLL_OPEN_MS, POLL_CLOSED_MS } from './supportFeed'

const msg = (id: string, created_at: string, sender: 'merchant' | 'admin' = 'merchant'): SupportMessage =>
  ({ id, sender, body: id, image_count: 0, created_at })

describe('pollDelay', () => {
  it('polls fast while open, slowly while closed, and never while hidden', () => {
    expect(pollDelay({ open: true, hidden: false })).toBe(POLL_OPEN_MS)
    expect(pollDelay({ open: false, hidden: false })).toBe(POLL_CLOSED_MS)
    expect(pollDelay({ open: true, hidden: true })).toBeNull()
    expect(pollDelay({ open: false, hidden: true })).toBeNull()
  })
})

describe('mergeMessages', () => {
  it('appends new messages in time order', () => {
    const a = msg('a', '2026-10-02T10:00:00.000Z')
    const b = msg('b', '2026-10-02T10:01:00.000Z', 'admin')
    expect(mergeMessages([a], [b])).toEqual([a, b])
  })

  it('shows a message once when the send response and a poll both carry it', () => {
    const a = msg('a', '2026-10-02T10:00:00.000Z')
    const mine = msg('mine', '2026-10-02T10:02:00.000Z')
    expect(mergeMessages(mergeMessages([a], [mine]), [mine])).toEqual([a, mine])
  })

  it('keeps a reply that landed before my own message, in its place', () => {
    // My send returned first; the poll then brings the reply AND my message.
    const mine = msg('mine', '2026-10-02T10:02:00.000Z')
    const reply = msg('reply', '2026-10-02T10:01:30.000Z', 'admin')
    expect(mergeMessages([mine], [reply, mine]).map(m => m.id)).toEqual(['reply', 'mine'])
  })

  it('returns the same array when nothing is new, so React skips a render', () => {
    const a = msg('a', '2026-10-02T10:00:00.000Z')
    const current = [a]
    expect(mergeMessages(current, [a])).toBe(current)
    expect(mergeMessages(current, [])).toBe(current)
  })
})
