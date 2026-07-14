# Migrating SQL functions into the backend API

**Date:** 2026-07-13
**Status:** approved, not yet implemented

## Problem

Business logic lives in PL/pgSQL, spread across 29 migration files. It cannot be unit tested, produces no stack traces, and several functions are redefined across multiple migrations (`redeem_voucher` twice, `track_order` twice, `is_superadmin` three times), so reading the migrations does not tell you what is live. Meanwhile the rest of the domain logic sits in TypeScript. There is no single home for a rule.

Underneath that stated problem is a worse one, found while surveying the call sites.

### Checkout is not atomic

`Storefront.tsx` places an order in three separate, independent browser-to-Postgres calls:

1. `rpc('next_order_number')` — burns a slot in the per-merchant daily counter
2. `from('orders').insert(...)` — writes the order
3. `rpc('redeem_voucher')` — records the voucher as used

They are not in a transaction. Any of them can fail while the others have already committed. Worse, `Storefront.tsx:269` reads:

```ts
await redeemVoucher(merchant.id, appliedVoucher.code, voucherEntry).catch(() => {})
```

The redemption error is discarded. When a redeem fails, the order is already inserted with the discount applied and the voucher is never marked used — so the customer keeps the discount and can reuse the voucher indefinitely.

This is the exact failure the `20260706120000_redeem_voucher_harden.sql` migration was written to prevent. That migration made a re-redeem raise an exception specifically so callers could block the duplicate. The caller throws the exception away.

The bug is not fixable in SQL. It is a consequence of three non-transactional round trips, and it stays unfixable as long as the browser is the one making them.

## Function inventory

| Class | Functions | Fate |
|---|---|---|
| Business RPCs | `next_order_number`, `redeem_voucher`, `track_order`, `my_referred_shops` | **Migrate to TypeScript, drop from SQL** |
| RLS helpers | `is_superadmin`, `current_merchant_id`, `is_owner` | **Keep** — load-bearing inside RLS policies |
| Trigger guards | `guard_merchant_status`, `guard_profile_privileges`, `orders_set_user_id` | **Keep** — defence in depth |
| Dead | `product_sales`, `is_new_customer` | **Drop** — zero TypeScript references, legacy single-tenant |

## Decisions

**The backend gets a real Postgres driver.** `postgres.js`, connected via a new `DATABASE_URL`. `supabase-js` has no transactions, which is the only reason `next_order_number` and `redeem_voucher` are PL/pgSQL at all: one needs an atomic `INSERT … ON CONFLICT DO UPDATE`, the other a `SELECT … FOR UPDATE`. Without a driver that can issue `BEGIN`/`COMMIT`, porting them to TypeScript would reintroduce the races they were written to close. The backend is a long-lived Node server (`@hono/node-server`), so a persistent connection pool is appropriate.

**RLS stays as a backstop.** Once the backend is the sole writer it connects with a privileged role that bypasses RLS, so tenancy enforcement on the live path moves into TypeScript. RLS and the trigger guards remain as a second line, and `tests/rls/` keeps proving the anon path is shut. This is a real demotion of RLS from primary defence to backstop, and it is taken deliberately.

**Endpoints follow the transaction, not the RPCs.** Porting the four RPCs one-for-one would preserve the non-atomic checkout and expose an abusable public "give me an order number" endpoint. Instead the endpoints are drawn around what must commit together.

## Endpoints

| Endpoint | Replaces | Auth |
|---|---|---|
| `POST /api/orders` | `next_order_number` + `orders.insert` + `redeem_voucher`, in **one transaction** | Optional JWT — guest checkout must keep working |
| `POST /api/orders/track` | `track_order` | None |
| `GET /api/referrals/shops` | `my_referred_shops` | JWT required |

Three endpoints retire four SQL functions and make checkout atomic. The counter bump, the order row and the voucher claim now commit together or not at all.

### Scope note: order intake moves to the backend

This pulls the `orders` INSERT out of the browser. That is more than "migrate the SQL functions," and it is unavoidable: the counter, the insert and the voucher claim cannot be made atomic unless they share a transaction, and they cannot share a transaction unless they share a process.

Every other table read and write in `store.ts` stays on `supabase-js` for now. Making the backend the sole gatekeeper for *all* data is a separate, larger project that this one deliberately does not attempt. It only unblocks it.

