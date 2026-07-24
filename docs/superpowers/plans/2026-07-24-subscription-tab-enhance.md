# Subscription Tab Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle Settings → Subscription into a billing screen — a trial banner with a draining progress bar, a plan card with the price surfaced and a "Plan details" link, and a Summary grid of billing facts.

**Architecture:** Frontend-only, single-column. The pure module `subscriptionTabState.ts` gains a trial progress fraction (component renders, module decides — repo discipline). `SubscriptionTab.tsx` gains two local presentational components (`TrialBanner`, `SummaryGrid`) and a restructured plan-card header. No backend, no new Stripe reads, no new colors — only existing design tokens and data already on hand.

**Tech Stack:** React 19, TypeScript, Tailwind, shadcn-style `Button`/`Badge`, `lucide-react`, Vitest.

## Global Constraints

- Frontend-only. No backend changes, no new Stripe reads, no DB migration.
- Only data already available: `subscriptionTabState` output, `usePlatformPricing`, `formatMoney`, `fmtDate`. No card last4, no account credit, no overages.
- Every string bilingual via `t(en, zh)` from `useSession` — no bare user-visible strings.
- Reuse existing tokens only: `bg-surface-raised`, `border-[1.5px] border-rose-border`, `rounded-2xl`, `text-oxblood`, `text-text-secondary`, `text-text-tertiary`, `font-heading`. No new color values.
- Trial length source of truth: `TRIAL_TOTAL_DAYS = 7` (mirrors backend `trial_period_days: 7`, the only trial-granting path).
- UI verified by running the app (CLAUDE.md), not component tests. Only the pure module gets unit tests.

---

## File Structure

- **Modify** `apps/frontend/src/merchant/subscriptionTabState.ts` — add `TRIAL_TOTAL_DAYS` and a `progress` field on the `trial` state variant.
- **Modify** `apps/frontend/src/merchant/subscriptionTabState.test.ts` — cover the new `progress`.
- **Modify** `apps/frontend/src/merchant/SubscriptionTab.tsx` — add `TrialBanner` + `SummaryGrid` local components; restructure the plan-card header.

---

### Task 1: Trial progress in the pure module

**Files:**
- Modify: `apps/frontend/src/merchant/subscriptionTabState.ts`
- Test: `apps/frontend/src/merchant/subscriptionTabState.test.ts`

**Interfaces:**
- Consumes: existing `subscriptionTabState(billing, plan, now)`.
- Produces: the `trial` variant of `SubscriptionState` now carries `progress: number` in `[0,1]` — the fraction of the trial *remaining*, `= clamp(daysLeft / TRIAL_TOTAL_DAYS)`. `SubscriptionTab`'s banner reads `state.progress`.

- [ ] **Step 1: Write the failing tests**

Add to `subscriptionTabState.test.ts`, inside the top-level `describe('subscriptionTabState', …)` block (after the existing "clamps a trial that has already lapsed" test):

```typescript
  // The trial banner's bar drains as the trial runs out: fraction remaining = daysLeft / 7.
  it('reports trial progress as the fraction of the 7-day trial remaining', () => {
    const state = subscriptionTabState(
      { status: 'trialing', stripe_customer_id: 'cus_1', trial_ends_at: '2026-08-04T00:00:00Z' },
      'basic',
      NOW, // 2026-08-01 → 3 days left
    )
    expect(state).toMatchObject({ kind: 'trial', daysLeft: 3 })
    expect(state.kind === 'trial' && state.progress).toBeCloseTo(3 / 7)
  })

  it('drains trial progress to zero once the trial has lapsed', () => {
    const state = subscriptionTabState(
      { status: 'trialing', stripe_customer_id: 'cus_1', trial_ends_at: '2026-07-30T00:00:00Z' },
      'basic',
      NOW,
    )
    expect(state.kind === 'trial' && state.progress).toBe(0)
  })

  // A trial longer than 7 days (Stripe could be told otherwise) must not overflow the bar.
  it('clamps trial progress to a full bar when more than 7 days remain', () => {
    const state = subscriptionTabState(
      { status: 'trialing', stripe_customer_id: 'cus_1', trial_ends_at: '2026-08-11T00:00:00Z' },
      'basic',
      NOW, // 10 days left
    )
    expect(state.kind === 'trial' && state.progress).toBe(1)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bitetime/frontend test subscriptionTabState`
Expected: FAIL — `progress` is `undefined` (`toBeCloseTo`/`toBe` mismatch).

- [ ] **Step 3: Add the constant and the field**

