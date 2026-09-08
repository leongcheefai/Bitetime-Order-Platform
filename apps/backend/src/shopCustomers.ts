// A shop's view of the people who order from it — the fold, and nothing else.
//
// Pure by design, and that is the whole reason this module exists apart from the query that
// feeds it: every rule worth arguing about (who is one person, what counts as an order, what
// "spent" means) is decided here, against injected rows and an injected clock, and can be
// tested exhaustively with no database and no env. See CONTEXT.md → Shop customer and
// docs/adr/0007-shop-customers-are-keyed-by-phone.md.
//
// SQL groups, TypeScript decides. The query hands over one row per (phone key, status) —
// a handful of rows per customer rather than a shop's whole order table — and the BOOKED
// rule is applied here, from `@bitetime/shared`, so "revenue excludes cancelled orders" is
// never written a second time in SQL where it could drift from the revenue chart.

import { isBooked } from '@bitetime/shared'

/**
 * One (phone key, status) bucket, as the grouping query returns it.
 *
 * `total` is `number | string` because postgres.js hands back `numeric` as a string — the same
 * trap `voucherFromRow` and `productFromRow` document on the pricing side.
 */
export interface ShopCustomerGroup {
  /** `phoneKey(customer_wa)` — null when the order carried no usable number. */
  phoneKey: string | null
  status: string | null
  orders: number
  total: number | string
  firstAt: string
  lastAt: string
  /** Name and number as of this bucket's most recent order. */
  latestName: string | null
  latestWa: string | null
  /** Whether any order in this bucket was placed by a signed-in customer. */
  hasAccount: boolean
  /**
   * The account email behind this bucket's most recent SIGNED-IN order — null when none was.
   * The one field here read from outside `orders` (`auth.users`), and the one global-profile
   * fact a shop is allowed to see: see ADR 0026.
   */
  latestEmail: string | null
}

/** What the merchant wrote down. Absent for most customers — the row is created on first write. */
export interface ShopCustomerRecord {
  phoneKey: string
  note: string | null
  tags: string[]
}

export interface ShopCustomer {
  phoneKey: string
  name: string | null
  wa: string | null
  /** Excludes cancelled orders. Named `bookedOrders`, never `orderCount` — see CONTEXT.md. */
  bookedOrders: number
  lifetimeSpend: number
  avgOrder: number
  firstOrderAt: string
  /** INCLUDES cancelled orders: a cancelled attempt is still contact. */
  lastOrderAt: string
  daysSinceLastOrder: number
  hasAccount: boolean
  /**
   * A member's account email; null for a guest. The Members list shows it so a shop can reach
   * the people who chose to hold an account with it (ADR 0026). Taken from the customer's most
   * recent signed-in order, so an account change follows the same rule a name change does.
   */
  email: string | null
  note: string | null
  tags: string[]
}

/**
 * The stat row above the list (#269): the matched rows, summed.
 *
 * Scoped EXACTLY like `total` — after the segment, search and tag filter, before paging — so the
 * header and the rows beneath it can never disagree. Booked, like the rows: cancelled orders are
 * already out of `bookedOrders` and `lifetimeSpend`, and this adds no second counting rule.
 */
export interface ShopCustomerStats {
  customers: number
  bookedOrders: number
  spend: number
}

export interface ShopCustomerPage {
  customers: ShopCustomer[]
  stats: ShopCustomerStats
  /**
   * Every tag this shop has written, once each — what the drawer offers back so the merchant
   * does not have to remember which spelling they used (#150).
   *
   * NOT filtered and NOT paged, unlike `customers`: it is the vocabulary the filter chooses
   * from, so narrowing to one tag must not narrow the list of tags to that one tag.
   */
  shopTags: string[]
  /** Distinct customers, before any paging. */
  total: number
  /**
   * Orders this list does not represent, because nothing identified them.
   *
   * Stated rather than swallowed: the customer totals otherwise fail to add up to the order
   * total with nothing on screen to explain the gap. Cancelled orders are counted here too —
   * they are still orders the list does not show.
   */
  unattributedOrders: number
}

/**
 * How the merchant asked to see the list. `recent` is the default and the free one; the others
 * are the Pro capability (CONTEXT.md → Shop customer).
 */
