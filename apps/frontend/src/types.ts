// Shared domain types for the frontend.
//
// Pragmatic strict: Supabase row shapes are NOT generated from the DB schema, so
// each row type names the fields the app relies on and keeps an `[key: string]: any`
// index signature for the rest. That index signature is the deliberate "DB boundary"
// escape hatch the migration plan allows — it keeps dynamic field access from
// erroring without forcing a full generated-types pass.

import type { User } from '@supabase/auth-js'
import type { FeedbackCategory, FeedbackStatus } from '@bitetime/shared'

export type Lang = 'en' | 'zh'
export type Role = 'customer' | 'merchant' | 'superadmin'
export type MerchantStatus = 'pending' | 'active' | 'suspended'
export type OrderStatus = 'pending_payment' | 'new' | 'preparing' | 'ready' | 'completed' | 'cancelled'

export type Translate = (en: string, zh?: string) => string

export interface Merchant {
  id: string
  name: string
  slug: string
  status: MerchantStatus
  order_prefix?: string
  owner_id?: string
  billing_cycle?: string
  currency?: string
  pickup_address?: string
  config?: Record<string, unknown>
  timezone?: string
  created_at?: string
  /** Landing-page sample-shops carousel flag (#107). Toggled only from /admin/merchants. */
  is_sample?: boolean
  /** The one line a customer reads under the shop's name on its storefront. `description_zh`
   *  is optional and falls back to the English one — render the pair through `shopDescr`,
   *  never either column directly. Capped at `SHOP_DESCRIPTION_MAX`; null for a shop that has
   *  not written one, which draws no line at all rather than an empty one. */
  description?: string | null
  description_zh?: string | null
  /** The shop's one brand colour, `#RRGGBB` or null for the platform accent. Read it through
   *  `brandTheme()`, never directly: the storefront needs nine derived values, not this one, and a
   *  null here is a normal state (most shops), not a missing value. */
  brand_color?: string | null
  /** The shop's menu sections, in display order (ADR 0013). Read through
   *  `menuCategoriesFromRow`, never directly — the drivers disagree about whether jsonb arrives
   *  parsed, and anything unreadable must fall back to "no categories", not throw. */
  product_categories?: unknown
  /** Whether this shop charges tax. See `shopTax` — never read this without it. */
  tax_enabled?: boolean
  /** A PERCENTAGE: 6 means 6%. PostgREST sends a number; read via `shopTax`. */
  tax_rate?: number | string
  /** Which methods this shop offers. Read through `shopMethods`, never directly — an absent
   *  column means that column's own default, not `false`. */
  pickup_enabled?: boolean
  delivery_enabled?: boolean
  express_enabled?: boolean
  /** Read these through `shopDistance`, never directly — they arrive as strings or numbers. */
  delivery_base_fee?: number | string
  delivery_rate_per_km?: number | string
  delivery_max_km?: number | string | null
  origin_place_id?: string | null
  origin_address?: string | null
  /** DuitNow (or any) payment QR shown on the order-placed screen (#156). A Storage PATH in the
   *  public `payment-qr` bucket, never a URL — render it through `paymentQrUrl`. */
  payment_qr?: string | null
  payment_bank?: string | null
  payment_note?: string | null
  /** Industry the shop runs in (#161), one of `BUSINESS_NATURES`. Absent/null for a shop that
   *  signed up before the field existed — render it through `businessNatureLabel`, which names
   *  that state rather than dropping the shop. */
  business_nature?: string | null
  /** The shop's OWN advertising pixels (#220), read through `merchantPixelIds` — never
   *  directly, because a blank column and an absent one must mean the same thing. Public
   *  values: they ship in the storefront's page, which is why they sit here and not in
   *  `merchant_secrets`. */
  meta_pixel_id?: string | null
  tiktok_pixel_id?: string | null
  /** Onboarding checklist flags (#102). Read via `onboardingSteps`; absent means false. */
  onboarding_shipping_set?: boolean
  onboarding_link_shared?: boolean
  onboarding_dismissed?: boolean
  onboarding_tour_seen?: boolean
  [key: string]: any
}

