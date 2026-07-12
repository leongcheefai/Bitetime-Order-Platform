import { describe, it, expect } from 'vitest'
import { savedDetailsFromOrder, prefillFromProfile } from './savedDetails'
import type { AddressParts } from './types'

const address: AddressParts = { line1: '12 Jalan Bukit', postcode: '58200', city: 'Kuala Lumpur', state: 'Kuala Lumpur' }
const blank: AddressParts = { line1: '', postcode: '', city: '', state: '' }

describe('savedDetailsFromOrder', () => {
  it('saves the number from a delivery order, with the address', () => {
    expect(savedDetailsFromOrder({ mode: 'delivery', wa: '60123456789', address }))
      .toEqual({ whatsapp: '60123456789', delivery_address: address })
  })

  it('never writes the order’s name back to the account', () => {
    // The checkout name is the name for THIS ORDER — a customer ordering lunch for a colleague
    // types the colleague's. `profiles.name` is the name on their ACCOUNT. Letting one write the
    // other would rename a customer to whoever they last ordered for.
    const saved = savedDetailsFromOrder({ mode: 'delivery', wa: '60123456789', address })
    expect(saved).not.toHaveProperty('name')
  })

  it('never touches the saved address on a pickup order', () => {
    // The trap: a pickup order carries no address, so writing the form's address would blank the
    // one the customer saved on their last delivery — and they would only find out next time.
    expect(savedDetailsFromOrder({ mode: 'pickup', wa: '60123456789', address: blank }))
      .toEqual({ whatsapp: '60123456789' })
  })

  it('does not save a half-typed address from a delivery order', () => {
    const partial: AddressParts = { line1: '12 Jalan Bukit', postcode: '', city: '', state: '' }
    expect(savedDetailsFromOrder({ mode: 'delivery', wa: '60123456789', address: partial }))
      .toEqual({ whatsapp: '60123456789' })
  })

  it('trims what it saves — a stray space must not come back as a prefill', () => {
    expect(savedDetailsFromOrder({ mode: 'pickup', wa: ' 60123456789 ', address: blank }))
      .toEqual({ whatsapp: '60123456789' })
  })

  it('saves nothing it does not have', () => {
    expect(savedDetailsFromOrder({ mode: 'pickup', wa: '', address: blank })).toEqual({})
  })
})

describe('prefillFromProfile', () => {
  it('hands back the saved name, number and address', () => {
    expect(prefillFromProfile({ name: 'Ah Meng', whatsapp: '60123456789', delivery_address: address } as any))
      .toEqual({ name: 'Ah Meng', wa: '60123456789', address })
  })

  it('prefills nothing for a customer with nothing saved yet', () => {
    expect(prefillFromProfile({ id: 'p1' } as any)).toEqual({})
    expect(prefillFromProfile(null)).toEqual({})
  })

  it('ignores an address that is not the shape the form expects', () => {
    // `delivery_address` is jsonb — it will hold whatever was last written to it, and an older
    // shape (a plain string, from before the address was split into parts) must not reach the
    // form as `{line1: undefined}` and quietly wipe what the customer sees.
    expect(prefillFromProfile({ delivery_address: '12 Jalan Bukit, KL' } as any)).toEqual({})
    expect(prefillFromProfile({ delivery_address: { line1: 12 } } as any)).toEqual({})
  })

  it('carries a partial saved address through as far as it goes', () => {
    const partial = { line1: '12 Jalan Bukit', postcode: '', city: '', state: '' }
    expect(prefillFromProfile({ delivery_address: partial } as any)).toEqual({ address: partial })
  })
})
