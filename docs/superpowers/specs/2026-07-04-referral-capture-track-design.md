# Referral Capture & Track — Design

**Date:** 2026-07-04
**Status:** Approved (brainstorm), pending implementation plan
**Builds on:** `docs/superpowers/specs/2026-07-04-merchant-referral-tab-design.md` (display-only tab, merged to main).
**Scope:** Close the referral loop — capture the referrer when a new shop signs up with a `?ref` code, and let the referrer see who they invited.

## Summary

Today the referral tab is display-only: a merchant sees and shares their code, but
signup ignores `?ref` and nothing is recorded. This feature captures the referring
code at signup and surfaces an "Invited shops" list to the referrer. Still **no reward
logic** — that is a separate, later feature.

## Goals

- Record which referral code a new merchant signed up under.
- Show the referrer a list of shops that used their code: name, signup date, status.

## Non-goals

- Reward / credit / discount logic when a referred shop activates.
- Editing or revoking a referral after signup.
- Attribution for shops that signed up before this feature (no backfill).

## Data model (migration)

A single new migration under `apps/backend/supabase/migrations/`:

- Add column `merchants.referred_by_code text` (nullable).
- Add an index on `referred_by_code` (the RPC filters by it).
- Create RPC `my_referred_shops()`:
  - `SECURITY DEFINER`, `search_path` hardened (`set search_path = ''`, schema-qualify
    tables), matching the project's existing definer-function convention.
  - Returns rows of safe columns only: shop `name`, `created_at`, `status`.
  - Filters `where referred_by_code = upper(left(replace(auth.uid()::text, '-', ''), 8))`
    — the caller's own code, derived in SQL identically to `referralCodeOf` in
    `store.ts` (strip dashes, first 8 chars, uppercase).
  - `grant execute` to `authenticated`; ordered newest-first.

Run `pnpm --filter @bitetime/backend db:migrate` (local) after adding the file so the
running app + PostgREST schema cache see the column and function.

### Why store the code, not a user id

The code is the first 8 hex of the referrer's user id — a lossy derivation that cannot
be cheaply reversed to a full user id. Storing the code string avoids a signup-time
profiles lookup, and the RPC re-derives the caller's own code from `auth.uid()` in SQL,
so matching needs no join and exposes no other user's row.

## Capture (signup)

- `SignupScreen.tsx` reads `ref` from `useSearchParams()` alongside the existing
  `plan` / `billing` / `canceled` params, and passes it to `createMerchant`.
- A pure helper `normalizeReferralCode(raw: string | null | undefined): string | null`
  (new `referralCode.ts`): trims, uppercases, returns the code only if it matches
  `^[0-9A-F]{8}$`, else `null`. Format concern only — no session/db knowledge, fully
  unit-testable.
- `createMerchant` (`store.ts`) gains an optional `referredByCode?: string` parameter.
  Before insert: `const code = normalizeReferralCode(referredByCode)`, then store `code`
  **only if** it is non-null and `code !== referralCodeOf(owner_id)` (self-referral guard,
  which needs the owner id and so lives here, not in the pure helper); otherwise store
  `null`. A code matching no existing merchant is stored harmlessly and never appears in
  anyone's list.
- The column is written only on the owner's own merchant insert — covered by the
  existing `merchants` INSERT RLS policy. No new write policy.

## Track (UI + data)

- `store.ts`: `fetchReferredShops(): Promise<ReferredShop[]>` calls the
  `my_referred_shops` RPC and maps rows to the `ReferredShop` type.
- `types.ts`: `ReferredShop = { name: string; created_at: string; status: MerchantStatus }`
  (reuse the existing merchant status union).
- `ReferralTab.tsx` gains an **Invited shops** section below the code/link card:
  - Total count heading.
  - One row per shop: name · signup date · status badge (pending / active / suspended),
    reusing existing merchant-status badge styling.
  - Localized empty state ("No invited shops yet" / zh) when the list is empty.
  - Loads via `useEffect` on mount; handles loading + error (toast) states.
  - All strings via `t(en, zh)`.

## Data flow

```
new user opens  .../merchant/signup?ref=CODE
  → SignupScreen reads ref, passes to createMerchant
  → createMerchant: normalize + validate + self-referral guard
  → INSERT merchants.referred_by_code = CODE (or null)
  ...
referrer opens Referral tab
  → fetchReferredShops()  →  my_referred_shops() RPC
  → matches rows where referred_by_code = caller's derived code
  → render count + list (name, date, status)
```

## Security

- Read is **only** through the `SECURITY DEFINER` RPC, filtered by the caller's
  `auth.uid()`-derived code, returning name/date/status. No broad SELECT policy is
  added, so a caller can never see shops that did not use their code, nor any column
  beyond the three returned.
- Definer function hardened (`search_path = ''`, schema-qualified) per the project's
  existing RLS/security convention.
- No PII beyond shop name, signup date, status.

## Error handling

- Invalid / malformed `?ref` → stored as `null`, signup proceeds normally (never blocks).
- RPC/network failure on the Track list → toast error, section shows a retry or empty
  fallback; the rest of the tab still works.
- No `account` → tab already returns null (unchanged from display-only).

## Testing

- **Unit (Vitest, no Supabase):** the pure normalize/validate helper — accepts 8-hex,
  rejects wrong length / non-hex / self-code; and `fetchReferredShops` row mapping.
- **RLS integration (`apps/backend/tests/rls`, needs local Supabase):** merchant A refers
  B (B inserts with `referred_by_code` = A's code); `my_referred_shops()` as A returns B;
  as unrelated C returns nothing; malformed/self codes never surface.
- **UI:** run-and-verify — sign up a shop with `?ref`, confirm it appears in the
  referrer's Invited shops list with correct status; empty state for a fresh referrer.

## Files touched

| File | Change |
|------|--------|
| `apps/backend/supabase/migrations/<ts>_referral_capture.sql` *(new)* | column + index + `my_referred_shops` RPC |
| `apps/frontend/src/referralCode.ts` *(new)* | pure `normalizeReferralCode` helper (`referralCodeOf` stays in `store.ts`) |
| `apps/frontend/src/referralCode.test.ts` *(new)* | helper unit tests |
| `apps/frontend/src/store.ts` | `createMerchant` param + validation + `fetchReferredShops` |
| `apps/frontend/src/merchant/SignupScreen.tsx` | read `?ref`, pass to `createMerchant` |
| `apps/frontend/src/merchant/ReferralTab.tsx` | Invited shops section |
| `apps/frontend/src/types.ts` | `ReferredShop` type |
| `apps/backend/tests/rls/*` *(new)* | referral capture/track isolation test |

No reward logic, no backfill, no change to the order/pricing paths.