export interface ReferredShop {
  name: string
  created_at: string
  status: MerchantStatus
}

export interface EarnedReward {
  referred_shop_name: string
  amount: number // smallest currency unit (cents)
  currency: string
  created_at: string
}

export interface Profile {
  id: string
  name?: string
  email?: string
  app_role?: Role
  merchant_id?: string | null
  email_confirmed?: boolean
  referral_code?: string
  /** Saved at checkout so a signed-in customer types it once, ever. Never set for a guest. */
  whatsapp?: string
  /** jsonb: holds whatever was last written, so read it through `prefillFromProfile`, not raw. */
  delivery_address?: any
  created_at?: string
  [key: string]: any
}

export interface Product {
  id: string
  merchant_id?: string
  name: string
  name_zh?: string
  desc?: string
  description?: string
  price: number
  unit?: string
  unit_quantity?: number  // display-only quantity paired with unit; defaults to 1
  // Which menu section this sits in (ADR 0013) — an id in the shop's own
  // `merchants.product_categories`, with no foreign key behind it. `null`, absent, and an id the
  // shop no longer holds are ONE state: uncategorized. See menuGroups.ts.
  category_id?: string | null
  sort?: number
  image_urls?: string[]
  created_at?: string
  [key: string]: any
}

export interface OrderItem {
  id: string
  name?: string
  qty: number
  price?: number
  unit?: string
  // Whether this line was priced at the promo rate. A split promo (I-2) writes TWO entries
  // sharing the same product id, one `promo: true` and one `promo: false` — never key a list
  // of these by id. Rows written before I-2 lack the key entirely, which every reader must
  // treat as `false`, not as a crash: `it.promo` on a missing key is already `undefined`, and
  // `undefined` is falsy, so `it.promo &&` guards do this for free.
  promo?: boolean
  [key: string]: any
}

export interface AddressParts {
  line1: string
  postcode: string
  city: string
  state: string
  /**
   * Unit, floor or landmark. Carried on the order and shown to the merchant, and DELIBERATELY
   * never routed: it must not be able to move the fee, so adding delivery instructions can
   * never cost the customer money.
   */
  unit?: string
  /**
   * The selected place's stable identifier — the distance cache key, and the reason free-text
   * resolution was rejected: a re-resolved string can drift between quote and charge. Absent on
   * every address saved before #101 and on every region-priced shop's addresses.
   */
  place_id?: string
}

export interface Order {
  id?: string
  order_number?: string
  merchant_id?: string
  customer_name?: string
  customer_wa?: string
  user_id?: string | null
  mode?: string
  address?: any
  shipping_fee?: number
  items?: OrderItem[]
  total?: number
  /** Tax charged on this order. 0 on orders placed before tax settings shipped. */
  tax?: number
  /** The percentage that produced `tax`. **Gate the tax line on this, not on `tax`** — a fully
   *  discounted order at a taxed shop has tax 0 and must still show its rate. */
  tax_rate?: number
  currency?: string
  status?: OrderStatus | string
  created_at?: string
  /** `YYYY-MM-DD`. Null on orders placed before fulfilment dates shipped. */
  fulfil_date?: string | null
  /** Routed km this order was charged for. Null for region-priced orders and everything before #101. */
  delivery_distance_km?: number | null
  /** Storage path in the private `payment-proof` bucket, or null/absent. Never render this
   *  directly as a URL — fetch it through `fetchPaymentProof` (merchant) or `fetchMyPaymentProof`
   *  (customer), both auth-gated. */
  payment_proof?: string | null
  /** Storage path in the same private bucket for the receipt the SHOP filed (the customer sent
   *  it over WhatsApp). Separate from `payment_proof`, so neither side overwrites the other.
   *  Fetch it through `fetchMerchantPaymentProof`. */
  payment_proof_merchant?: string | null
  /**
   * The customer's own 1-5 star review of this order, and the optional text beside it. Null
   * until they leave one. Written only through the two review doors; the merchant reads these
   * and can never write them.
   */
  review_rating?: number | null
  review_comment?: string | null
  /** When the review was LAST written — a customer may change theirs. */
  review_at?: string | null
  [key: string]: any
}