export type ShopCustomerSort = 'recent' | 'spend' | 'orders'

export const SHOP_CUSTOMER_SORTS: readonly ShopCustomerSort[] = ['recent', 'spend', 'orders']

/**
 * Refuse a sort we do not offer; do not reinterpret it. The same instinct as the cart key —
 * a list quietly answering a different question is worse than a refusal the caller can read.
 */
export const isShopCustomerSort = (v: unknown): v is ShopCustomerSort =>
  typeof v === 'string' && (SHOP_CUSTOMER_SORTS as readonly string[]).includes(v)

/** The free sort. Every other ordering is the Pro capability. */
export const DEFAULT_SHOP_CUSTOMER_SORT: ShopCustomerSort = 'recent'

/**
 * Which slice of the shop's customers the list shows (#269).
 *
 * `members` is the shop customers with an account — see CONTEXT.md → Shop customer → Member.
 * An enum rather than a `members` boolean so a third slice later (guests, say) is one more word
 * here and not a second flag whose combination with the first has to be given a meaning.
 * The frontend carries a twin in `apps/frontend/src/types.ts`; this side is authoritative.
 */
export type ShopCustomerSegment = 'all' | 'members'

export const SHOP_CUSTOMER_SEGMENTS: readonly ShopCustomerSegment[] = ['all', 'members']

/** Refuse a segment we do not offer; do not reinterpret it. The same rule as `isShopCustomerSort`. */
export const isShopCustomerSegment = (v: unknown): v is ShopCustomerSegment =>
  typeof v === 'string' && (SHOP_CUSTOMER_SEGMENTS as readonly string[]).includes(v)

export const DEFAULT_SHOP_CUSTOMER_SEGMENT: ShopCustomerSegment = 'all'

export const MAX_NOTE_LENGTH = 2000
export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 40

/**
 * What a merchant may write against a customer, cleaned rather than trusted.
 *
 * Blank is *nothing written*, not a blank string: a note the merchant cleared should read the
 * same as one they never wrote, so the UI has one empty state instead of two. Tags are trimmed
 * and de-duplicated because the whole point of a tag is that clicking it finds the others —
 * `vip` and `vip ` would be two filters the merchant cannot tell apart on screen.
 */
export function pickShopCustomerFields(
  body: unknown,
): { ok: true; fields: { note: string | null; tags: string[] } } | { ok: false } {
  const b = (body ?? {}) as { note?: unknown; tags?: unknown }

  if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') return { ok: false }
  const note = typeof b.note === 'string' ? b.note.trim() : ''
  if (note.length > MAX_NOTE_LENGTH) return { ok: false }

  if (b.tags !== undefined && !Array.isArray(b.tags)) return { ok: false }
  const raw = Array.isArray(b.tags) ? b.tags : []
  if (raw.some(t => typeof t !== 'string')) return { ok: false }
  const tags = [...new Set((raw as string[]).map(t => t.trim()).filter(Boolean))]
  if (tags.length > MAX_TAGS) return { ok: false }
  if (tags.some(t => t.length > MAX_TAG_LENGTH)) return { ok: false }

  return { ok: true, fields: { note: note || null, tags } }
}

export interface ShopCustomerOptions {
  now: Date
  sort?: ShopCustomerSort
  /** Which slice to show. Absent is everyone. */
  segment?: ShopCustomerSegment
  /** Name text or phone digits. Blank matches everyone. */
  search?: string
  /** One merchant-defined tag. Absent matches everyone. */
  tag?: string
  /** 1-based. Omit both to get the whole list. */
  page?: number
  pageSize?: number
}

const MS_PER_DAY = 86_400_000

/** Money, to the cent. Accumulated in cents so a lifetime spend never ends in floating dust. */
const cents = (n: number | string) => Math.round((Number(n) || 0) * 100)
const money = (c: number) => c / 100

interface Acc {
  phoneKey: string
  bookedOrders: number
  spendCents: number
  firstAt: string
  lastAt: string
  name: string | null
  wa: string | null
  hasAccount: boolean
  email: string | null
  /** When the bucket `email` came from was last ordered in — a guest bucket never moves it. */
  emailAt: string | null
}

