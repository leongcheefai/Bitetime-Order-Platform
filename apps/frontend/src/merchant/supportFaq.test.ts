import { describe, it, expect } from 'vitest'
import { SUPPORT_FAQ } from './supportFaq'

// The dashboard's own section and Settings sub-tab keys (Dashboard.tsx SECTIONS, ShopSettings.tsx
// tabs). A link to a key that does not exist lands the merchant on Overview with no explanation.
const SECTIONS = ['overview', 'orders', 'products', 'storefront', 'vouchers', 'customers', 'settings']
const SETTINGS_SUBS = ['shipping', 'fulfilment', 'payment', 'brand', 'marketing', 'notifications', 'subscription', 'referral', 'devices']

describe('SUPPORT_FAQ', () => {
  const items = SUPPORT_FAQ.flatMap(g => g.items)

  it('has groups, and every group has at least one question', () => {
    expect(SUPPORT_FAQ.length).toBeGreaterThan(0)
    for (const g of SUPPORT_FAQ) expect(g.items.length).toBeGreaterThan(0)
  })

  it('gives every title, question and answer both languages', () => {
    for (const g of SUPPORT_FAQ) {
      expect(g.title.en.trim()).not.toBe('')
      expect(g.title.zh.trim()).not.toBe('')
    }
    for (const i of items) {
      for (const text of [i.q.en, i.q.zh, i.a.en, i.a.zh]) expect(text.trim()).not.toBe('')
    }
  })

  it('uses unique ids', () => {
    const ids = [...SUPPORT_FAQ.map(g => g.id), ...items.map(i => i.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('links only to sections and sub-tabs that exist', () => {
    for (const i of items) {
      if (!i.link) continue
      expect(SECTIONS).toContain(i.link.section)
      if (i.link.sub) {
        expect(i.link.section).toBe('settings')
        expect(SETTINGS_SUBS).toContain(i.link.sub)
      }
    }
  })
})