// One shop's record of one person who orders from it (#143). See CONTEXT.md → Shop customer.
//
// Identified by `phoneKey` — the last-eight-digits rule guest order tracking owns — scoped to
// one merchant, guests included. Aggregated by the backend, never in the browser: the old
// client-side grouping keyed on the raw WhatsApp string, so two spellings of one number were
// two people, and it was built on an orders fetch that truncates at 1000 rows (#144).
//
// `bookedOrders` and the money EXCLUDE cancelled orders; `lastOrderAt` does not. The name is
// deliberately not `orderCount` — the dashboard's KPI card counts orders RECEIVED, and two
// numbers on one screen must not wear one word for two meanings.
export interface ShopCustomer {
  phoneKey: string
  name: string | null
  wa: string | null
  bookedOrders: number
  lifetimeSpend: number
  avgOrder: number
  firstOrderAt: string
  lastOrderAt: string
  daysSinceLastOrder: number
  hasAccount: boolean
  /**
   * A member's account email; null for a guest. Optional on THIS side only, like `stats`
   * below: a browser on this code may face a backend that predates the field, and an absent
   * email draws as none rather than crashing the row. Shown on the Members list (ADR 0026).
   */
  email?: string | null
  /** What this merchant wrote. Shop-private, and blank for most customers. */
  note: string | null
  tags: string[]
}

/**
 * Which slice of the shop's customers the list shows (#269) — the sidebar's two Customers
 * children. A **member** is a shop customer with an account: see CONTEXT.md → Shop customer.
 * Twin of the backend's `ShopCustomerSegment` (`apps/backend/src/shopCustomers.ts`), like
 * `ShopCustomerSort` above it: the backend is authoritative and refuses anything else.
 */
export type ShopCustomerSegment = 'all' | 'members'

/**
 * The stat row above the list: the matched rows, summed. Scoped exactly like `total`. Twin of
 * the backend's `ShopCustomerStats`, the wire shape it computes.
 */
export interface ShopCustomerStats {
  customers: number
  bookedOrders: number
  spend: number
}

export interface ShopCustomerPage {
  customers: ShopCustomer[]
  /**
   * Optional on THIS side only: the two halves deploy independently, and a browser running this
   * code can be talking to a backend that has never heard of the field (the same reason
   * `fetchShopCustomers` guards `shopTags`). Absent, the row is not drawn — there is no honest
   * number to fill it with from one page of rows.
   */
  stats?: ShopCustomerStats
  /**
   * Every tag this shop has ever written, once each — what the drawer suggests from (#150).
   * Neither filtered nor paged: it is the vocabulary the tag filter chooses from.
   */
  shopTags: string[]
  /** Matching customers before paging — what the list is a slice of. */
  total: number
  /**
   * Orders no customer could be made from, because they carried no usable number. Stated under
   * the table so the customer count never silently disagrees with the order count.
   */
  unattributedOrders: number
}

/** The orderings the list offers. Everything but `recent` is Pro. */
export type ShopCustomerSort = 'recent' | 'spend' | 'orders'

/**
 * One line of a voucher's history, as the merchant's own route returns it. Everything here is a
 * fact about the ORDER the code was spent on — the account email behind the redemption never
 * leaves the backend (CONTEXT.md → Shop customer).
 */
export interface VoucherRedemption {
  id: string
  /** null on a backfilled row — no timestamp exists for a historical entry. */
  redeemedAt: string | null
  /** Set while the order is cancelled: the use has been returned. */
  voidedAt: string | null
  /** null on a backfilled row, or when the order was deleted. */
  orderId: string | null
  orderNumber: string | null
  customerName: string | null
  discount: number | null
  orderStatus: string | null
}

