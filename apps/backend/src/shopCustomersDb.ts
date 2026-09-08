// The two queries behind the shop-customer list, and nothing else. The rules live next door in
// `shopCustomers.ts`, which is pure — see the note at the top of that file for why the split.
//
// SQL GROUPS, TYPESCRIPT DECIDES. The grouping query returns one row per (phone key, status):
// a handful of rows per customer rather than a shop's whole order table, which is what makes
// this endpoint immune to the PostgREST row cap. It was the first read here to escape that cap;
// `ordersDb.ts` took the same route for the dashboard's own aggregates in #144. What it
// deliberately does NOT do is decide anything —
// no `status <> 'cancelled'` here, because that rule belongs to `@bitetime/shared` and a copy
// of it in SQL is how the customer list would come to disagree with the revenue chart.
//
// Goes through `db.ts`, which is RLS-EXEMPT: the merchant scoping below is a TypeScript
// invariant, and `requireMerchantOwns` on the route is what makes it true.

import { sql } from './db.js'
import type { ShopCustomerGroup, ShopCustomerRecord } from './shopCustomers.js'

/** postgres.js hands back `timestamptz` as a Date; the pure module compares ISO strings. */
const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v)

interface GroupRow {
  phone_key: string | null
  status: string | null
  orders: string | number
  total: string | number | null
  first_at: Date | string
  last_at: Date | string
  latest_name: string | null
  latest_wa: string | null
  has_account: boolean
  latest_email: string | null
}

/**
 * Every (phone key, status) bucket for one shop.
 *
 * `array_agg(… order by created_at desc)[1]` is how the name and number come from the customer's
 * MOST RECENT order in the bucket rather than an arbitrary one — a diner who corrects their name
 * should be listed under the correction. `count(*)::int` because postgres.js returns `bigint` as
 * a string, and a string order count silently concatenates when summed.
 *
 * `latest_email` is the one read outside `orders`: a left join to `auth.users` on `user_id`, the
 * column intake fills only from a verified JWT. The `filter` keeps the aggregate to signed-in
 * orders, so a guest order placed later cannot shadow the email with a null. Like
 * `deviceLimitDb.ts`, this reads the `auth` schema and adds nothing to it — a data statement
 * that survives a Supabase upgrade the way any other row does. Shop-scoped by the `merchant_id`
 * predicate, which on this RLS-exempt connection is the whole tenancy guard.
 */
export async function shopCustomerGroups(merchantId: string): Promise<ShopCustomerGroup[]> {
  const rows = await sql<GroupRow[]>`
    select
      o.customer_phone_key                                          as phone_key,
      o.status,
      count(*)::int                                                 as orders,
      sum(o.total)                                                  as total,
      min(o.created_at)                                             as first_at,
      max(o.created_at)                                             as last_at,
      (array_agg(o.customer_name order by o.created_at desc))[1]    as latest_name,
      (array_agg(o.customer_wa   order by o.created_at desc))[1]    as latest_wa,
      bool_or(o.user_id is not null)                                as has_account,
      (array_agg(u.email order by o.created_at desc)
         filter (where o.user_id is not null))[1]                   as latest_email
    from orders o
    left join auth.users u on u.id = o.user_id
    where o.merchant_id = ${merchantId}
    group by o.customer_phone_key, o.status
  `
  return rows.map(r => ({
    phoneKey: r.phone_key,
    status: r.status,
    orders: Number(r.orders),
    total: r.total ?? 0,
    firstAt: iso(r.first_at),
    lastAt: iso(r.last_at),
    latestName: r.latest_name,
    latestWa: r.latest_wa,
    hasAccount: r.has_account,
    latestEmail: r.latest_email,
  }))
}

/** What this shop's merchant has written down. Most customers have no row. */
export async function shopCustomerRecords(merchantId: string): Promise<ShopCustomerRecord[]> {
  const rows = await sql<{ phone_key: string; note: string | null; tags: string[] }[]>`
    select phone_key, note, tags from shop_customers where merchant_id = ${merchantId}
  `
  return rows.map(r => ({ phoneKey: r.phone_key, note: r.note, tags: r.tags ?? [] }))
}

/**
 * Write the merchant's note and tags, creating the row if this is the first thing they have
 * said about this customer.
 *
 * The upsert targets `(merchant_id, phone_key)` — the constraint that IS the identity rule, so
 * a second write updates rather than duplicating. Nothing here checks that the phone key
 * belongs to a real customer: a key with no orders behind it simply never joins, which is a
 * harmless row rather than an error worth a round-trip to prevent.
 */
export async function upsertShopCustomer(
  merchantId: string,
  phoneKey: string,
  fields: { note: string | null; tags: string[] },
): Promise<ShopCustomerRecord> {
  const [row] = await sql<{ phone_key: string; note: string | null; tags: string[] }[]>`
    insert into shop_customers (merchant_id, phone_key, note, tags)
    values (${merchantId}, ${phoneKey}, ${fields.note}, ${fields.tags})
    on conflict (merchant_id, phone_key) do update
      set note = excluded.note, tags = excluded.tags, updated_at = now()
    returning phone_key, note, tags
  `
  return { phoneKey: row!.phone_key, note: row!.note, tags: row!.tags ?? [] }
}
