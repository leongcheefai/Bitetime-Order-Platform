import { describe, it, expect } from 'vitest'
import { BUSINESS_NATURES, SHOP_DESCRIPTION_MAX } from '@bitetime/shared'
import { pickMerchantConfig, pickOrderFields, pickProductFields } from '../../src/writes.js'

// The shop being written. Only `payment_qr` is judged against it (a Storage path belongs to one
// merchant's folder); every other field in this file is tenant-agnostic, so these cases pass the
// same stand-in rather than one id each.
const SHOP = '33333333-3333-3333-3333-333333333333'

describe('pickMerchantConfig — fulfilment', () => {
  it('accepts a config bag and a real timezone', () => {
    expect(pickMerchantConfig({
      config: { fulfilment: { lead_days: 1, window_days: 7, closed_weekdays: [1] } },
      timezone: 'Asia/Kuala_Lumpur',
    }, SHOP)).toEqual({
      ok: true,
      patch: {
        config: { fulfilment: { lead_days: 1, window_days: 7, closed_weekdays: [1] } },
        timezone: 'Asia/Kuala_Lumpur',
      },
    })
  })

  it('drops a timezone Intl cannot parse rather than writing it', () => {
    expect(pickMerchantConfig({ timezone: 'Mars/Olympus' }, SHOP)).toEqual({ ok: true, patch: {} })
  })

  it('still refuses the privilege columns', () => {
    expect(pickMerchantConfig({ status: 'active', owner_id: 'x', slug: 'y', billing_cycle: 'yearly' }, SHOP)).toEqual({ ok: true, patch: {} })
  })
})

describe('pickMerchantConfig — tax (#88)', () => {
  it('accepts a valid enabled + rate pair', () => {
    expect(pickMerchantConfig({ tax_enabled: true, tax_rate: 6 }, SHOP)).toEqual({
      ok: true,
      patch: { tax_enabled: true, tax_rate: 6 },
    })
  })

  it('coerces a numeric-string rate (PATCH bodies can carry either)', () => {
    expect(pickMerchantConfig({ tax_rate: '6' }, SHOP)).toEqual({ ok: true, patch: { tax_rate: 6 } })
  })

  it('refuses a rate above 100 rather than clamping it', () => {
    expect(pickMerchantConfig({ tax_rate: 150 }, SHOP)).toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a negative rate', () => {
    expect(pickMerchantConfig({ tax_rate: -1 }, SHOP)).toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a non-numeric rate', () => {
    expect(pickMerchantConfig({ tax_rate: 'six' }, SHOP)).toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a blank rate rather than coercing it to 0', () => {
    expect(pickMerchantConfig({ tax_rate: '' }, SHOP)).toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a whitespace-only rate rather than coercing it to 0', () => {
    expect(pickMerchantConfig({ tax_rate: '   ' }, SHOP)).toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a non-boolean tax_enabled', () => {
    expect(pickMerchantConfig({ tax_enabled: 'yes' }, SHOP)).toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a rate the numeric(5,2) column would round on write', () => {
    expect(pickMerchantConfig({ tax_rate: 100.005 }, SHOP)).toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a rate with more than 2 decimal places', () => {
    expect(pickMerchantConfig({ tax_rate: 6.567 }, SHOP)).toEqual({ ok: false, error: expect.any(String) })
  })

  it('accepts a rate with exactly 1 decimal place', () => {
    expect(pickMerchantConfig({ tax_rate: 6.5 }, SHOP)).toEqual({ ok: true, patch: { tax_rate: 6.5 } })
  })

  it('accepts a whole-number rate', () => {
    expect(pickMerchantConfig({ tax_rate: 6 }, SHOP)).toEqual({ ok: true, patch: { tax_rate: 6 } })
  })
})

describe('pickMerchantConfig — onboarding flags (#102)', () => {
  it('accepts the three onboarding booleans', () => {
    expect(pickMerchantConfig({
      onboarding_shipping_set: true,
      onboarding_link_shared: true,
      onboarding_dismissed: true,
    }, SHOP)).toEqual({
      ok: true,
      patch: {
        onboarding_shipping_set: true,
        onboarding_link_shared: true,
        onboarding_dismissed: true,
      },
    })
  })

  it('passes a field through untouched when absent', () => {
    expect(pickMerchantConfig({ onboarding_link_shared: true }, SHOP)).toEqual({
      ok: true,
      patch: { onboarding_link_shared: true },
    })
  })

  it('refuses a non-boolean onboarding flag rather than coercing it', () => {
    expect(pickMerchantConfig({ onboarding_shipping_set: 'yes' }, SHOP))
      .toEqual({ ok: false, error: expect.any(String) })
    expect(pickMerchantConfig({ onboarding_dismissed: 1 }, SHOP))
      .toEqual({ ok: false, error: expect.any(String) })
  })
})