export interface Voucher {
  code: string
  used?: boolean
  /**
   * The redeemer keys — account email addresses. The API no longer sends this on ANY route, so in
   * the browser it is always absent; the field survives for the legacy single-tenant shape only.
   * Read `usedCount` / `fullyUsed` / `customerLimitReached` instead.
   */
  usedBy?: string[]
  /** How many redemptions the code has taken. Server-derived. */
  usedCount?: number
  /** The shop's total cap is spent. Server-derived. */
  fullyUsed?: boolean
  /** This caller has spent their own allowance. Server-derived from their own verified email;
   *  absent when they presented none. */
  customerLimitReached?: boolean
  maxUses?: number | string | null
  /** How many times ONE customer may redeem it. null = unlimited; the column defaults to 1. */
  perCustomerLimit?: number | null
  /** An ISO instant — the last millisecond of the merchant's chosen day, on the shop's clock. */
  expiresAt?: string | null
  /** The shop-local DATE that instant ends. What the dashboard form shows back. */
  expiresOn?: string | null
  /** The smallest SUBTOTAL, pre-discount, this voucher applies to. `voucherFromRow` coerces it to
   *  a number; the string half of the type is what `PricedVoucher` declares, because postgres.js
   *  hands a `numeric` column back as a string. */
  minOrder?: number | string | null
  [key: string]: any
}

// Settings is a loose bag — shape varies and parts are persisted as JSON.
export type Settings = Record<string, any>

export interface SessionValue {
  account: User | null | undefined
  profile: Profile | null
  role: Role
  merchant: Merchant | null
  ownMerchant: Merchant | null
  // The own-shop lookup never landed (backend unreachable, CORS, 5xx), so `ownMerchant: null`
  // here means "we don't know", not "owns no shop". Anything that would turn a user away on
  // that null must check this first (#98).
  merchantUnknown: boolean
  impersonating: boolean
  impersonate: (slug: string) => Promise<Merchant | null>
  stopImpersonating: () => void
  loading: boolean
  lang: Lang
  setLang: (lang: Lang) => void
  t: Translate
  refreshProfile: () => void
  refreshMerchant: () => Promise<void>
}

export interface MerchantState {
  slug?: string | null
  merchant: Merchant | null
  loading: boolean
  notFound: boolean
  // Re-fetch the CURRENT slug's merchant row without disturbing `loading`/`notFound`. Distinct
  // from `SessionValue.refreshMerchant`, which re-reads the SIGNED-IN user's own shop for the
  // merchant dashboard — this one re-reads whatever shop `/s/:slug` is pointed at, which any
  // visitor (including a guest) can be looking at. A failed refresh leaves `merchant` untouched.
  refresh: () => Promise<void>
}

// One row of merchant platform feedback (#89). shop_name / shop_slug are joined in by the
// admin list endpoint and are null for a shop that has since been deleted.
export interface FeedbackItem {
  id: string
  merchant_id: string
  user_id: string
  category: FeedbackCategory
  message: string
  // Storage paths in the private `feedback-images` bucket. NOT URLs and not resolvable to one:
  // the bucket has no public read, so the bytes come from fetchFeedbackImage(id, index).
  image_paths: string[]
  status: FeedbackStatus
  created_at: string
  resolved_at: string | null
  shop_name: string | null
  shop_slug: string | null
  github_issue_number: number | null
  github_issue_url: string | null
}

// One row of the one-time trial-experience survey (#155). `null` from `fetchTrialFeedback`
// means no survey has been sent yet — the trial hasn't ended. A non-null row with neither
// responded_at nor skipped_at is a pending prompt still waiting on the merchant.
export interface TrialFeedbackOwn {
  merchant_id: string
  sent_at: string
  rating: number | null
  comment: string | null
  responded_at: string | null
  skipped_at: string | null
}

export interface TrialFeedbackAdminItem extends TrialFeedbackOwn {
  shop_name: string | null
  shop_slug: string | null
}

// GitHub releases pulled and rewritten into merchant-facing copy by Claude (#163). See
// docs/superpowers/specs/2026-08-05-github-release-notes-design.md.
export interface PublicRelease {
  tag: string
  title: string
  published_at: string
}

export interface ReleaseDetail extends PublicRelease {
  summary: string
}

export interface AdminRelease {
  id: string
  tag: string
  name: string
  html_url: string
  raw_body: string
  published_at: string
  title: string | null
  summary: string | null
  humanize_error: string | null
  status: 'draft' | 'published'
  created_at: string
  updated_at: string
}
