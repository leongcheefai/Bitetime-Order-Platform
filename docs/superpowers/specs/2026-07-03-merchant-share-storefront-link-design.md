# Merchant storefront link sharing — design

**Date:** 2026-07-03
**Status:** Approved

## Problem

The merchant dashboard gives merchants no way to share their storefront link
with customers. The storefront URL exists (`/s/:slug`) but only appears as
non-interactive text (`/s/{slug}`) in the dashboard shell header
(`DashboardShell.tsx:144`) — it is not a full URL, not copyable, and offers no
share affordance.

## Goal

Give merchants a discoverable way to copy, open, and QR-share their live
storefront link from the dashboard.

## Scope

In scope: copy link, open storefront in new tab, QR code (in a dialog).
Out of scope: WhatsApp / social share buttons, link analytics, custom short
links, storefront link in the header.

## Placement

A share card rendered as the **first block in the Overview tab**
(`apps/frontend/src/merchant/Overview.tsx`, above the stat grid). High
discoverability, and enough room for the copy/open/QR actions.

## Components

### `apps/frontend/src/merchant/ShareStorefront.tsx` (new)

Self-contained card. Depends on: `useSession` (for `merchant`, `t`), existing
UI primitives (`Card`, `Button`, `Dialog`, `sonner` toast), `qrcode.react`, and
the `storefrontUrl` helper.

Card contents:

- **Title:** `t('Your storefront link', '您的店铺链接')`
- **URL display:** full storefront URL, monospace, wrapped (no truncation that
  hides the URL).
- **Copy link button:** calls `navigator.clipboard.writeText(url)` inside a
  `try/catch`; success → `toast.success`, failure → `toast.error`. Labels via `t`.
- **Open button:** anchor with `target="_blank" rel="noopener"` to the live URL.
- **QR button:** opens a `Dialog` containing `QRCodeSVG` (~180px), the URL text,
  and `t('Scan to open storefront', '扫码打开店铺')`.

**Status gating:** the storefront route is only reachable when
`merchant.status === 'active'` (gated in `MerchantProvider`). When the merchant
is not active, the card shows a muted note
`t('Storefront goes live after approval', '店铺获批后上线')` and hides the
Copy / Open / QR actions, since the link would 404.

### `storefrontUrl(slug, origin)` helper

Pure function returning `${origin}/s/${slug}`. Lives in a small module
(e.g. `apps/frontend/src/storefrontUrl.ts`) so it is unit-testable without a DOM.
Call site passes `window.location.origin`.

## Data flow

`Overview` renders `<ShareStorefront />` → component reads `merchant` from
`useSession()` → builds URL via `storefrontUrl(merchant.slug, window.location.origin)`
→ user actions (copy / open / QR) operate on that URL. No network calls, no new
store functions, no DB changes.

## Dependencies

Add `qrcode.react` (pure-JS, SVG output, no canvas) to
`apps/frontend/package.json`.

## Error handling

- Clipboard write wrapped in `try/catch` with an error toast fallback (covers
  insecure-context / permission-denied cases).
- Missing `merchant` — `Overview` already guards on `merchant?.id`; the card
  renders nothing meaningful without a merchant (guard defensively).

## Localization

All user-facing strings pass through `t(en, zh)` per project convention.

## Testing

- Unit test `storefrontUrl` (`apps/frontend/src/storefrontUrl.test.ts`):
  correct path, slug interpolation, no double slashes.
- UI verified by run-and-verify (copy toast, open new tab, QR dialog, pending
  vs active states) — no component tests per project convention.