describe('pickMerchantConfig — business nature is signup-only, not editable (#161)', () => {
  // business_nature is set once at signup (POST /api/merchants) and deliberately not in
  // MERCHANT_CONFIG_FIELDS, so a PATCH naming it — valid code or not — is silently ignored
  // rather than refused; the merchant simply has no field left that writes this column.
  it('ignores business_nature entirely, valid or not', () => {
    for (const code of BUSINESS_NATURES) {
      expect(pickMerchantConfig({ business_nature: code }, SHOP)).toEqual({ ok: true, patch: {} })
    }
    expect(pickMerchantConfig({ business_nature: 'cake shop' }, SHOP)).toEqual({ ok: true, patch: {} })
    expect(pickMerchantConfig({ business_nature: null }, SHOP)).toEqual({ ok: true, patch: {} })
  })

  it('still passes other fields through when business_nature rides along in the same body', () => {
    expect(pickMerchantConfig({ business_nature: 'bakery', timezone: 'Asia/Kuala_Lumpur' }, SHOP))
      .toEqual({ ok: true, patch: { timezone: 'Asia/Kuala_Lumpur' } })
  })
})

describe('pickMerchantConfig — payment QR (#156)', () => {
  const M = '11111111-1111-1111-1111-111111111111'
  const OTHER = '22222222-2222-2222-2222-222222222222'

  it('accepts a path inside the merchant\'s own Storage folder', () => {
    expect(pickMerchantConfig({ payment_qr: `${M}/abc-duitnow.png` }, M))
      .toEqual({ ok: true, patch: { payment_qr: `${M}/abc-duitnow.png` } })
  })

  it('accepts null — the only way to take the QR back down', () => {
    expect(pickMerchantConfig({ payment_qr: null }, M)).toEqual({ ok: true, patch: { payment_qr: null } })
  })

  it('reads an empty string as null rather than storing a blank path', () => {
    expect(pickMerchantConfig({ payment_qr: '' }, M)).toEqual({ ok: true, patch: { payment_qr: null } })
  })

  // The whole reason this check exists: the backend writes through the service role, so nothing
  // in Postgres stops a merchant from pointing their row at a stranger's object.
  it('refuses a path in another merchant\'s folder', () => {
    expect(pickMerchantConfig({ payment_qr: `${OTHER}/abc-duitnow.png` }, M))
      .toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a traversal that would climb out of the folder', () => {
    expect(pickMerchantConfig({ payment_qr: `${M}/../${OTHER}/qr.png` }, M))
      .toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses an absolute URL — the column holds a Storage PATH', () => {
    expect(pickMerchantConfig({ payment_qr: 'https://evil.example/qr.png' }, M))
      .toEqual({ ok: false, error: expect.any(String) })
  })

  it('refuses a non-string', () => {
    expect(pickMerchantConfig({ payment_qr: 42 }, M)).toEqual({ ok: false, error: expect.any(String) })
  })

  // The argument is required, so this is the empty-string case a caller could still reach — a
  // caller that cannot name the merchant cannot prove the path belongs to them, and the field is
  // refused rather than written unchecked.
  it('refuses a QR path when the merchant id is blank', () => {
    expect(pickMerchantConfig({ payment_qr: `${M}/qr.png` }, '')).toEqual({ ok: false, error: expect.any(String) })
  })
})

// Menu categories (ADR 0013). The list is shop-level config on the merchant row, so it goes
// through pickMerchantConfig — but unlike every other field there it is a Pro feature, and the
// gate that decides that is `menuCategoriesChanged` below. The allowlist's job here is only to
// refuse a list Postgres would happily store: ADR 0013 bought a write path that already existed
// and paid for it in check constraints, and `validateMenuCategories` is what stands there.
describe('pickMerchantConfig — menu categories (ADR 0013)', () => {
  const cakes = [{ id: 'c1', name: 'Cakes', name_zh: '蛋糕', active: true }]

  it('accepts a well-formed list, and an empty one', () => {
    expect(pickMerchantConfig({ product_categories: cakes }, SHOP))
      .toEqual({ ok: true, patch: { product_categories: cakes } })
    expect(pickMerchantConfig({ product_categories: [] }, SHOP))
      .toEqual({ ok: true, patch: { product_categories: [] } })
  })

  // Refused, never dropped — same rule as tax_rate. A list that silently failed to save is a
  // merchant watching their menu structure not stick, with a success toast on top of it.
  it('refuses a list the validator rejects, rather than dropping it', () => {
    expect(pickMerchantConfig({ product_categories: 'nope' }, SHOP).ok).toBe(false)
    expect(pickMerchantConfig({ product_categories: [{}] }, SHOP).ok).toBe(false)
    expect(pickMerchantConfig({ product_categories: [{ id: 'c1', name: '  ', active: true }] }, SHOP).ok).toBe(false)
    expect(pickMerchantConfig({
      product_categories: [{ id: 'c1', name: 'Cakes', active: true }, { id: 'c2', name: 'cakes', active: true }],
    }, SHOP).ok).toBe(false)
  })

  it('names the offending rule in the error', () => {
    const r = pickMerchantConfig({
      product_categories: [{ id: 'c1', name: 'Cakes', active: true }, { id: 'c2', name: 'CAKES', active: true }],
    }, SHOP)
    expect(r).toEqual({ ok: false, error: expect.stringContaining('duplicate_category_name') })
  })
})

