import { describe, it, expect } from 'vitest'
import { isDirty } from './settingsDirty'

describe('isDirty', () => {
  it('identical values → not dirty', () => {
    expect(isDirty({ wm: '8', em: '18' }, { wm: '8', em: '18' })).toBe(false)
  })

  it('a single field differing → dirty', () => {
    expect(isDirty({ wm: '8', em: '18' }, { wm: '9', em: '18' })).toBe(true)
    expect(isDirty({ wm: '8', em: '18' }, { wm: '8', em: '20' })).toBe(true)
  })

  it('empty snapshots → not dirty', () => {
    expect(isDirty({}, {})).toBe(false)
  })

  it('missing key treated as empty string', () => {
    expect(isDirty({ bank: '' }, {})).toBe(false)
    expect(isDirty({}, { bank: '' })).toBe(false)
    expect(isDirty({}, { bank: 'x' })).toBe(true)
  })

  it('whitespace and case count as a difference', () => {
    expect(isDirty({ note: 'pay' }, { note: 'pay ' })).toBe(true)
    expect(isDirty({ note: 'Pay' }, { note: 'pay' })).toBe(true)
  })

  it('per-tab field sets are evaluated independently', () => {
    // Notifications tab fields — unrelated to shipping fields
    const savedNotif = { tgToken: 'abc', tgChat: '123' }
    expect(isDirty(savedNotif, { tgToken: 'abc', tgChat: '123' })).toBe(false)
    expect(isDirty(savedNotif, { tgToken: 'abc', tgChat: '999' })).toBe(true)
  })
})
