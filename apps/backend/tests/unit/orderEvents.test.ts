import { describe, it, expect } from 'vitest'
import { orderPatchEvents } from '../../src/orderEvents.js'

// What a merchant PATCH of an order turns into on the order log. One event per field that
// actually changed, and none for a field written back to the value it already had — a retried
// patch must stay a no-op on the log as well as on the row.
describe('orderPatchEvents', () => {
  const before = { status: 'new', note: null, courier: null, awb: null, fulfil_date: '2026-07-21' }

  it('records a status move with both ends', () => {
    expect(orderPatchEvents(before, { status: 'preparing' })).toEqual([
      { kind: 'status_changed', detail: { from: 'new', to: 'preparing' } },
    ])
  })

  it('records nothing for a status written back unchanged', () => {
    expect(orderPatchEvents(before, { status: 'new' })).toEqual([])
  })

  it('reads a null status as new, the way the rest of the backend does', () => {
    expect(orderPatchEvents({ ...before, status: null }, { status: 'new' })).toEqual([])
    expect(orderPatchEvents({ ...before, status: null }, { status: 'ready' })).toEqual([
      { kind: 'status_changed', detail: { from: 'new', to: 'ready' } },
    ])
  })

  it('records that a note changed, and never the note itself', () => {
    expect(orderPatchEvents(before, { note: 'call before delivery' })).toEqual([
      { kind: 'note_changed', detail: {} },
    ])
  })

  it('treats a cleared note and a missing note as the same note', () => {
    expect(orderPatchEvents({ ...before, note: null }, { note: null })).toEqual([])
  })

  it('records tracking changes with both ends', () => {
    expect(orderPatchEvents(before, { courier: 'jnt', awb: 'JT123' })).toEqual([
      { kind: 'courier_changed', detail: { from: null, to: 'jnt' } },
      { kind: 'awb_changed', detail: { from: null, to: 'JT123' } },
    ])
  })

  it('records only the fields that moved in a mixed patch', () => {
    expect(orderPatchEvents({ ...before, courier: 'jnt' }, { status: 'ready', courier: 'jnt', awb: 'JT123' })).toEqual([
      { kind: 'status_changed', detail: { from: 'new', to: 'ready' } },
      { kind: 'awb_changed', detail: { from: null, to: 'JT123' } },
    ])
  })

  it('records a date move with both ends, and nothing for a date written back unchanged', () => {
    expect(orderPatchEvents(before, { fulfil_date: '2026-07-25' })).toEqual([
      { kind: 'fulfil_date_changed', detail: { from: '2026-07-21', to: '2026-07-25' } },
    ])
    expect(orderPatchEvents(before, { fulfil_date: '2026-07-21' })).toEqual([])
  })

  it('records a legacy order gaining its first date as a move from nothing', () => {
    expect(orderPatchEvents({ ...before, fulfil_date: null }, { fulfil_date: '2026-07-25' })).toEqual([
      { kind: 'fulfil_date_changed', detail: { from: null, to: '2026-07-25' } },
    ])
  })
})