// The line a customer reads under a shop's name. Both languages are ordinary free text with one
// cap, so what this block pins is the two edges the pixel and QR fields have too: a blank field
// means TAKE IT DOWN and must land as null, and an over-long one is refused rather than truncated
// — a blurb cut off mid-sentence is a merchant's own words put wrong on their own storefront.
describe('pickMerchantConfig — shop description', () => {
  it('accepts both languages, trimmed', () => {
    expect(pickMerchantConfig({
      description: '  Home-style kuih, order a day ahead. ',
      description_zh: ' 家庭式面包，请提前一天下单。 ',
    }, SHOP)).toEqual({
      ok: true,
      patch: {
        description: 'Home-style kuih, order a day ahead.',
        description_zh: '家庭式面包，请提前一天下单。',
      },
    })
  })

  it('accepts English alone — the Chinese line is optional and falls back', () => {
    expect(pickMerchantConfig({ description: 'Fresh bread daily' }, SHOP))
      .toEqual({ ok: true, patch: { description: 'Fresh bread daily' } })
  })

  it('reads a cleared field as null, the only way back to no description', () => {
    expect(pickMerchantConfig({ description: '' }, SHOP))
      .toEqual({ ok: true, patch: { description: null } })
    expect(pickMerchantConfig({ description: '   ' }, SHOP))
      .toEqual({ ok: true, patch: { description: null } })
    expect(pickMerchantConfig({ description_zh: null }, SHOP))
      .toEqual({ ok: true, patch: { description_zh: null } })
  })

  it('refuses an over-long blurb rather than truncating it', () => {
    const r = pickMerchantConfig({ description: 'a'.repeat(SHOP_DESCRIPTION_MAX + 1) }, SHOP)
    expect(r).toEqual({ ok: false, error: expect.stringContaining('description_too_long') })
    expect(pickMerchantConfig({ description_zh: '字'.repeat(SHOP_DESCRIPTION_MAX + 1) }, SHOP).ok).toBe(false)
  })

  it('refuses a non-string', () => {
    expect(pickMerchantConfig({ description: 42 }, SHOP).ok).toBe(false)
    expect(pickMerchantConfig({ description_zh: { zh: 'hi' } }, SHOP).ok).toBe(false)
  })

  it('leaves the columns alone when the request does not mention them', () => {
    expect(pickMerchantConfig({ timezone: 'Asia/Kuala_Lumpur' }, SHOP))
      .toEqual({ ok: true, patch: { timezone: 'Asia/Kuala_Lumpur' } })
  })
})