In `subscriptionTabState.ts`, add the constant next to `const DAY = 24 * 60 * 60 * 1000`:

```typescript
// The trial length granted at superadmin approval (backend `trial_period_days: 7`), and the
// denominator of the banner's draining progress bar. The module does not assume the row matches
// it — progress is clamped, so a differently-sized trial shows a full or empty bar, never overflow.
const TRIAL_TOTAL_DAYS = 7
```

Change the `trial` variant in the `SubscriptionState` union (line ~55) to carry `progress`:

```typescript
    | { kind: 'trial'; plan: string; daysLeft: number; trialEndsAt: string; progress: number }
```

In the trial branch of `subscriptionTabState` (the `status === 'trialing'` block), compute and return it:

```typescript
  if (status === 'trialing' && billing?.trial_ends_at) {
    const msLeft = Math.max(0, new Date(billing.trial_ends_at).getTime() - now.getTime())
    const daysLeft = Math.floor(msLeft / DAY)
    return {
      ...actions,
      kind: 'trial',
      plan: tier,
      daysLeft,
      trialEndsAt: billing.trial_ends_at,
      progress: Math.min(1, Math.max(0, daysLeft / TRIAL_TOTAL_DAYS)),
    }
  }
```

- [ ] **Step 4: Run the full module test file to verify it passes**

Run: `pnpm --filter @bitetime/frontend test subscriptionTabState`
Expected: PASS — all existing tests plus the three new ones.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: no errors. (If `SubscriptionTab.tsx` referenced the trial variant by spread it is unaffected; `progress` is additive.)

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/merchant/subscriptionTabState.ts apps/frontend/src/merchant/subscriptionTabState.test.ts
git commit -m "feat(billing): carry trial progress in the subscription-tab state"
```

---

### Task 2: Trial banner

**Files:**
- Modify: `apps/frontend/src/merchant/SubscriptionTab.tsx`

**Interfaces:**
- Consumes: `state.kind === 'trial'` with `daysLeft`, `trialEndsAt`, `progress` from Task 1; `t`, `fmtDate`.
- Produces: a local `TrialBanner` component, rendered at the top of the returned tree when `state.kind === 'trial'`.

- [ ] **Step 1: Add the `Timer` icon to the lucide import**

At the top of `SubscriptionTab.tsx`, extend the existing lucide import:

```typescript
import { AlertTriangle, Check, Timer } from 'lucide-react'
```

- [ ] **Step 2: Add the `TrialBanner` component**

Place it above `export default function SubscriptionTab()`:

```typescript
/**
 * The trial callout — the one place a merchant sees "you are on a clock" without having to read
 * the plan sentence. A tinted card, not a rose one, so it reads as information rather than the
 * warning states the BillingBanner owns. The bar drains: `progress` is the fraction of the trial
 * still left, so a fuller bar means more runway.
 */
