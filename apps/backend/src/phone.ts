// The phone-matching rule, deliberately alone in a module that touches nothing.
//
// It is the whole security of guest order tracking, and it is pure — so it lives apart from
// the query that uses it, reachable by `pnpm test` with no database and no env. Fold it back
// into orderTracking.ts and its tests need a running Supabase to assert string handling.

/**
 * The digits of a phone, last eight — or null when it has none.
 *
 * One human types one phone three ways: `+60 12-345 6789`, `0123456789`, `60123456789`. All
 * three must reach the same order, so both sides of a comparison are reduced to this key. A
 * raw string compare would lock customers out of their own orders far more often than it
 * would stop an attacker.
 *
 * Null, not '', for a phone with no digits. The empty string is what BOTH an absent request
 * phone and an order with no phone on file normalise to, so making it a key would let an
 * empty phone match every phone-less order — handing back exactly the enumeration the phone
 * requirement exists to remove.
 */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  return digits ? digits.slice(-8) : null
}

/** Whether two phones are the same phone. Never true when either side has no digits. */
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const keyA = phoneKey(a)
  return keyA !== null && keyA === phoneKey(b)
}