// The shop's own advertising pixel ids (#220). A wrong id is the quietest failure in this file:
// it reports to nowhere and looks exactly like a working pixel until a campaign has run, so the
// shape is checked at the door where the merchant is still looking at the form.
describe('pickMerchantConfig — pixel ids', () => {
  const pick = (body: any) => pickMerchantConfig(body, 'm1')

  it('accepts the ids the vendors issue', () => {
    const r = pick({ meta_pixel_id: '123456789012345', tiktok_pixel_id: 'CQ1234567890ABCDEFGH' })
    expect(r).toEqual({ ok: true, patch: { meta_pixel_id: '123456789012345', tiktok_pixel_id: 'CQ1234567890ABCDEFGH' } })
  })

  it('accepts a 16-digit Meta id as well as a 15-digit one', () => {
    expect(pick({ meta_pixel_id: '1234567890123456' })).toEqual({ ok: true, patch: { meta_pixel_id: '1234567890123456' } })
  })

  it('trims, because a pasted id carries whitespace', () => {
    expect(pick({ meta_pixel_id: '  123456789012345 ' })).toEqual({ ok: true, patch: { meta_pixel_id: '123456789012345' } })
  })

  it('reads a cleared field and an explicit null as the same "take it down"', () => {
    expect(pick({ meta_pixel_id: '' })).toEqual({ ok: true, patch: { meta_pixel_id: null } })
    expect(pick({ meta_pixel_id: '   ' })).toEqual({ ok: true, patch: { meta_pixel_id: null } })
    expect(pick({ tiktok_pixel_id: null })).toEqual({ ok: true, patch: { tiktok_pixel_id: null } })
  })

  // REFUSED, never dropped: a dropped field saves nothing and reports success, which is the
  // merchant watching a pixel they believe is live send no events at all.
  it('refuses what merchants actually paste by mistake', () => {
    // An ad account id, a whole snippet, a URL, the other vendor's shape.
    for (const bad of ['act_12345678', "fbq('init','123456789012345')", 'https://facebook.com/123', 'CQ1234567890ABCDEFGH', '12345']) {
      expect(pick({ meta_pixel_id: bad }).ok).toBe(false)
    }
    for (const bad of ['cq1234567890abcdefgh', 'CQ123', '123456789012345', 'CQ1234567890ABCDEFG_']) {
      expect(pick({ tiktok_pixel_id: bad }).ok).toBe(false)
    }
  })

  it('refuses a non-string rather than coercing it', () => {
    expect(pick({ meta_pixel_id: 123456789012345 }).ok).toBe(false)
  })
})

describe('pickProductFields — the arrangement columns', () => {
  // `sort` is written by PUT /api/merchants/:id/product-order and by nothing else. ProductsManager
  // spreads a whole row on edit, so accepting it here would let a stale dashboard drag a product
  // back to where it used to be, behind an ordinary rename.
  it('drops sort, so a product upsert can never move a product', () => {
    expect(pickProductFields({ name: 'Cookie', price: 5, sort: 99 }))
      .toEqual({ name: 'Cookie', price: 5 })
  })

  // The other half of the same pair: which SECTION a product sits in is an ordinary product field,
  // set by the product form as well as by a drag.
  it('keeps category_id', () => {
    expect(pickProductFields({ name: 'Cookie', price: 5, category_id: 'c1' }))
      .toEqual({ name: 'Cookie', price: 5, category_id: 'c1' })
  })
})

describe('pickMerchantConfig — brand colour', () => {
  it('accepts a hex and stores it uppercased', () => {
    expect(pickMerchantConfig({ brand_color: '#1f5c3d' }, SHOP))
      .toEqual({ ok: true, patch: { brand_color: '#1F5C3D' } })
  })

  it('accepts the three-digit form, expanded', () => {
    expect(pickMerchantConfig({ brand_color: '#f0a' }, SHOP))
      .toEqual({ ok: true, patch: { brand_color: '#FF00AA' } })
  })

  // The only way back to the platform colour. Both spellings store null, so the column never
  // holds a blank string that the derivation would then have to treat as a colour.
  it('reads null and empty as "use the platform colour"', () => {
    expect(pickMerchantConfig({ brand_color: null }, SHOP))
      .toEqual({ ok: true, patch: { brand_color: null } })
    expect(pickMerchantConfig({ brand_color: '' }, SHOP))
      .toEqual({ ok: true, patch: { brand_color: null } })
  })

  it('refuses a value that is not a colour rather than dropping it', () => {
    expect(pickMerchantConfig({ brand_color: 'rebeccapurple' }, SHOP))
      .toEqual({ ok: false, error: 'brand_color must be a hex colour like #7A1028' })
  })

  it('leaves the column alone when the body does not mention it', () => {
    expect(pickMerchantConfig({ timezone: 'Asia/Kuala_Lumpur' }, SHOP))
      .toEqual({ ok: true, patch: { timezone: 'Asia/Kuala_Lumpur' } })
  })
})

// The merchant PATCH allowlist. `fulfil_date` joined it for the date edit; the SHAPE is all that
// is judged here — whether the shop's clock allows the day is patchOrder's call, under the lock.
describe('pickOrderFields — fulfil_date', () => {
  it('passes a date string through trimmed', () => {
    expect(pickOrderFields({ fulfil_date: ' 2026-07-25 ' })).toEqual({ fulfil_date: '2026-07-25' })
  })

  it('never clears the date — an order without a day is a legacy fact, not a choice', () => {
    expect(pickOrderFields({ fulfil_date: null })).toEqual({})
    expect(pickOrderFields({ fulfil_date: '' })).toEqual({})
    expect(pickOrderFields({ fulfil_date: 42 })).toEqual({})
  })

  it('still refuses every column that is not on the allowlist', () => {
    expect(pickOrderFields({ total: 0, merchant_id: 'x', fulfil_date: '2026-07-25' })).toEqual({ fulfil_date: '2026-07-25' })
  })
})
