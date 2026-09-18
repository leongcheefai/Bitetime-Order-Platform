import { describe, it, expect } from 'vitest'
import { DEFAULT_FULFILMENT, type FulfilmentConfig } from '@bitetime/shared'
import { judgeSlotPatch } from '../../src/orderSlotPatch.js'

const KL = 'Asia/Kuala_Lumpur'
const NOON_MYT = new Date('2026-07-20T04:00:00Z') // Monday 12:00 in KL
const ON: FulfilmentConfig = {
  ...DEFAULT_FULFILMENT,
  slots_enabled: true,
  hours: Array.from({ length: 7 }, () => ({ open: '10:00', close: '14:00' })),
}
const OFF: FulfilmentConfig = { ...ON, slots_enabled: false }
const before = (over: Partial<{ fulfil_date: string | null; fulfil_time_from: string | null; fulfil_time_to: string | null }> = {}) => ({
  fulfil_date: '2026-07-21', fulfil_time_from: '10:00', fulfil_time_to: '11:00', ...over,
})

describe('judgeSlotPatch', () => {
  it('passes a patch that names neither date nor slot', () => {
    expect(judgeSlotPatch(before(), { note: 'x' }, ON, KL, NOON_MYT)).toBeNull()
  })

  it('accepts an open slot and refuses a closed one on a slot shop', () => {
    expect(judgeSlotPatch(before(), { fulfil_time_from: '13:00', fulfil_time_to: '14:00' }, ON, KL, NOON_MYT)).toBeNull()
    expect(judgeSlotPatch(before(), { fulfil_time_from: '14:00', fulfil_time_to: '15:00' }, ON, KL, NOON_MYT)).toBe('fulfil_time_unavailable')
  })

  it('refuses clearing the slot on a slot shop, allows it on a shop with slots off', () => {
    expect(judgeSlotPatch(before(), { fulfil_time_from: null, fulfil_time_to: null }, ON, KL, NOON_MYT)).toBe('fulfil_time_unavailable')
    expect(judgeSlotPatch(before(), { fulfil_time_from: null, fulfil_time_to: null }, OFF, KL, NOON_MYT)).toBeNull()
  })

  it('on a shop with slots off, accepts the identical slot as a no-op but refuses a new one', () => {
    expect(judgeSlotPatch(before(), { fulfil_time_from: '10:00', fulfil_time_to: '11:00' }, OFF, KL, NOON_MYT)).toBeNull()
    expect(judgeSlotPatch(before(), { fulfil_time_from: '12:00', fulfil_time_to: '13:00' }, OFF, KL, NOON_MYT)).toBe('fulfil_time_unavailable')
  })

  it('judges a date move against the slot the row keeps', () => {
    // Wednesday is open 10–14 too: the kept 10:00 slot is fine.
    expect(judgeSlotPatch(before(), { fulfil_date: '2026-07-22' }, ON, KL, NOON_MYT)).toBeNull()
    // Thursday closed: the kept slot is not open there.
    const thuClosed = { ...ON, hours: ON.hours.map((h, i) => (i === 4 ? null : h)) }
    expect(judgeSlotPatch(before(), { fulfil_date: '2026-07-23' }, thuClosed, KL, NOON_MYT)).toBe('fulfil_time_unavailable')
  })

  it('judges a date move with a new slot against the NEW date', () => {
    const thuShort = { ...ON, hours: ON.hours.map((h, i) => (i === 4 ? { open: '12:00', close: '14:00' } : h)) }
    expect(judgeSlotPatch(before(), { fulfil_date: '2026-07-23', fulfil_time_from: '10:00', fulfil_time_to: '11:00' }, thuShort, KL, NOON_MYT)).toBe('fulfil_time_unavailable')
    expect(judgeSlotPatch(before(), { fulfil_date: '2026-07-23', fulfil_time_from: '12:00', fulfil_time_to: '13:00' }, thuShort, KL, NOON_MYT)).toBeNull()
  })

  it('lets a legacy order with no slot move its date at a slot shop without gaining one', () => {
    expect(judgeSlotPatch(before({ fulfil_time_from: null, fulfil_time_to: null }), { fulfil_date: '2026-07-22' }, ON, KL, NOON_MYT)).toBeNull()
  })

  it('refuses a slot on an order that has no date to judge it against', () => {
    expect(judgeSlotPatch(before({ fulfil_date: null }), { fulfil_time_from: '10:00', fulfil_time_to: '11:00' }, ON, KL, NOON_MYT)).toBe('fulfil_time_unavailable')
  })
})