## Modules

```
apps/backend/src/db.ts          postgres.js client, withTransaction() helper
apps/backend/src/orders.ts      createOrder()  — counter → insert → redeem, one txn
                                trackOrder()   — phone-matched lookup
apps/backend/src/referrals.ts   listReferredShops(userId)
```

Routes in `index.ts` stay thin: parse the body, resolve the caller, delegate, map domain errors to status codes.

On the frontend, `store.ts` loses its four `.rpc()` calls. `placeOrder` and `redeemVoucher` collapse into a single `fetch('/api/orders')`. `fetchOrderTracking` and `fetchReferredShops` become plain fetches. `Storefront.tsx` loses its separate `redeemVoucher` call, and with it the `.catch(() => {})`.

## Three landmines

### `orders_set_user_id` fires on backend inserts

The trigger sets `new.user_id := auth.uid()` unconditionally. Over a direct Postgres connection there is no `auth.uid()`, so it evaluates to NULL and **every backend-inserted order becomes a guest order**. Guest orders are never reclaimed retroactively — that is a deliberate property of the customer-accounts design — so this would silently and permanently destroy customer order history.

The migration's own author saw this coming:

> *"A service-role insert is RLS-exempt but NOT trigger-exempt and carries no `auth.uid()`, so it would land NULL — nothing inserts orders server-side today, but if order intake ever moves to the backend this trigger needs a carve-out."*

**Fix:** change the trigger to `new.user_id := coalesce(new.user_id, auth.uid())`. The backend resolves the caller from the optional `Authorization: Bearer` header using the existing `getUserFromToken()` and passes `user_id` explicitly. The spoofing hole the unconditional assignment was closing — any anon-key holder inserting an order carrying a stranger's `user_id` — closes by construction instead, because the browser no longer inserts orders at all.

### RLS is bypassed on the direct connection

The `orders_insert_guest_or_customer` policy currently enforces two things the backend would otherwise skip: `status = 'new'`, and *the merchant is active*. A suspended shop must not be able to take orders. Both checks move into `createOrder()`, asserted inside the transaction.

### Error contract

A voucher failure now rolls back the entire order. The customer is told the voucher is bad and retries without it, rather than silently keeping a discount on a voucher that was never consumed. The swallowed-error bug becomes impossible to write.

Domain errors map to distinct codes: `voucher_not_found`, `voucher_already_used`, `voucher_fully_used`, `merchant_inactive`, `merchant_not_found`.

Tracking preserves its current behaviour exactly: a wrong order number and a wrong phone both return a bare `null`. Distinguishing them would hand back the oracle the phone requirement exists to remove.

## Tests

Vitest against a local Supabase Postgres. None of these are expressible today.

- Two concurrent `createOrder` calls redeeming the same single-use voucher — exactly one succeeds.
- Two concurrent orders for the same merchant — distinct order numbers.
- Order insert fails mid-transaction — voucher not consumed, counter not burned.
- Order against a suspended merchant — rejected.
- Signed-in order carries `user_id`; guest order carries NULL.
- Tracking with a wrong phone and tracking with a wrong number are indistinguishable to the caller.

## Build configuration

`postgres` is added to `dependencies`, and — per the rule in `CLAUDE.md` — a matching `--external:postgres` flag is added to the backend's esbuild script. Omitting the flag bundles the driver. New required env var: `DATABASE_URL`.

## Out of scope

**The backend trusts the client's `total` and `discount`.** `POST /api/orders` accepts both from the request body. A malicious client can post a one-cent total. This is not a regression — the browser already inserts `total` straight into Postgres today, and RLS never checked it — but the new endpoint should not be the place this hole gets permanently enshrined either.

The fix is to move order pricing (`apps/frontend/src/pricing.ts`) into `@bitetime/shared` and have the backend recompute the total from the items, rejecting any mismatch. That is precisely what `@bitetime/shared` exists for: rules that must hold identically on both sides of the wire. It is a separate spec and should be the next one.

**Making the backend the sole gatekeeper for all data.** The remaining ~31 `supabase-js` table calls in `store.ts` stay where they are. That migration is unblocked by this work but not attempted by it.