export function shopCustomers(
  groups: ShopCustomerGroup[],
  records: ShopCustomerRecord[],
  opts: ShopCustomerOptions,
): ShopCustomerPage {
  const byKey = new Map<string, Acc>()
  let unattributedOrders = 0

  for (const g of groups) {
    // An order with no usable number is NOT a customer. Not an empty-string bucket and not a
    // name fallback: `phone.ts` refuses to key on '' for the same reason, and keying on the
    // name would assemble one person out of unrelated strangers — which is exactly what the
    // old `—` row did. Counted instead, and reported.
    if (g.phoneKey === null) {
      unattributedOrders += g.orders
      continue
    }

    const key = g.phoneKey
    const acc = byKey.get(key) ?? {
      phoneKey: key,
      bookedOrders: 0,
      spendCents: 0,
      firstAt: g.firstAt,
      lastAt: g.lastAt,
      name: null,
      wa: null,
      hasAccount: false,
      email: null,
      emailAt: null,
    }

    // The booked rule, borrowed rather than restated. A bucket IS its status, so one call
    // decides the whole bucket.
    if (isBooked({ status: g.status ?? undefined })) {
      acc.bookedOrders += g.orders
      acc.spendCents += cents(g.total)
    }

    // Recency counts every order, booked or not.
    if (g.firstAt < acc.firstAt) acc.firstAt = g.firstAt
    // `>=` rather than `>`: the identity fields below ride on this comparison, and on a tie the
    // later group in input order is as good an answer as the earlier one — but it must be a
    // decision, not an accident of which branch ran.
    if (g.lastAt >= acc.lastAt || acc.name === null) {
      acc.lastAt = g.lastAt > acc.lastAt ? g.lastAt : acc.lastAt
      acc.name = g.latestName
      acc.wa = g.latestWa
    }

    acc.hasAccount ||= g.hasAccount
    // The email rides its own recency, not the name's: the most recent bucket is often a guest
    // one (a member who checked out signed out last week), and that bucket must not blank the
    // email the signed-in bucket before it supplied.
    if (g.latestEmail !== null && (acc.emailAt === null || g.lastAt >= acc.emailAt)) {
      acc.email = g.latestEmail
      acc.emailAt = g.lastAt
    }
    byKey.set(key, acc)
  }

  const byPhone = new Map(records.map(r => [r.phoneKey, r]))
  const nowMs = opts.now.getTime()

  const customers = [...byKey.values()].map((a): ShopCustomer => {
    const record = byPhone.get(a.phoneKey)
    return {
      phoneKey: a.phoneKey,
      name: a.name,
      wa: a.wa,
      bookedOrders: a.bookedOrders,
      lifetimeSpend: money(a.spendCents),
      // Zero, not NaN, for a customer whose every order was cancelled — they are a real
      // customer with a real last-order date and no money attached.
      avgOrder: a.bookedOrders ? money(Math.round(a.spendCents / a.bookedOrders)) : 0,
      firstOrderAt: a.firstAt,
      lastOrderAt: a.lastAt,
      daysSinceLastOrder: Math.floor((nowMs - Date.parse(a.lastAt)) / MS_PER_DAY),
      hasAccount: a.hasAccount,
      email: a.email,
      // Absent for most customers — the row is written on the merchant's first note or tag,
      // never on their first order. Blank, not undefined: the wire shape stays the same
      // whether or not anyone has written anything.
      note: record?.note ?? null,
      tags: record?.tags ?? [],
    }
  })

  const matched = customers.filter(c =>
    matchesSegment(c, opts.segment) && matchesTag(c, opts.tag) && matchesSearch(c, opts.search),
  )
  matched.sort(comparator(opts.sort))

  return {
    // `total` is the MATCHED count, not the shop's: it is what the pager is a slice of.
    // `unattributedOrders` is not filtered — no search narrows away an order that could never
    // have been shown in the first place.
    customers: paginate(matched, opts.page, opts.pageSize),
    // Folded from `records`, NOT from `customers`: the same reason as above, plus records is
    // already the whole shop's rows in memory, so the vocabulary costs no second query.
    shopTags: shopTags(records),
    stats: statsOf(matched),
    total: matched.length,
    unattributedOrders,
  }
}

