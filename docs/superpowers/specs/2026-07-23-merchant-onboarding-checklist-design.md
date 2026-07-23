# Merchant onboarding checklist — design (#102)

## Goal

Give a newly-approved merchant a clear, guided path to their first order. A 3-step
checklist appears on the dashboard Overview and walks them "hand to hand" — each
unchecked step jumps to the section that completes it. When all three are done the
card celebrates and then dismisses forever.

The three steps, from the issue:

1. Add your first product
2. Set your pickup / delivery
3. Share your order link

When complete:

> 🎉 Your shop is ready! Copy your order link and start accepting orders.

## Placement

Render a new `<OnboardingChecklist>` inside `DashboardInner` (`Dashboard.tsx`),
above the animated section content, shown only when `section === 'overview'`.

Rendering it in `Dashboard.tsx` — not inside `Overview.tsx` — gives it direct
access to `selectSection` (the guarded section switch) so a step row can jump to
`products` / `settings` without threading a callback through `Overview`. It sits
below `BillingBanner`, above the `<div key={section}>` swap.

## Completion signals

| Step | Done when | Source |
|------|-----------|--------|
| Add first product | product count > 0 | derived — `fetchProducts(merchant.id)` |
| Set pickup / delivery | `merchant.onboarding_shipping_set` | persisted flag, flipped on first **Shipping** tab save |
| Share order link | `merchant.onboarding_link_shared` | persisted flag, flipped on Copy / Open storefront / QR in `ShareStorefront` |

"Set pickup / delivery" maps to the **Shipping** settings tab (methods + pickup
address + delivery rates), NOT the Fulfilment tab (order dates / timezone). The
step jump targets the `settings` section, which opens on the Shipping tab by
default (`ShopSettings` `useState<TabKey>('shipping')`).

Product completion is derived rather than flagged: it is cheap to read and always
truthful (a shop with a live product has done that step, whenever it happened).
The other two have no honest derivable signal — every shop ships with default
fulfilment methods on, and "shared a link" is an action that persists no state —
so each gets an explicit persisted flag flipped by the merchant's own action.

## Schema

New migration `apps/backend/supabase/migrations/<ts>_merchant_onboarding.sql`,
three `boolean not null default false` columns on `merchants`:

```sql
alter table merchants
  add column onboarding_shipping_set boolean not null default false,
  add column onboarding_link_shared  boolean not null default false,
  add column onboarding_dismissed    boolean not null default false;

-- Every existing shop predates onboarding and must never be shown the checklist.
-- New shops created after this migration start with all three false.
update merchants set onboarding_dismissed = true;
```

Three booleans (not a `timestamptz` done-marker) keeps validation uniform with the
existing `tax_enabled` pattern and needs no timestamp parsing on the write path.
The backfill `update` dismisses the card for every current shop; only shops created
after the migration see the checklist.

## Card states

- **Incomplete** — the checklist. Each row is a button:
  - unchecked → shows ☐, jumps to the completing section on click
    (Add product → `products`; Set pickup/delivery → `settings`; Share link →
    `overview`, where `ShareStorefront` renders directly below — see "Share-link
    row target").
  - checked → shows ✔ and is inert (or still navigable, harmless).
  - Progress line: `N / 3 Complete`.
- **All three done** — flips to the celebration: "🎉 Your shop is ready!" with a
  Copy-link shortcut and a **Got it** button. Clicking **Got it** sets
  `onboarding_dismissed = true` (via `updateMerchantConfig` + `refreshMerchant`),
  removing the card permanently.
- **Dismissed** — component returns `null`.

The card renders `null` whenever `merchant.onboarding_dismissed` is true, so the
celebration is the only path that sets it; a merchant who never finishes keeps
seeing the checklist (acceptable — it is the nudge).

### Share-link row target

`ShareStorefront` already sits at the top of `Overview`, directly below where the
checklist renders. The "Share your order link" row jumps to the `overview` section
(a no-op if already there) — the link card is immediately visible below. No new
scroll-to-anchor machinery. The flag is flipped by the Copy / Open / QR buttons on
`ShareStorefront` itself, not by clicking the checklist row.

## Wiring

Files touched (5 + 1 migration):

1. **Migration** — the three columns + backfill above. Apply with `db:migrate`.
2. **`apps/backend/src/writes.ts`** — add `onboarding_shipping_set`,
   `onboarding_link_shared`, `onboarding_dismissed` to `MERCHANT_CONFIG_FIELDS`,
   and a boolean-type check in `pickMerchantConfig` (same shape as the existing
   `pickup_enabled` / `delivery_enabled` / `express_enabled` loop — a non-boolean
   is refused, never coerced).
3. **`apps/frontend/src/types.ts`** — three optional booleans on `Merchant`.
4. **`apps/frontend/src/merchant/ShopSettings.tsx`** — `ShippingTab.save()` adds
   `onboarding_shipping_set: true` to its `updateMerchantConfig` payload. Fire it
   unconditionally on save; the column is already true after the first, so the
   write is idempotent.
5. **`apps/frontend/src/merchant/ShareStorefront.tsx`** — on Copy / Open / QR, if
   `!merchant.onboarding_link_shared`, call
   `updateMerchantConfig(merchant.id, { onboarding_link_shared: true })` then
   `refreshMerchant()`. Guarded so it fires at most once; a failed flag write must
   not block the copy/open the merchant asked for (fire-and-forget or catch).
6. **`apps/frontend/src/merchant/OnboardingChecklist.tsx`** (new) — the card, and
   its wire-in at `Dashboard.tsx`.

## OnboardingChecklist component

- Props: `onNavigate: (section: string) => void`.
- Reads `merchant`, `t`, `refreshMerchant` from `useSession()`.
- Fetches its own product count via `fetchProducts(merchant.id)` in an effect
  (cheap; Overview fetches products separately for stats, no shared state needed).
- Returns `null` if `!merchant` or `merchant.onboarding_dismissed`.
- Computes `steps = [product, shipping, link]` booleans and `doneCount`.
- Renders the checklist (incomplete) or celebration (all done).
- **Got it** → `updateMerchantConfig(id, { onboarding_dismissed: true })` +
  `refreshMerchant()`.
- Bilingual via `t(en, zh)`, matching every other merchant surface.
- Visual language: reuse the existing card styling
  (`bg-surface-raised border-[1.5px] border-rose-border rounded-2xl`) and
  `lucide-react` icons, consistent with `ShareStorefront` / settings cards.

## Testing

- Unit: a pure `onboardingSteps(merchant, productCount)` helper returning the three
  booleans + `doneCount` + `allDone`, unit-tested (`OnboardingChecklist.test.ts` or
  a co-located `onboardingSteps.ts` + test) — the derivation is the logic worth
  pinning; the card is verified by running the app.
- Backend: `pickMerchantConfig` boolean handling is covered by the existing
  writes-allowlist test pattern; add cases for the three new fields (accept
  boolean, refuse non-boolean).
- Run-and-verify (per CLAUDE.md): a fresh merchant sees the card at 0/3, each action
  ticks its step, all-3 flips to the celebration, **Got it** dismisses it and it
  stays gone after reload. An existing (backfilled) merchant never sees it.

## Out of scope

- Full-screen onboarding takeover / dedicated nav item (rejected in favour of the
  Overview card).
- Any onboarding email / drip (the `trial-expiry-suspension-design` Resend work is
  separate).
- Re-showing the checklist after dismissal.
