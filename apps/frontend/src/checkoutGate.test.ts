import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { checkoutStep, guestChoiceKey, readGuestChoice, rememberGuestChoice } from './checkoutGate'
import type { CheckoutStep, CheckoutStepInput } from './checkoutGate'

describe('checkoutStep', () => {
  // The whole truth table, every row, stated once. Three booleans, eight rows, no gaps —
  // this is the only decision that says whether a customer is ever asked to sign in.
  const TRUTH_TABLE: Array<[CheckoutStepInput, CheckoutStep, string]> = [
    // A resolving session pre-empts everything: the gate must not flash for a signed-in
    // customer while their session loads, and a remembered guest choice must not pre-empt it.
    [{ sessionLoading: true, signedIn: false, guestChosen: false }, 'pending', 'session resolving'],
    [{ sessionLoading: true, signedIn: false, guestChosen: true }, 'pending', 'session resolving, guest remembered'],
    [{ sessionLoading: true, signedIn: true, guestChosen: false }, 'pending', 'session resolving, signed in'],
    [{ sessionLoading: true, signedIn: true, guestChosen: true }, 'pending', 'session resolving, signed in, guest remembered'],

    // Signing in overrides a guest choice remembered at this shop. It is never re-litigated.
    [{ sessionLoading: false, signedIn: true, guestChosen: false }, 'account', 'signed in'],
    [{ sessionLoading: false, signedIn: true, guestChosen: true }, 'account', 'signed in, having once chosen guest here'],

    [{ sessionLoading: false, signedIn: false, guestChosen: false }, 'gate', 'first-time guest'],
    [{ sessionLoading: false, signedIn: false, guestChosen: true }, 'guest', 'returning guest'],
  ]

  it.each(TRUTH_TABLE)('%j → %s (%s)', (input, expected) => {
    expect(checkoutStep(input)).toBe(expected)
  })

  it('covers every combination — 2³ rows, none missing', () => {
    const rows = new Set(TRUTH_TABLE.map(([i]) => `${i.sessionLoading}${i.signedIn}${i.guestChosen}`))
    expect(rows.size).toBe(8)
  })
})

describe('guestChoiceKey', () => {
  it('is scoped per shop — a choice at one shop cannot silence the gate at another', () => {
    expect(guestChoiceKey('cookie-lab')).not.toBe(guestChoiceKey('kopi-corner'))
  })

  it('is stable for the same shop', () => {
    expect(guestChoiceKey('cookie-lab')).toBe(guestChoiceKey('cookie-lab'))
  })
})

describe('remembered guest choice', () => {
  const store = new Map<string, string>()
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }

  beforeEach(() => {
    store.clear()
    ;(globalThis as any).localStorage = fake
  })
  afterEach(() => {
    delete (globalThis as any).localStorage
  })

  it('round-trips a choice for the shop it was made at', () => {
    expect(readGuestChoice('cookie-lab')).toBe(false)
    rememberGuestChoice('cookie-lab')
    expect(readGuestChoice('cookie-lab')).toBe(true)
  })

  it('does not leak the choice to another shop', () => {
    rememberGuestChoice('cookie-lab')
    expect(readGuestChoice('kopi-corner')).toBe(false)
  })

  it('treats unavailable storage as no choice made, never as a crash', () => {
    // Private-mode Safari throws on write, and the node/SSR case has no localStorage at all.
    // Either way the honest answer is "no remembered choice" — the gate simply fires again.
    delete (globalThis as any).localStorage
    expect(readGuestChoice('cookie-lab')).toBe(false)
    expect(() => rememberGuestChoice('cookie-lab')).not.toThrow()

    ;(globalThis as any).localStorage = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(readGuestChoice('cookie-lab')).toBe(false)
    expect(() => rememberGuestChoice('cookie-lab')).not.toThrow()
  })
})