/** In cents again, for the same reason the fold is: forty spends of 0.10 must not sum to 3.9999. */
function statsOf(matched: ShopCustomer[]): ShopCustomerStats {
  let bookedOrders = 0
  let spendCents = 0
  for (const c of matched) {
    bookedOrders += c.bookedOrders
    spendCents += cents(c.lifetimeSpend)
  }
  return { customers: matched.length, bookedOrders, spend: money(spendCents) }
}

/**
 * Every tag this shop has used, once each, in an order a merchant can scan.
 *
 * **Offers, never normalises.** `vip` and `VIP` both survive as the merchant typed them — a tag
 * is the merchant's own label for their own customers, and quietly rewriting the case would
 * merge two tags they may have meant to keep apart, with no way back (#150; same instinct as
 * the cart key in CONTEXT.md → Order pricing). What the sort does instead is put the two
 * spellings side by side, so the merchant sees the collision and picks one themselves.
 *
 * Case-insensitive, then raw as the tiebreak, for the same reason the customer comparator
 * tiebreaks on `phoneKey`: a total order, so the row of suggestions does not reshuffle between
 * two renders that happen to enumerate the rows differently.
 *
 * A tag on a row whose customer no longer appears in the orders is kept. It is still a word the
 * merchant chose, and dropping it would quietly retire a tag from the vocabulary at the moment
 * its last holder stopped being listed.
 */
function shopTags(records: ShopCustomerRecord[]): string[] {
  return [...new Set(records.flatMap(r => r.tags))].sort(
    (a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? -1 : a > b ? 1 : 0),
  )
}

/** A member is a shop customer with an account; `all` and an absent segment match everyone. */
function matchesSegment(c: ShopCustomer, segment: ShopCustomerSegment | undefined): boolean {
  return segment === 'members' ? c.hasAccount : true
}

const digitsOf = (s: string | null) => (s ?? '').replace(/\D/g, '')

/**
 * Name text or phone digits, and the phone half has to work in BOTH directions.
 *
 * A merchant types the number they have; the order carries the number the customer typed, and
 * the two disagree about the country code more often than not. So two clauses:
 *
 *   * the query's digits inside the stored number's digits — finds `0123456789` in `+60123456789`
 *   * the query's LAST EIGHT inside the phone key — finds `+60123456789` against `0123456789`,
 *     which the first clause cannot, because the stored digits are the shorter string
 *
 * The second clause is `phoneKey`'s rule reused rather than restated, which is the same reason
 * the key itself is what identifies a customer at all (ADR 0007).
 */
function matchesSearch(c: ShopCustomer, search: string | undefined): boolean {
  const q = (search ?? '').trim().toLowerCase()
  if (!q) return true
  if ((c.name ?? '').toLowerCase().includes(q)) return true
  const qDigits = digitsOf(q)
  if (!qDigits) return false
  return digitsOf(c.wa).includes(qDigits) || c.phoneKey.includes(qDigits.slice(-8))
}

const matchesTag = (c: ShopCustomer, tag: string | undefined) => !tag || c.tags.includes(tag)

/** Both absent means "the whole list" — the caller that wants everything says nothing. */
function paginate(customers: ShopCustomer[], page?: number, pageSize?: number): ShopCustomer[] {
  if (!page || !pageSize) return customers
  const start = (page - 1) * pageSize
  return customers.slice(start, start + pageSize)
}

/**
 * The orderings the list offers, each descending — "best first" is what every one of them means.
 *
 * The tiebreak on `phoneKey` is not decoration. Without it two customers holding the same spend
 * come back in whatever order the map happened to yield, which means page 2 can repeat a row
 * page 1 already showed. A total order is what makes paging honest.
 *
 * An unrecognised sort falls back to recency rather than to the array's own order: the endpoint
 * validates before calling, so reaching here with something else is a bug, and a bug must not
 * express itself as a scrambled list the merchant might read as data.
 */
function comparator(sort: ShopCustomerSort | undefined): (a: ShopCustomer, b: ShopCustomer) => number {
  const rank = (c: ShopCustomer) =>
    sort === 'spend' ? c.lifetimeSpend
    : sort === 'orders' ? c.bookedOrders
    : Date.parse(c.lastOrderAt)
  return (a, b) => rank(b) - rank(a) || (a.phoneKey < b.phoneKey ? -1 : a.phoneKey > b.phoneKey ? 1 : 0)
}
