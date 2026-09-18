import { describe, it, expect } from 'vitest'
import { submitGate, type SubmitGateInput } from './submitGate'

/** A pickup order that is ready to go. Every test below spoils exactly one thing. */
const base: SubmitGateInput = {
  lineCount: 1,
  name: 'Aminah',
  wa: '60123456789',
  mode: 'pickup',
  address: { line1: '', postcode: '', city: '', state: '' },
  distanceUsable: false,
  quoted: false,
  chosenDate: '2026-07-26',
  slotRequired: false,
  chosenSlot: null,
  noMethods: false,
  busy: false,
}

const gate = (over: Partial<SubmitGateInput> = {}) => submitGate({ ...base, ...over })

const REGION_ADDRESS = { line1: '12 Jalan Ampang', postcode: '50450', city: 'Kuala Lumpur', state: 'Selangor' }
const region = (over: Partial<SubmitGateInput> = {}) =>
  gate({ mode: 'delivery', address: REGION_ADDRESS, ...over })
const express = (over: Partial<SubmitGateInput> = {}) =>
  gate({ mode: 'express', distanceUsable: true, quoted: true, address: { ...REGION_ADDRESS }, ...over })

describe('deliveryReady', () => {
  it('asks nothing of a pickup order', () => {
    expect(gate({ address: { line1: '', postcode: '', city: '', state: '' } }).deliveryReady).toBe(true)
  })

  it('requires a full region address for delivery', () => {
    expect(region().deliveryReady).toBe(true)
    for (const missing of ['line1', 'city', 'state'] as const) {
      expect(region({ address: { ...REGION_ADDRESS, [missing]: '   ' } }).deliveryReady).toBe(false)
    }
  })

  it('refuses a delivery with no state', () => {
    // Load-bearing for the PRICE, not just for form validity. The summary shows the WM base rate
    // before a state is known; the backend derives its region FROM the state and refuses an order
    // that has none (`delivery_state_required`). This gate is what keeps the placeholder from
    // becoming a promise.
    expect(region({ address: { ...REGION_ADDRESS, state: '' } }).deliveryReady).toBe(false)
  })

  it('requires a five-digit postcode, not merely a non-empty one', () => {
    expect(region({ address: { ...REGION_ADDRESS, postcode: '5045' } }).deliveryReady).toBe(false)
  })

  it('requires an express order to have been quoted', () => {
    // Story 38: the only thing stopping an order the shop would have to cancel. An address typed
    // but never picked from the suggestions has no place id, so it can never have been quoted.
    expect(express().deliveryReady).toBe(true)
    expect(express({ quoted: false }).deliveryReady).toBe(false)
  })

  it('refuses express outright when the shop cannot price a distance', () => {
    // `ShopDistance.usable` false is a REFUSAL, NOT A FALLBACK — never a slide back to the region
    // form's rules. A quote cannot exist in this state, and neither can a submittable order.
    expect(express({ distanceUsable: false, quoted: false }).deliveryReady).toBe(false)
    // Even handed a quote, which the form has no way to produce here.
    expect(express({ distanceUsable: false, quoted: true }).deliveryReady).toBe(false)
  })

  it('does not let a region-complete address stand in for an express quote', () => {
    // The two branches are separate rules. A customer who filled the delivery form and switched to
    // Express is carrying a postcode, city and state that say nothing about whether a fee exists.
    expect(express({ quoted: false, address: REGION_ADDRESS }).deliveryReady).toBe(false)
  })
})

describe('canSubmit', () => {
  it('lets a complete order through', () => {
    expect(gate().canSubmit).toBe(true)
    expect(region().canSubmit).toBe(true)
    expect(express().canSubmit).toBe(true)
  })

  it('refuses an empty cart', () => {
    // Priced LINES, not cart keys: a cart holding only ids the menu no longer sells prices to
    // nothing, and `adoptProducts` is what removes them.
    expect(gate({ lineCount: 0 }).canSubmit).toBe(false)
  })

  it('refuses blank contact details', () => {
    expect(gate({ name: '   ' }).canSubmit).toBe(false)
    expect(gate({ wa: '   ' }).canSubmit).toBe(false)
  })

  it('refuses an order with no date', () => {
    // `chosenDate` is already null once the shop stops offering the date that was picked, so a
    // checkout left open past midnight cannot submit yesterday's choice.
    expect(gate({ chosenDate: null }).canSubmit).toBe(false)
  })

  it('refuses a shop that offers no fulfilment method', () => {
    expect(gate({ noMethods: true }).canSubmit).toBe(false)
  })

  it('refuses while a submission is in flight', () => {
    // The double-submit guard. It lives here so the button and `handleSubmit` ask one question.
    expect(gate({ busy: true }).canSubmit).toBe(false)
  })

  it('refuses whenever the address is not ready', () => {
    expect(region({ address: { ...REGION_ADDRESS, state: '' } }).canSubmit).toBe(false)
    expect(express({ quoted: false }).canSubmit).toBe(false)
  })
})

describe('time slot (#282)', () => {
  it('asks nothing of a shop with slots off', () => {
    expect(gate({ slotRequired: false, chosenSlot: null }).canSubmit).toBe(true)
  })
  it('needs a chosen slot at a slot shop', () => {
    expect(gate({ slotRequired: true, chosenSlot: null }).canSubmit).toBe(false)
    expect(gate({ slotRequired: true, chosenSlot: { from: '10:00', to: '11:00' } }).canSubmit).toBe(true)
  })
})
