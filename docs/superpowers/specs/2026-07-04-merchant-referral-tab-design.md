# Merchant Referral Tab — Design

**Date:** 2026-07-04
**Status:** Approved (brainstorm), pending implementation plan
**Scope:** Frontend only. Display-only referral code + shareable signup link in the merchant Shop Settings.

## Summary

Merchants each already have a referral code (derived from their auth user id via
`referralCodeOf`). Surface it in the merchant dashboard so a merchant can view, copy,
and share it — Wise "invite & earn" style. This is **display-only**: no reward logic,
no signup crediting, no tracking, no DB or backend change.

## Goals

- Show the merchant their own referral code in Shop Settings.
- Give a copyable/shareable signup link that carries the code as a query param.
- Match the existing `ShareStorefront.tsx` look and interaction (Card + copy + QR).

## Non-goals (explicitly out of scope)

- Crediting a referrer when a new merchant signs up (`SignupScreen` still ignores
  `?ref`; `createMerchant` still persists nothing). The `?ref` param is a **future
  hook** only.
- Invited-friends list / tracking table.
- "They get / You get" reward blurbs.
- Any DB migration, `store.ts` write, or backend endpoint.

## Placement

Add a fourth tab to `apps/frontend/src/merchant/ShopSettings.tsx`:

```
Shipping | Payment | Notifications | Referral
```

- Extend the tab list + guard() with a `referral` entry.
- Render `<ReferralTab />` when active.
- `ReferralTab` lives in its **own file** `merchant/ReferralTab.tsx` (self-contained,
  like `ShareStorefront.tsx`), imported into `ShopSettings.tsx`. The other tabs are
  colocated inline, but this one is standalone to keep it isolated and testable.

## Referral code source (no DB change)

- The stored code is written at `store.ts:301` as `referralCodeOf(user.id)` — the
  **auth user id**. To display the *same* code, derive it client-side from the auth
  user id.
- `useSession()` exposes `account: User`. Use `referralCodeOf(account.id)`.
- `profile` (from `fetchProfileByUserId`) does **not** select `referral_code`, so do
  not read it from there — derive instead. No new fetch, no migration.

### Impersonation caveat

While a superadmin is impersonating a shop (`impersonatedMerchant` set), `account` is
still the superadmin's own user, so the code shown would be the superadmin's, not the
impersonated merchant's. Acceptable for MVP — this tab is for a merchant viewing their
own settings. If `account.id` is unavailable, render nothing (guard).

## Component: `ReferralTab`

Mirrors `apps/frontend/src/merchant/ShareStorefront.tsx`.

Structure:
- `Card` with `CardHeader` (title *"Invite & earn"* / *"邀请赚奖励"*, short description).
- **Referral code** in a bordered `bg-surface-sunken` mono box.
- **Share link** in a second bordered box: the signup URL with `?ref=CODE`.
- Action buttons (only when a code exists):
  - `Copy code` — copies the raw code.
  - `Copy link` — copies the signup URL.
  - `QR code` — opens a `Dialog` with `QRCodeSVG` of the signup URL (reuse pattern).
- Copy handlers use `navigator.clipboard.writeText` in try/catch with `toast.success`
  / `toast.error`, identical to `ShareStorefront`.
- All user-facing strings via `t(en, zh)`.

## Pure helper + test

Add `apps/frontend/src/referralSignupUrl.ts`, mirroring `storefrontUrl.ts`:

```ts
export function referralSignupUrl(code: string, origin: string): string {
  return `${origin}/merchant/signup?ref=${encodeURIComponent(code)}`
}
```

- Unit test `referralSignupUrl.test.ts`: builds the expected URL, encodes the code.
- `referralCodeOf` is already testable if additional coverage is wanted.

## Data flow

```
useSession() → account.id
  → referralCodeOf(account.id)            = CODE
  → referralSignupUrl(CODE, origin)       = share link
  → render code box + link box + copy/QR
```

Origin comes from `window.location.origin` (same as `ShareStorefront`).

## Error handling

- No `account` / no derivable code → `ReferralTab` renders nothing (or a muted
  placeholder), matching `ShareStorefront`'s early `return null`.
- Clipboard failure → `toast.error` fallback prompting manual copy.

## Testing

- **Unit:** `referralSignupUrl` (Vitest).
- **UI:** run-and-verify — open dashboard → Settings → Referral tab; confirm code
  shows, Copy code / Copy link / QR work, and Chinese strings render under `zh`.

## Files touched

| File | Change |
|------|--------|
| `apps/frontend/src/merchant/ShopSettings.tsx` | add `Referral` tab + render `ReferralTab` |
| `apps/frontend/src/merchant/ReferralTab.tsx` *(new)* | the tab component |
| `apps/frontend/src/referralSignupUrl.ts` *(new)* | pure URL helper |
| `apps/frontend/src/referralSignupUrl.test.ts` *(new)* | unit test |

No changes to `store.ts`, `SignupScreen.tsx`, `createMerchant`, DB migrations, or backend.
