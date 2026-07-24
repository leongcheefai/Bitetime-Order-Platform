# Subscription tab enhancement — design

**Date:** 2026-07-24
**Scope:** `apps/frontend/src/merchant/SubscriptionTab.tsx`, `apps/frontend/src/merchant/subscriptionTabState.ts` (+ its test)

## Goal

Restyle Settings → Subscription to read like a real billing screen (Glide-reference
inspired): a trial banner, a "Your plan" card with the price surfaced, and a Summary
grid of billing facts. Frontend-only — no backend, no new Stripe reads.

## Decisions (locked)

- **Layout:** single-column, richer. Keep the current stacked-card structure; add a
  trial banner and a Summary grid. No two-column desktop split.
- **Summary cells:** only data we already hold. No card last4 fetch, no account credit.
- **Support box:** skipped — the floating `FeedbackFab` already covers every dashboard
  screen.
- **Trial progress bar:** drains — fill = `daysLeft / 7` (time remaining).

## Non-goals

Account credit, overages toggle, card brand/last4, "End Trial", "Delete team". The
metered-billing bits don't map (we're not usage-metered); cancel already lives in the
action-button row.

## Layout, top to bottom

All in `SubscriptionTab.tsx`. Reuse existing tokens (`bg-surface-raised`,
`border-rose-border`, `rounded-2xl`, `text-oxblood`, `text-text-secondary`,
`text-text-tertiary`, `font-heading`, `Badge`, `Button`). No new colors.

### 1. Trial banner — new, conditional (`state.kind === 'trial'`)

A tinted callout above the plan card. Contents:
- Clock icon (`lucide-react`, e.g. `Clock`/`Timer`).
- Heading: *"Your trial ends in N days"* (`state.daysLeft`; handle the `0` / "today"
  case with the existing trial copy).
- Sub-line: reuse the current trial sentence (*ending {fmtDate(trialEndsAt)}*).
- A thin progress bar, filled `daysLeft / 7`, using a subtle branded wash — no new hue.

Rendered only for trialing shops; absent otherwise.

### 2. "Your plan" card — restructured, logic unchanged

- Plan name + Pro/Basic `Badge` on the left; **price pushed to the top-right** (Glide's
  `$249` position), `formatMoney(planPrice) + per`.
- A *"Plan details"* link under the name → marketing pricing page (existing route).
- **Keep unchanged:** the state sentence (renews / ending / past-due / trial / none), the
  pending-downgrade line, and the entire action-button row (Manage / Keep / Switch to
  Basic / Cancel). That logic is correct and is not touched.

### 3. "Summary" grid — new, conditional (`state.canManage`)

New card, shown only when a live subscription exists. Labeled cells, Glide style
(uppercase micro-label above, value below), responsive grid (2-up desktop, 1-up mobile):

- **NEXT PAYMENT** — `{formatMoney(planPrice)} on {fmtDate(renewsAt)}`; omitted when
  `kind === 'ending'`.
- **RENEWAL** — `{fmtDate(renewsAt)}`, or *Ends {fmtDate(endsAt)}* when `kind === 'ending'`.
- **PAYMENT METHOD** — *Manage in portal* link (via `PortalButton`/`openBillingPortal`).
  No last4 — that was the dropped cell.
- **PAYMENT HISTORY** — *Billing portal* link → invoices (same portal).

### 4. "Upgrade to Pro" card — unchanged logic

`state.canUpgrade` gate and both routes (portal vs checkout) stay as-is. Heading restyled
only for visual consistency with the cards above.

## Pure-logic change

`subscriptionTabState.ts`:
- Add a `TRIAL_TOTAL_DAYS = 7` constant (mirrors the backend's `trial_period_days: 7`,
  the only trial-granting path — `app.ts` approve-merchant).
- Surface a progress fraction on the `trial` variant (e.g. `progress: number` in `[0,1]`,
  `= min(1, max(0, daysLeft / TRIAL_TOTAL_DAYS))`), so the bar is derived by the module,
  not the component — and covered in `subscriptionTabState.test.ts`.

Rationale: matches repo discipline (component renders, module decides) and keeps the one
new piece of arithmetic under test.

## Testing

- Unit: extend `subscriptionTabState.test.ts` for the new trial `progress` (full at day 0
  elapsed, drains toward 0, clamped).
- UI: run-and-verify per CLAUDE.md (`/verify` skill) — trialing shop shows banner + bar;
  live Pro shop shows Summary grid with correct dates and working portal links; basic
  shop shows the upgrade card and no Summary.

## Risk / notes

- File already ~460 lines with several local components. Add `TrialBanner` and
  `SummaryGrid` as local components in the same file for now; split into a
  `subscription/` folder only if it balloons further.
- Progress bar is cosmetic: if a future trial length differs from 7 the bar is slightly
  off but harmless. The constant is the single source and easy to change.
