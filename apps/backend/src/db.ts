import postgres from 'postgres'
import { env } from './env.js'

// The backend's direct line to Postgres, alongside (not replacing) the Supabase REST
// clients in supabase.ts.
//
// It exists because supabase-js cannot open a transaction. That single limitation is why
// the order rules were written in PL/pgSQL: `next_order_number` needs an atomic upsert on
// the daily counter, and `redeem_voucher` needs `SELECT … FOR UPDATE` on the voucher row.
// Ported to TypeScript over the REST client, both would reintroduce exactly the races they
// were written to close. With a real driver they become ordinary code that Vitest can reach.
//
// This connection is RLS-EXEMPT. It authenticates as the database owner, so no policy runs
// on it. Anything its callers do must therefore enforce tenancy itself — which merchant a
// row belongs to is a TypeScript invariant on this path, not a Postgres one. RLS stays in
// place as the backstop for the anon path, and tests/rls stays the proof that it is shut.
//
// Note `timestamptz` arrives as a JS **Date**, not a string. Callers that hand rows
// straight to `c.json()` get an ISO string by accident of serialisation, which is NOT the
// `+00:00` format PostgREST used to return. Map it explicitly rather than relying on that.
export const sql = postgres(env.databaseUrl, {
  // The backend is a long-lived Node process (@hono/node-server), so a persistent pool is
  // correct here. If it is ever moved to serverless, this becomes a connection leak per
  // invocation and must be pointed at Supabase's pooler instead.
  max: 10,
})

/**
 * Run `fn` inside a single Postgres transaction: it commits when `fn` returns, and rolls
 * back if `fn` throws, rethrowing the error. So a domain rule can abort an order by simply
 * throwing, and nothing it wrote survives.
 *
 * Every multi-statement rule goes through here. A caller that reaches for `sql` directly to
 * do two related writes has reintroduced the bug this module exists to kill.
 *
 * The cast is load-bearing: postgres.js types `begin` as `Promise<UnwrapPromiseArray<T>>`,
 * because at runtime it does `Array.isArray(x) ? Promise.all(x) : x`. For every `T` we
 * return that is not an array of promises the two are the same type, and the cast says so.
 * Return an array of promises from `fn` and this lies to you — don't.
 */
export function withTransaction<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(fn) as Promise<T>
}
