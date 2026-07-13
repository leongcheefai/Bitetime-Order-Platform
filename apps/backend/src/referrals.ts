import { sql } from './db.js'

export interface ReferredShop {
  name: string
  created_at: string
  status: string
}

/**
 * A member's referral code: the first 8 hex characters of their user id, uppercased.
 *
 * This must stay byte-identical to the frontend's `referralCodeOf()` and to what signup
 * stamps onto `merchants.referred_by_code`, or a referrer's shops quietly stop matching
 * their own code. The old SQL derived it the same way, from `auth.uid()`.
 */
export function referralCodeOf(userId: string): string {
  return userId.replace(/-/g, '').slice(0, 8).toUpperCase()
}

/**
 * The shops that signed up under this user's referral code, newest first.
 *
 * The code is derived from the caller's id — never accepted from the request. That is the
 * whole security property of the function this replaces: `my_referred_shops` was SECURITY
 * DEFINER precisely so it could read across tenants, and it was safe only because it
 * filtered on a code the caller could not choose. Take the code as an argument from an
 * untrusted source and this becomes a cross-tenant read of any referrer's shops.
 *
 * Only the three non-sensitive columns the referral tab renders are selected.
 */
export async function listReferredShops(userId: string): Promise<ReferredShop[]> {
  const code = referralCodeOf(userId)

  // `${code}` is a bound parameter, not string interpolation — postgres.js's tagged template
  // sends it out of band. Building this query by concatenation would hand any caller who can
  // influence the code a read of the whole merchants table.
  const rows = await sql<{ name: string; created_at: Date; status: string }[]>`
    select m.name, m.created_at, m.status::text
    from merchants m
    where m.referred_by_code = ${code}
    order by m.created_at desc
  `

  // Two conversions, both deliberate. `created_at` arrives as a Date and the wire contract is
  // an ISO string, so say so here rather than leaning on c.json() to stringify it. And the
  // rows come back as postgres.js's Result, an Array subclass carrying `count`/`columns`/
  // `statement`; mapping to plain objects keeps those off the response.
  return rows.map(r => ({
    name: r.name,
    created_at: r.created_at.toISOString(),
    status: r.status,
  }))
}
