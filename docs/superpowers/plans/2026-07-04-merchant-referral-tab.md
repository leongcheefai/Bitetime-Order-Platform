# Merchant Referral Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a merchant their own referral code + a shareable signup link in a new "Referral" tab of Shop Settings.

**Architecture:** Frontend-only, display-only. A pure helper builds the signup URL from a code + origin. A standalone `ReferralTab` component (mirroring `ShareStorefront.tsx`) derives the code client-side via the existing `referralCodeOf(account.id)`, renders code + link boxes with copy/QR, and is mounted as a fourth tab in `ShopSettings.tsx`. No DB, backend, `store.ts` write, or signup change.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, shadcn-style UI (`@/components/ui/*`), `qrcode.react`, `sonner` toasts, lucide-react icons.

## Global Constraints

- TypeScript strict; frontend uses `moduleResolution: bundler` (extensionless relative imports).
- Every user-facing string uses `t(en, zh)` from `useSession()`.
- Referral code MUST be derived as `referralCodeOf(account.id)` — the **auth user id** — to match the value stored at `store.ts:301`. Do not read `profile.referral_code` (not selected by `fetchProfileByUserId`).
- `?ref` on the signup link is a future hook only — do NOT wire signup crediting.
- Mirror `ShareStorefront.tsx` for look + copy interaction. Reuse `bg-surface-sunken` / `border-clay-border` / `text-rose-muted` classes.

---

### Task 1: `referralSignupUrl` pure helper

**Files:**
- Create: `apps/frontend/src/referralSignupUrl.ts`
- Test: `apps/frontend/src/referralSignupUrl.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `referralSignupUrl(code: string, origin: string): string` → `${origin}/merchant/signup?ref=<encoded code>`, trailing slash on origin stripped.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/referralSignupUrl.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { referralSignupUrl } from './referralSignupUrl'

describe('referralSignupUrl', () => {
  it('builds a signup URL carrying the ref query param', () => {
    expect(referralSignupUrl('AB12CD34', 'https://bitetime.co'))
      .toBe('https://bitetime.co/merchant/signup?ref=AB12CD34')
  })

  it('strips a trailing slash from origin', () => {
    expect(referralSignupUrl('AB12CD34', 'https://bitetime.co/'))
      .toBe('https://bitetime.co/merchant/signup?ref=AB12CD34')
  })

  it('url-encodes the code', () => {
    expect(referralSignupUrl('a b', 'https://x.co'))
      .toBe('https://x.co/merchant/signup?ref=a%20b')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bitetime/frontend exec vitest run src/referralSignupUrl.test.ts`
