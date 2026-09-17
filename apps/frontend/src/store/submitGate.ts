import type { FulfilmentMethod, Slot } from '@bitetime/shared'

/**
 * Whether this order may be placed — the decision the Place Order button is disabled by and
 * `handleSubmit` refuses on.
 *
 * It used to be two expressions in `Storefront.tsx`'s render scope, derived inline from a dozen
 * component values, so the only way to ask "can this order be placed" was to mount a storefront
 * and drive it. It is the highest-stakes boolean in the browser: it is the last thing standing
 * between a customer and an order the shop would have to cancel.
 *
 * FRONTEND-ONLY, deliberately not in `@bitetime/shared`. The backend has its own gate and it must
 * keep having one — but it gates the order BODY inside the transaction, from the shop's own rows,
 * while this gates a half-filled FORM. Same intent, different inputs; sharing them would be one
 * rule pretending to be two. What IS shared is the pricing this gate protects.
 */
export interface SubmitGateInput {
  /** Priced lines, not raw cart entries: a cart holding only ids the menu no longer sells is empty. */
  readonly lineCount: number
  readonly name: string
  readonly wa: string
  readonly mode: FulfilmentMethod
  /** The address as the form currently holds it. */
  readonly address: { readonly line1: string; readonly postcode: string; readonly city: string; readonly state: string }
  /** Express is offered AND the shop's distance config can price it. FALSE IS A REFUSAL, NOT A FALLBACK. */
  readonly distanceUsable: boolean
  /** A fee has come back for the address currently in the form — `quoteMachine.selectQuote() !== null`. */
  readonly quoted: boolean
  /** The chosen date, still one the shop offers. `null` once it stops being offered. */
  readonly chosenDate: string | null
  /** The shop asks for a time slot (#282). */
  readonly slotRequired: boolean
  /** The chosen slot, still one the shop offers on the chosen date. `null` once it stops being offered. */
  readonly chosenSlot: Slot | null
  /** The shop offers no fulfilment method at all. Unconstructible past the DB CHECK; refused anyway. */
  readonly noMethods: boolean
  /** A submission is already in flight. */
  readonly busy: boolean
}

export interface SubmitGate {
  /**
   * The address is complete enough to CHARGE for, not merely to display.
   *
   * Load-bearing for the PRICE. A `delivery` order with no state still shows a fee — the WM base
   * rate, so the summary matches the toggle instead of flashing zero — but the backend derives
   * its region from the state and refuses an order that has none (`delivery_state_required`).
   * This is the only thing stopping that placeholder from becoming a promise. Weaken it and the
   * two sides of the wire diverge.
   */
  readonly deliveryReady: boolean
  readonly canSubmit: boolean
}

export function submitGate(input: SubmitGateInput): SubmitGate {
  const { mode, address, distanceUsable, quoted } = input

  const deliveryReady =
    mode === 'pickup'
      ? true
      : mode === 'express'
        // At a priceable express shop the address must have been SELECTED from the suggestions
        // (which is what gives it a place id) and a fee must have come back for it. `distanceUsable`
        // false refuses outright — the form renders no address field in that state, so there is
        // nothing here that could become ready.
        ? distanceUsable && quoted && address.line1.trim() !== ''
        : address.line1.trim() !== '' &&
          address.postcode.length === 5 &&
          address.city.trim() !== '' &&
          address.state.trim() !== ''

  const canSubmit =
    input.lineCount > 0 &&
    input.name.trim() !== '' &&
    input.wa.trim() !== '' &&
    // `busy` lives INSIDE the gate rather than beside it. It is the double-submit guard, and both
    // the button's `disabled` and `handleSubmit`'s own first line ask this one question — two
    // places asking two slightly different ones is how a second order gets placed on a double tap.
    !input.busy &&
    deliveryReady &&
    input.chosenDate !== null &&
    (!input.slotRequired || input.chosenSlot !== null) &&
    !input.noMethods

  return { deliveryReady, canSubmit }
}
