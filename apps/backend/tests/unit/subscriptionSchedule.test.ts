import { describe, it, expect } from 'vitest'
import { downgradePhases, ScheduleError } from '../../src/subscriptionSchedule.js'

const PRO = 'price_pro_monthly'
const BASIC = 'price_basic_monthly'

// Unix seconds — Stripe's unit for phase boundaries.
const START = 1_754_006_400 // 2025-08-01
const END = 1_756_684_800 // 2025-09-01

const livePhase = (over: Record<string, unknown> = {}) => ({
  start_date: START,
  end_date: END,
  items: [{ price: PRO }],
  ...over,
})

describe('downgradePhases', () => {
  // THE property this whole module exists for. A downgrade must not touch what the merchant is
  // paying for right now — same price, same window — or they lose Pro features inside a period
  // they have already been charged for.
  it('leaves the paid-for period exactly as it is', () => {
    const [now] = downgradePhases(livePhase(), BASIC)
    expect(now).toMatchObject({
      start_date: START,
      end_date: END,
      items: [{ price: PRO, quantity: 1 }],
    })
  })

  // The second phase is the downgrade itself, and it begins where the paid period ends. Stripe
  // infers the start from the previous phase's end, so what matters here is the price and that
  // exactly one billing period is scheduled — the schedule releases afterwards and the
  // subscription carries on as an ordinary Basic one.
  it('schedules the target price for the period after', () => {
    const phases = downgradePhases(livePhase(), BASIC)
    expect(phases).toHaveLength(2)
    expect(phases[1]).toMatchObject({ items: [{ price: BASIC, quantity: 1 }], iterations: 1 })
  })

  // No proration anywhere: the swap happens on a period boundary, so there is nothing to
  // prorate, and a stray credit or charge here is real money moving for no reason.
  it('prorates nothing', () => {
    for (const phase of downgradePhases(livePhase(), BASIC)) {
      expect(phase.proration_behavior).toBe('none')
    }
  })

  // A trialing shop can be on Pro (approve-merchant trials whatever tier the shop declared), and
  // rebuilding phase 0 without its trial_end would END THE TRIAL EARLY — billing a merchant who
  // was promised free days, as a side effect of scheduling a downgrade.
  it('preserves a trial on the current phase', () => {
    const [now] = downgradePhases(livePhase({ trial_end: END }), BASIC)
    expect(now.trial_end).toBe(END)
  })

  it('omits trial_end entirely when there is no trial', () => {
    const [now] = downgradePhases(livePhase(), BASIC)
    expect('trial_end' in now).toBe(false)
  })

  // Scheduling a phase that changes nothing would still create a schedule on the subscription,
  // which then has to be released before anything else can touch it — a lasting side effect for
  // a no-op request.
  it('refuses to schedule a change to the price already running', () => {
    expect(() => downgradePhases(livePhase(), PRO)).toThrow(ScheduleError)
  })

  // An open-ended phase has no period end to schedule against. Guessing one would move the
  // merchant's renewal date.
  it('refuses a phase with no end date', () => {
    expect(() => downgradePhases(livePhase({ end_date: null }), BASIC)).toThrow(ScheduleError)
  })

  it('refuses a phase carrying no price', () => {
    expect(() => downgradePhases(livePhase({ items: [] }), BASIC)).toThrow(ScheduleError)
    expect(() => downgradePhases(livePhase({ items: [{ price: null }] }), BASIC)).toThrow(ScheduleError)
  })
})
