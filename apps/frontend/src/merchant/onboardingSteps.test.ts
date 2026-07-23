import { describe, it, expect } from 'vitest'
import { onboardingSteps } from './onboardingSteps'
import type { Merchant } from '../types'

const base: Merchant = { id: 'm1', name: 'Shop', slug: 'shop', status: 'active' }

describe('onboardingSteps (#102)', () => {
  it('all three incomplete for a fresh shop', () => {
    expect(onboardingSteps(base, 0)).toEqual({
      product: false, shipping: false, link: false, doneCount: 0, allDone: false,
    })
  })

  it('product step is derived from the product count', () => {
    expect(onboardingSteps(base, 3).product).toBe(true)
    expect(onboardingSteps(base, 0).product).toBe(false)
  })

  it('shipping and link steps come from the flags', () => {
    const m = { ...base, onboarding_shipping_set: true, onboarding_link_shared: true }
    const s = onboardingSteps(m, 0)
    expect(s.shipping).toBe(true)
    expect(s.link).toBe(true)
    expect(s.doneCount).toBe(2)
    expect(s.allDone).toBe(false)
  })

  it('allDone only when all three are satisfied', () => {
    const m = { ...base, onboarding_shipping_set: true, onboarding_link_shared: true }
    const s = onboardingSteps(m, 1)
    expect(s.doneCount).toBe(3)
    expect(s.allDone).toBe(true)
  })

  it('treats absent flags as false, not truthy', () => {
    expect(onboardingSteps(base, 1)).toMatchObject({ shipping: false, link: false })
  })
})