Expected: FAIL — cannot resolve `./referralSignupUrl`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/frontend/src/referralSignupUrl.ts`:

```ts
// Builds the merchant signup URL carrying a referral code. Pure + DOM-free so it
// is unit-testable; callers pass window.location.origin at the call site.
// The `ref` param is a future crediting hook — signup does not yet read it.
export function referralSignupUrl(code: string, origin: string): string {
  const base = origin.replace(/\/$/, '')
  return `${base}/merchant/signup?ref=${encodeURIComponent(code)}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bitetime/frontend exec vitest run src/referralSignupUrl.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/referralSignupUrl.ts apps/frontend/src/referralSignupUrl.test.ts
git commit -m "feat(referral): pure referralSignupUrl helper + tests"
```

---

### Task 2: `ReferralTab` component

**Files:**
- Create: `apps/frontend/src/merchant/ReferralTab.tsx`

**Interfaces:**
- Consumes: `useSession()` → `{ t, account }`; `referralCodeOf(userId: string): string` from `../store`; `referralSignupUrl(code, origin)` from Task 1.
- Produces: `default export function ReferralTab(): JSX.Element | null` — takes **no props** (read-only, never dirty).

- [ ] **Step 1: Write the component**

Create `apps/frontend/src/merchant/ReferralTab.tsx`:

```tsx
import { useState } from 'react'
import { Copy, QrCode } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { referralCodeOf } from '../store'
import { referralSignupUrl } from '../referralSignupUrl'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// Display-only referral card (mirrors ShareStorefront). The code is derived from the
// signed-in user's auth id so it matches profiles.referral_code written at signup.
export default function ReferralTab() {
  const { t, account } = useSession()
  const [qrOpen, setQrOpen] = useState(false)
  if (!account) return null

  const code = referralCodeOf(account.id)
  if (!code) return null
  const link = referralSignupUrl(code, window.location.origin)

  const copyText = async (text: string, ok: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(ok)
    } catch {
      toast.error(t('Could not copy — copy it manually', '无法复制 — 请手动复制'))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Invite & earn', '邀请赚奖励')}</CardTitle>
        <CardDescription>
          {t('Share your referral code with other shop owners.', '把您的推荐码分享给其他店主。')}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-rose-muted">{t('Your referral code', '您的推荐码')}</span>
          <div className="rounded-lg border-[1.5px] border-clay-border bg-surface-sunken px-3 py-2 font-mono text-[15px] tracking-wider break-all text-ink">
            {code}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-rose-muted">{t('Invite link', '邀请链接')}</span>
          <div className="rounded-lg border-[1.5px] border-clay-border bg-surface-sunken px-3 py-2 font-mono text-[13px] break-all text-ink">
            {link}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="default" size="sm" className="w-auto" onClick={() => copyText(code, t('Code copied', '推荐码已复制'))}>
            <Copy /> {t('Copy code', '复制推荐码')}
          </Button>
          <Button variant="outline" size="sm" className="w-auto" onClick={() => copyText(link, t('Link copied', '链接已复制'))}>
            <Copy /> {t('Copy link', '复制链接')}
          </Button>
          <Button variant="outline" size="sm" className="w-auto" onClick={() => setQrOpen(true)}>
            <QrCode /> {t('QR code', '二维码')}
          </Button>
        </div>
      </CardContent>

      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Scan to sign up', '扫码注册')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="rounded-lg bg-white p-3">
              <QRCodeSVG value={link} size={180} />
            </div>
            <p className="font-mono text-[12px] break-all text-center text-rose-muted">{link}</p>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS — no type errors. (Confirms `account` exists on the session value and imports resolve.)

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/merchant/ReferralTab.tsx
git commit -m "feat(referral): ReferralTab card — code + invite link + copy/QR"
```

---

### Task 3: Wire the Referral tab into Shop Settings

**Files:**
- Modify: `apps/frontend/src/merchant/ShopSettings.tsx` (line 15 `TabKey`, top imports, `TABS` array ~48-52, render block ~64-66)

**Interfaces:**
- Consumes: `ReferralTab` default export from Task 2.
- Produces: a `referral` tab visible in the Shop Settings tab bar.

- [ ] **Step 1: Add the import**

In `apps/frontend/src/merchant/ShopSettings.tsx`, add after line 13 (`import { isDirty, ... } from './settingsDirty'`):

```tsx
import ReferralTab from './ReferralTab'
```

- [ ] **Step 2: Extend the TabKey union**

Change line 15 from:

```tsx
type TabKey = 'shipping' | 'payment' | 'notifications'
```

to:

```tsx
type TabKey = 'shipping' | 'payment' | 'notifications' | 'referral'
```

- [ ] **Step 3: Add the tab to the TABS array**

Change the `TABS` array (lines 48-52) from:

```tsx
  const TABS: { key: TabKey; label: string }[] = [
    { key: 'shipping', label: t('Shipping', '运费') },
    { key: 'payment', label: t('Payment', '付款') },
    { key: 'notifications', label: t('Notifications', '通知') },
  ]
```

to:

```tsx
  const TABS: { key: TabKey; label: string }[] = [
    { key: 'shipping', label: t('Shipping', '运费') },
    { key: 'payment', label: t('Payment', '付款') },
    { key: 'notifications', label: t('Notifications', '通知') },
    { key: 'referral', label: t('Referral', '推荐') },
  ]
```

- [ ] **Step 4: Render the tab**

After the notifications render line (line 66 `{tab === 'notifications' && <NotificationsTab onDirtyChange={setDirty} />}`), add:

```tsx
      {tab === 'referral' && <ReferralTab />}
```

(No `onDirtyChange` — the referral tab is read-only and never dirty.)

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @bitetime/frontend typecheck && pnpm --filter @bitetime/frontend lint`
Expected: PASS.

- [ ] **Step 6: Run-and-verify in the app**

Run: `pnpm dev` (frontend on :5173). Sign in as a merchant → dashboard → **Settings** → **Referral** tab. Confirm:
- The referral code shows (8 uppercase hex chars).
- The invite link shows as `<origin>/merchant/signup?ref=<code>`.
- `Copy code`, `Copy link` fire success toasts and place the right text on the clipboard.
- `QR code` opens a dialog with a scannable QR of the link.
- Toggle language to 中文 → labels render in Chinese.
- Switching away from Referral to another tab is not blocked (never dirty).

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/merchant/ShopSettings.tsx
git commit -m "feat(referral): add Referral tab to Shop Settings"
```

---

## Self-Review

**Spec coverage:**
- Placement (new Settings tab) → Task 3. ✓
- Code derived from `account.id` via `referralCodeOf` → Task 2 constraint + code. ✓
- `ReferralTab` own file mirroring ShareStorefront → Task 2. ✓
- Pure `referralSignupUrl` + unit test → Task 1. ✓
- Copy code / Copy link / QR → Task 2. ✓
- Localised `t(en, zh)` → all strings in Task 2/3. ✓
- No signup/DB/backend change → no such task exists. ✓
- Impersonation caveat → acceptable per spec; code uses `account` (own user), documented in component comment. ✓
- Run-and-verify UI check → Task 3 Step 6. ✓

**Placeholder scan:** none — all steps carry real code/commands.

**Type consistency:** `referralSignupUrl(code, origin)` signature identical across Task 1 (def) and Task 2 (use); `referralCodeOf(account.id)` matches `store.ts:388` signature; `ReferralTab` default export imported/rendered consistently in Task 2/3.
