// Pure banner-state derivation for the merchant dashboard billing banner.
// Mirrors the Order pricing discipline: the billing row and the clock are
// passed in, no I/O. The component renders; this module decides.

export interface BillingSnapshot {
  status?: string | null
  trial_ends_at?: string | null
}

export type BannerState =
  | { kind: 'none' }
  | { kind: 'trial'; urgent: boolean; daysLeft: number; hoursLeft: number }
  | { kind: 'past-due' }

const HOUR = 3_600_000
const DAY = 24 * HOUR
export const URGENT_WINDOW_MS = 72 * HOUR

export function billingBannerState(
  billing: BillingSnapshot | null | undefined,
  now: Date,
): BannerState {
  if (!billing) return { kind: 'none' }
  if (billing.status === 'past_due') return { kind: 'past-due' }
  if (billing.status !== 'trialing' || !billing.trial_ends_at) return { kind: 'none' }
  const msLeft = Math.max(0, new Date(billing.trial_ends_at).getTime() - now.getTime())
  return {
    kind: 'trial',
    urgent: msLeft <= URGENT_WINDOW_MS,
    daysLeft: Math.floor(msLeft / DAY),
    hoursLeft: Math.floor((msLeft % DAY) / HOUR),
  }
}
