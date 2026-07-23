import type { Merchant } from '../types'

export interface OnboardingState {
  product: boolean
  shipping: boolean
  link: boolean
  doneCount: number
  allDone: boolean
}

// Derives the three onboarding checklist steps. `product` is read from the live
// product count; `shipping` and `link` are persisted flags on the merchant row —
// read `=== true` so an absent (undefined) column is false, never truthy.
export function onboardingSteps(merchant: Merchant, productCount: number): OnboardingState {
  const product = productCount > 0
  const shipping = merchant.onboarding_shipping_set === true
  const link = merchant.onboarding_link_shared === true
  const doneCount = [product, shipping, link].filter(Boolean).length
  return { product, shipping, link, doneCount, allDone: doneCount === 3 }
}
