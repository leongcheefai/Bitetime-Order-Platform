/**
 * The single decision that determines whether a customer is ever asked to sign in.
 *
 * It lives here, apart from the storefront, because it is worth stating once and testing
 * against a truth table rather than being reachable only by clicking through a checkout.
 */

/**
 * What the checkout area shows a customer.
 *
 * - `pending` — the session is still resolving. Show neither the gate nor the form: a
 *               signed-in customer must never see the gate flash while their session loads.
 * - `gate`    — signed out, no choice made at this shop. The gate replaces the form.
 * - `guest`   — the guest choice was made at this shop. Form, plus a quiet "Sign in" strip.
 * - `account` — signed in. The form, plus the signed-in strip. The gate never renders.
 */
export type CheckoutStep = 'pending' | 'gate' | 'guest' | 'account'

export interface CheckoutStepInput {
  /** The auth session has not resolved yet (`account === undefined`). */
  sessionLoading: boolean
  signedIn: boolean
  /** A guest choice remembered for *this* shop, or made in this session. */
  guestChosen: boolean
}

/**
 * Deliberately blind to the cart. Gating on "has items" would mean the checkout form is on
 * screen for an empty cart and then vanishes under a customer the moment they add their first
 * item — possibly mid-keystroke, since name and WhatsApp sit in that form. The gate is a step,
 * not a reaction: it holds the same place from the first paint.
 */
export function checkoutStep({ sessionLoading, signedIn, guestChosen }: CheckoutStepInput): CheckoutStep {
  if (sessionLoading) return 'pending'
  // Signing in overrides a remembered guest choice: an account holder is never gated.
  if (signedIn) return 'account'
  return guestChosen ? 'guest' : 'gate'
}

/** Keyed by shop: a guest choice at one shop must not silence the gate at another. */
export function guestChoiceKey(slug: string): string {
  return `bitetime.guest-checkout.${slug}`
}

export function readGuestChoice(slug: string): boolean {
  try {
    return localStorage.getItem(guestChoiceKey(slug)) === '1'
  } catch {
    return false // no storage (or blocked): no remembered choice, so the gate simply fires again
  }
}

export function rememberGuestChoice(slug: string): void {
  try {
    localStorage.setItem(guestChoiceKey(slug), '1')
  } catch { /* storage unavailable — the choice still holds for this page's lifetime */ }
}