function TrialBanner({ daysLeft, trialEndsAt, progress }: {
  daysLeft: number; trialEndsAt: string; progress: number
}) {
  const { t } = useSession()
  const heading = daysLeft > 0
    ? t(`Your trial ends in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`,
        `试用还剩 ${daysLeft} 天`)
    : t('Your trial ends today', '试用今天结束')
  return (
    <div className="bg-cream border-[1.5px] border-rose-border rounded-2xl p-5 mb-6 w-full box-border max-sm:p-4">
      <div className="flex items-start gap-3">
        <Timer size={20} strokeWidth={2} className="text-oxblood shrink-0 mt-[2px]" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-heading text-[15px] font-medium text-oxblood">{heading}</p>
          <p className="text-[13px] text-text-secondary mt-0.5">
            {t(`Ending ${fmtDate(trialEndsAt)}.`, `${fmtDate(trialEndsAt)} 结束。`)}
          </p>
          {/* Draining bar: width tracks the fraction remaining. */}
          <div className="mt-3 h-1.5 w-full rounded-full bg-rose-border/40 overflow-hidden">
            <div
              className="h-full rounded-full bg-oxblood transition-[width] duration-300"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Render it at the top of the tab**

In `SubscriptionTab`'s return, immediately inside the outer `<div className="w-full">` and before the first `<div className={CARD}>`:

```tsx
    <div className="w-full">
      {state.kind === 'trial' && (
        <TrialBanner daysLeft={state.daysLeft} trialEndsAt={state.trialEndsAt} progress={state.progress} />
      )}
      <div className={CARD}>
```

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm --filter @bitetime/frontend typecheck && pnpm --filter @bitetime/frontend lint`
Expected: no errors. (`Timer` is used; `state.progress` is in scope because the `kind === 'trial'` guard narrows the union.)

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/SubscriptionTab.tsx
git commit -m "feat(billing): show a trial banner with a draining progress bar"
```

---

### Task 3: Summary grid

**Files:**
- Modify: `apps/frontend/src/merchant/SubscriptionTab.tsx`

**Interfaces:**
- Consumes: `state.canManage`, `state.kind`, `renewsAt`/`endsAt` (already derived in `SubscriptionTab`), `planPrice`, `per`, `pricing.currency`; `PortalButton` is not reused here (it renders a `Button`, not a link) — the Summary uses plain buttons styled as links that call `openBillingPortal`.
- Produces: a local `SummaryGrid` component, rendered after the "Your plan" card when `state.canManage`.

- [ ] **Step 1: Add the `SummaryGrid` component**

Place it above `export default function SubscriptionTab()`. It takes the already-formatted strings so it holds no pricing logic of its own:

```typescript
/**
 * The billing facts, laid out as labelled cells — the Glide "Summary" block, minus the cells we
 * do not hold (card last4, account credit). Payment method and history both route to the Stripe
 * portal: the last4 and the invoices live there, and duplicating them here would mean a second
 * source to keep honest. Only rendered for a shop with a live subscription (`canManage`).
 */
function SummaryGrid({ nextPayment, renewalLabel, renewalValue }: {
  nextPayment: string | null
  renewalLabel: string
  renewalValue: string
}) {
  const { t } = useSession()
  const [busy, setBusy] = useState(false)
  async function toPortal() {
    setBusy(true)
    try { window.location.assign(await openBillingPortal()) }
    catch (err: any) {
      toast.error(err?.message || t('Could not open the billing portal', '无法打开账单门户'))
      setBusy(false)
    }
  }
  const label = 'text-[11px] font-medium uppercase tracking-[0.08em] text-text-tertiary'
  const value = 'text-[14px] text-oxblood mt-1'
  const portalLink = 'text-[14px] text-oxblood underline underline-offset-2 mt-1 text-left disabled:opacity-60'
  return (
    <div className={CARD}>
      <h3 className={HEADING}>{t('Summary', '摘要')}</h3>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 max-sm:grid-cols-1">
        {nextPayment && (
          <div>
            <p className={label}>{t('Next payment', '下次付款')}</p>
            <p className={value}>{nextPayment}</p>
          </div>
        )}
        <div>
          <p className={label}>{renewalLabel}</p>
          <p className={value}>{renewalValue}</p>
        </div>
        <div>
          <p className={label}>{t('Payment method', '付款方式')}</p>
          <button type="button" className={portalLink} onClick={toPortal} disabled={busy}>
            {t('Manage in portal', '在门户中管理')}
          </button>
        </div>
        <div>
          <p className={label}>{t('Payment history', '付款记录')}</p>
          <button type="button" className={portalLink} onClick={toPortal} disabled={busy}>
            {t('Billing portal', '账单门户')}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Render it after the "Your plan" card**

In `SubscriptionTab`, `renewsAt` and `endsAt` are already computed. Immediately after the closing `</div>` of the first `<div className={CARD}>` (the "Your plan" card) and before the `{state.canUpgrade && (` block, add:

```tsx
      {state.canManage && (
        <SummaryGrid
          nextPayment={
            state.kind === 'ending' || !renewsAt
              ? null
              : t(`${formatMoney(planPrice, pricing.currency)} on ${fmtDate(renewsAt)}`,
                  `${formatMoney(planPrice, pricing.currency)}，${fmtDate(renewsAt)}`)
          }
          renewalLabel={state.kind === 'ending' ? t('Ends', '结束') : t('Renewal', '续订')}
          renewalValue={
            state.kind === 'ending'
              ? (endsAt ? fmtDate(endsAt) : t('End of current period', '本周期结束时'))
              : (renewsAt ? fmtDate(renewsAt) : t('Active', '有效'))
          }
        />
      )}
```

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm --filter @bitetime/frontend typecheck && pnpm --filter @bitetime/frontend lint`
Expected: no errors. (`openBillingPortal`, `toast`, `formatMoney`, `fmtDate`, `pricing`, `planPrice`, `renewsAt`, `endsAt` are all already imported/in scope in this file.)

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/merchant/SubscriptionTab.tsx
git commit -m "feat(billing): add a Summary grid of billing facts"
```

---

### Task 4: Plan-card header — price surfaced + "Plan details" link

**Files:**
- Modify: `apps/frontend/src/merchant/SubscriptionTab.tsx`

**Interfaces:**
- Consumes: existing `state.plan`, `planPrice`, `per`, `pricing.currency`, `t`. Adds an `ExternalLink` icon and a `/#pricing` link (new tab, matching `ShareStorefront`'s pattern).
- Produces: no new exports — an in-place restructure of the "Your plan" card's heading block.

- [ ] **Step 1: Add `ExternalLink` to the lucide import**

```typescript
import { AlertTriangle, Check, ExternalLink, Timer } from 'lucide-react'
```

- [ ] **Step 2: Restructure the plan-card header**

Replace the current heading block of the "Your plan" card — the `<h3 className={HEADING}>` line through the `</div>` that closes the `flex items-center gap-3 flex-wrap mb-3` row — with a header row that pushes the price to the top-right and adds the "Plan details" link:

```tsx
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h3 className={HEADING}>{t('Your plan', '您的方案')}</h3>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-heading text-[22px] text-oxblood">
                {state.plan === 'pro' ? 'Pro' : t('Basic', '基础版')}
              </span>
              <Badge variant={state.plan === 'pro' ? 'default' : 'outline'} className="uppercase tracking-[0.08em]">
                {state.plan === 'pro' ? 'Pro' : t('Basic', '基础版')}
              </Badge>
            </div>
            <a
              href="/#pricing" target="_blank" rel="noopener"
              className="inline-flex items-center gap-1 text-[13px] text-oxblood underline underline-offset-2 mt-2"
            >
              {t('Plan details', '方案详情')}
              <ExternalLink size={13} strokeWidth={2} aria-hidden />
            </a>
          </div>
          <span className="font-heading text-[18px] text-oxblood whitespace-nowrap shrink-0">
            {formatMoney(planPrice, pricing.currency)}<span className="text-[13px] text-text-secondary">{per}</span>
          </span>
        </div>
```

Note: the old inline price line inside the removed row (`{formatMoney(planPrice, pricing.currency)}{per}` as a `text-[13px]` span) is now the top-right price — do not leave a duplicate.

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm --filter @bitetime/frontend typecheck && pnpm --filter @bitetime/frontend lint`
Expected: no errors. `ExternalLink` is used; the old `HEADING`-with-inline-price layout is fully replaced.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/merchant/SubscriptionTab.tsx
git commit -m "feat(billing): surface the plan price and a Plan details link"
```

---

### Task 5: Run-and-verify in the browser

**Files:** none (verification only).

- [ ] **Step 1: Full checks green**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @bitetime/frontend test`
Expected: all pass.

- [ ] **Step 2: Drive the app**

Invoke the `verify` skill (per CLAUDE.md, UI is verified by running the app). Confirm, in the merchant dashboard Settings → Subscription tab:
  - **Trialing shop:** the trial banner shows above the plan card, heading reads "Your trial ends in N days", the bar is partially filled (draining), and the Summary grid shows Next payment / Renewal / portal links.
  - **Live Pro shop:** no banner; plan card shows "Pro", the price top-right, a working "Plan details" link (opens `/#pricing` in a new tab); Summary grid shows the renewal date and two working portal links; the action row (Manage / Switch to Basic / Cancel) is unchanged.
  - **Basic shop with a subscription:** Summary grid present; "Upgrade to Pro" card still shown below.
  - **Comped / no-subscription shop:** no Summary grid; plan card and upgrade pitch render without a dead portal button.
  - **Ending shop:** Summary "Renewal" cell reads "Ends {date}"; no "Next payment" cell.

- [ ] **Step 3: Note results**

Record what was observed for each state. No commit (verification only) unless a fix is needed.

---

## Self-Review

**Spec coverage:**
- Trial banner + draining bar → Task 1 (progress) + Task 2. ✓
- Plan card, price surfaced, Plan details link → Task 4. ✓
- Summary grid (next payment, renewal, payment method→portal, payment history→portal) → Task 3. ✓
- Upgrade card unchanged → untouched (no task modifies it). ✓
- Dropped cells (last4, credit, overages, support box) → not implemented, per spec. ✓
- Pure-logic `TRIAL_TOTAL_DAYS` + tested progress → Task 1. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `progress: number` defined on the trial variant in Task 1 and consumed as `state.progress` in Task 2. `SummaryGrid` props (`nextPayment`, `renewalLabel`, `renewalValue`) defined and passed in Task 3. `TrialBanner` props match Task 1's fields. ✓
