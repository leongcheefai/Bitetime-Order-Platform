// Pure banner-state derivation for the merchant dashboard billing banner.
// Mirrors the Order pricing discipline: the billing row and the clock are
// passed in, no I/O. The component renders; this module decides.

export interface BillingSnapshot {
  status?: string | null
  trial_ends_at?: string | null
  has_payment_method?: boolean | null
  /** The merchant has cancelled; the subscription runs to `current_period_end` and stops. */
  cancel_at_period_end?: boolean | null
  current_period_end?: string | null
}

export type BannerState =
  | { kind: 'none' }
  | { kind: 'trial'; urgent: boolean; hasPaymentMethod: boolean; daysLeft: number; hoursLeft: number }
  | { kind: 'past-due' }
  /** Cancelled and winding down. The shop is suspended when `endsAt` passes. */
  | { kind: 'ending'; endsAt: string | null }

const HOUR = 3_600_000
const DAY = 24 * HOUR
export const URGENT_WINDOW_MS = 72 * HOUR

export function billingBannerState(
  billing: BillingSnapshot | null | undefined,
  now: Date,
): BannerState {
  if (!billing) return { kind: 'none' }
  // Ahead of everything else, including past-due. A cancelled subscription still reports
  // `status: 'trialing'` or `'active'`, so without this the banner went on counting down a trial
  // and telling a merchant who had just cancelled to ADD A PAYMENT METHOD — asking for a card
  // to keep a subscription they had chosen to end.
  if (billing.cancel_at_period_end) {
    return { kind: 'ending', endsAt: billing.current_period_end ?? null }
  }
  if (billing.status === 'past_due') return { kind: 'past-due' }
  if (billing.status !== 'trialing' || !billing.trial_ends_at) return { kind: 'none' }
  const msLeft = Math.max(0, new Date(billing.trial_ends_at).getTime() - now.getTime())
  // A card on file means the trial converts on its own — never nag, never go urgent.
  const hasPaymentMethod = !!billing.has_payment_method
  return {
    kind: 'trial',
    urgent: !hasPaymentMethod && msLeft <= URGENT_WINDOW_MS,
    hasPaymentMethod,
    daysLeft: Math.floor(msLeft / DAY),
    hoursLeft: Math.floor((msLeft % DAY) / HOUR),
  }
}
