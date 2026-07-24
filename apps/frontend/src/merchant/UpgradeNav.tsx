import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'

// One way to say "take me to Settings → Subscription", available to every Pro lock in the
// dashboard (#112). The locks live in three unrelated places — the Vouchers section, the
// Notifications tab, the product form's promo fields — so threading a callback through all of
// them would be plumbing; this mirrors NavGuard, which solved the same shape of problem.
//
// Why a destination at all, rather than each lock opening the billing portal directly: the
// portal 404s for a shop with no Stripe customer, and a merchant deciding whether to pay
// deserves the price and the feature list first. The tab is that screen.

interface UpgradeNavValue {
  /** Navigate to Settings → Subscription, honouring the unsaved-changes guard. */
  goToSubscription: () => void
}

const Ctx = createContext<UpgradeNavValue | null>(null)

export function useUpgradeNav(): UpgradeNavValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useUpgradeNav must be used within UpgradeNavProvider')
  return v
}

/**
 * `navigate` is the Dashboard's GUARDED move: it raises the unsaved-changes confirm first and,
 * only if the merchant lets the navigation happen, writes the destination hash, switches section
 * and remounts the settings subtree — which is how the new sub-tab is picked up, since
 * ShopSettings reads its tab from the hash on mount. Everything after the confirm is the
 * Dashboard's business; this provider only names the destination.
 */
export function UpgradeNavProvider({
  navigate,
  children,
}: {
  navigate: (sub: string) => void
  children: ReactNode
}) {
  const goToSubscription = useCallback(() => navigate('subscription'), [navigate])
  const value = useMemo(() => ({ goToSubscription }), [goToSubscription])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
