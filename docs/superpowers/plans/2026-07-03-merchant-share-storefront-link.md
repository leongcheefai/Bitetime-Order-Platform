# Merchant Storefront Link Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a share card to the merchant dashboard Overview tab so merchants can copy, open, and QR-share their `/s/:slug` storefront link.

**Architecture:** A pure `storefrontUrl(slug, origin)` helper builds the URL. A new `ShareStorefront` card component (copy / open / QR-in-dialog) reads the active merchant from `useSession()` and renders as the first block of `Overview`. No network, store, or DB changes.

**Tech Stack:** React 19 + TypeScript, Vite, Vitest, existing UI primitives (`Card`, `Button`, `Dialog`, `sonner`), new dep `qrcode.react`.

## Global Constraints

- All paths relative to `apps/frontend/` unless prefixed. Run all `pnpm` commands from repo root.
- TypeScript strict. Frontend uses `moduleResolution: bundler` — extensionless relative imports; `@/*` alias maps to `./src/*`.
- Every user-facing string passes through `t(en, zh)` from `useSession()`. `t = (en, zh?) => lang === 'zh' ? (zh ?? en) : en`.
- Toasts: `import { toast } from 'sonner'` → `toast.success(...)` / `toast.error(...)`.
- Merchant type: `{ name: string; slug: string; status: 'pending'|'active'|'suspended'; currency?: string; ... }` (`src/types.ts`).
- Dialog is controlled: `<Dialog open={bool} onOpenChange={fn}>`.
- Commit after each task. End commit messages with `Claude-Session: https://claude.ai/code/session_01DwM2o8oeoMdu62P8yQFNCK`.

---

### Task 1: `storefrontUrl` pure helper + unit test

**Files:**
- Create: `apps/frontend/src/storefrontUrl.ts`
- Test: `apps/frontend/src/storefrontUrl.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `storefrontUrl(slug: string, origin: string): string` — returns `${origin}/s/${slug}`, tolerant of a trailing slash on `origin`.

- [ ] **Step 1: Write the failing test**

`apps/frontend/src/storefrontUrl.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { storefrontUrl } from './storefrontUrl'

describe('storefrontUrl', () => {
  it('joins origin and slug into the storefront path', () => {
    expect(storefrontUrl('joes-cafe', 'https://bitetime.co')).toBe('https://bitetime.co/s/joes-cafe')
  })

  it('does not produce a double slash when origin has a trailing slash', () => {
    expect(storefrontUrl('joes-cafe', 'https://bitetime.co/')).toBe('https://bitetime.co/s/joes-cafe')
  })

  it('interpolates the exact slug', () => {
    expect(storefrontUrl('shop-42', 'http://localhost:5173')).toBe('http://localhost:5173/s/shop-42')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bitetime/frontend test -- storefrontUrl`
Expected: FAIL — cannot resolve `./storefrontUrl` / `storefrontUrl is not a function`.

- [ ] **Step 3: Write minimal implementation**

`apps/frontend/src/storefrontUrl.ts`:
```ts
// Builds the public storefront URL for a merchant slug. Pure + DOM-free so it
// is unit-testable; callers pass window.location.origin at the call site.
export function storefrontUrl(slug: string, origin: string): string {
  const base = origin.replace(/\/$/, '')
  return `${base}/s/${slug}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bitetime/frontend test -- storefrontUrl`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/storefrontUrl.ts apps/frontend/src/storefrontUrl.test.ts
git commit -m "feat(merchant): add storefrontUrl helper

Claude-Session: https://claude.ai/code/session_01DwM2o8oeoMdu62P8yQFNCK"
```

---

### Task 2: Add `qrcode.react` dependency

**Files:**
- Modify: `apps/frontend/package.json` (dependencies)

**Interfaces:**
- Consumes: nothing.
- Produces: `import { QRCodeSVG } from 'qrcode.react'` — `<QRCodeSVG value={string} size={number} />` renders an SVG QR.

- [ ] **Step 1: Install the dependency**

Run: `pnpm --filter @bitetime/frontend add qrcode.react`
Expected: `qrcode.react` added under `dependencies` in `apps/frontend/package.json`; lockfile updated.

- [ ] **Step 2: Verify the import resolves**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS (no unresolved-module errors). `qrcode.react` ships its own types.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/package.json pnpm-lock.yaml
git commit -m "chore(frontend): add qrcode.react for storefront QR

Claude-Session: https://claude.ai/code/session_01DwM2o8oeoMdu62P8yQFNCK"
```

---

### Task 3: `ShareStorefront` card component

**Files:**
- Create: `apps/frontend/src/merchant/ShareStorefront.tsx`

**Interfaces:**
- Consumes: `useSession()` → `{ t, merchant }`; `storefrontUrl` (Task 1); `QRCodeSVG` (Task 2); `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent` from `@/components/ui/card`; `Button` from `@/components/ui/button`; `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle` from `@/components/ui/dialog`; `toast` from `sonner`; `Copy`/`ExternalLink`/`QrCode` icons from `lucide-react`.
- Produces: default export `ShareStorefront` — a self-contained card. Renders `null` when no `merchant`.

This component has no unit test (project convention: UI is run-and-verify; clipboard/dialog need a DOM). It is verified in Task 5.

- [ ] **Step 1: Write the component**

`apps/frontend/src/merchant/ShareStorefront.tsx`:
```tsx
import { useState } from 'react'
import { Copy, ExternalLink, QrCode } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { storefrontUrl } from '../storefrontUrl'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export default function ShareStorefront() {
  const { t, merchant } = useSession()
  const [qrOpen, setQrOpen] = useState(false)
  if (!merchant) return null

  const url = storefrontUrl(merchant.slug, window.location.origin)
  const isActive = merchant.status === 'active'

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('Link copied', '链接已复制'))
    } catch {
      toast.error(t('Could not copy — copy it manually', '无法复制 — 请手动复制'))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Your storefront link', '您的店铺链接')}</CardTitle>
        <CardDescription>{t('Share this link with your customers so they can order.', '把这个链接分享给顾客即可下单。')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="rounded-lg border-[1.5px] border-clay-border bg-surface-sunken px-3 py-2 font-mono text-[13px] break-all text-ink">
          {url}
        </div>
        {isActive ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="default" size="sm" className="w-auto" onClick={copy}>
              <Copy /> {t('Copy link', '复制链接')}
            </Button>
            <Button variant="outline" size="sm" className="w-auto" render={<a href={url} target="_blank" rel="noopener" />}>
              <ExternalLink /> {t('Open storefront', '打开店铺')}
            </Button>
            <Button variant="outline" size="sm" className="w-auto" onClick={() => setQrOpen(true)}>
              <QrCode /> {t('QR code', '二维码')}
            </Button>
          </div>
        ) : (
          <p className="text-[13px] text-rose-muted">{t('Storefront goes live after approval.', '店铺获批后上线。')}</p>
        )}
      </CardContent>

      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Scan to open storefront', '扫码打开店铺')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="rounded-lg bg-white p-3">
              <QRCodeSVG value={url} size={180} />
            </div>
            <p className="font-mono text-[12px] break-all text-center text-rose-muted">{url}</p>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
```

Note: `Button` wraps `@base-ui/react/button`, which supports the `render` prop to render as an `<a>` (same pattern base-ui uses elsewhere). If `render` is unavailable on this Button, fall back to wrapping the button in an `<a>` — verify in Step 2.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS. If the `Button` `render` prop errors, replace the Open button with:
```tsx
<a href={url} target="_blank" rel="noopener" className="inline-flex">
  <Button variant="outline" size="sm" className="w-auto"><ExternalLink /> {t('Open storefront', '打开店铺')}</Button>
</a>
```
and re-run typecheck until PASS.

- [ ] **Step 3: Lint**

Run: `pnpm --filter @bitetime/frontend lint`
Expected: PASS (no unused imports, no hook-rule violations).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/merchant/ShareStorefront.tsx
git commit -m "feat(merchant): storefront share card (copy / open / QR)

Claude-Session: https://claude.ai/code/session_01DwM2o8oeoMdu62P8yQFNCK"
```

---

### Task 4: Mount `ShareStorefront` in Overview

**Files:**
- Modify: `apps/frontend/src/merchant/Overview.tsx`

**Interfaces:**
- Consumes: default export `ShareStorefront` (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Import the component**

In `apps/frontend/src/merchant/Overview.tsx`, add after the existing imports (near line 8):
```tsx
import ShareStorefront from './ShareStorefront'
```

- [ ] **Step 2: Render it as the first block in both return branches**

The component returns two JSX trees (loading skeleton at ~line 39, loaded at ~line 50). Render `<ShareStorefront />` as the first child of the outer `<div className="flex flex-col gap-5">` in **both** branches so the share card shows immediately, before stats load.

Loaded branch (line 50-51) becomes:
```tsx
  return (
    <div className="flex flex-col gap-5">
      <ShareStorefront />
      <div className="grid grid-cols-4 gap-[10px] max-[900px]:grid-cols-2 max-[520px]:grid-cols-1">
```

Loading branch (line 39-40) becomes:
```tsx
  if (!stats) return (
    <div className="flex flex-col gap-5">
      <ShareStorefront />
      <div className="grid grid-cols-4 gap-[10px] max-[900px]:grid-cols-2 max-[520px]:grid-cols-1">
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter @bitetime/frontend typecheck && pnpm --filter @bitetime/frontend lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/merchant/Overview.tsx
git commit -m "feat(merchant): show storefront share card atop Overview

Claude-Session: https://claude.ai/code/session_01DwM2o8oeoMdu62P8yQFNCK"
```

---

### Task 5: Run-and-verify in the app

**Files:** none (verification only).

- [ ] **Step 1: Start dev servers**

Run: `pnpm dev`
Expected: frontend on :5173, backend on :8787.

- [ ] **Step 2: Verify the active-merchant flow**

Log in as a merchant whose shop `status === 'active'`, land on `/merchant` Overview. Confirm:
- Share card is the first block, shows the full URL `http://localhost:5173/s/<slug>`.
- **Copy link** → success toast; pasting elsewhere yields the exact URL.
- **Open storefront** → opens `/s/<slug>` in a new tab and the storefront loads.
- **QR code** → dialog opens with a scannable QR; scanning on a phone (or decoding) resolves to the same URL; dialog closes on overlay click / close button.

- [ ] **Step 3: Verify the pending/suspended state**

View a shop with `status !== 'active'` (superadmin "view as shop" on a `pending` merchant, or a pending merchant account). Confirm the card shows the URL plus the muted note "Storefront goes live after approval." and **no** action buttons.

- [ ] **Step 4: Verify localisation**

Toggle language to 中文. Confirm the card title, description, buttons, note, and QR dialog title all render Chinese.

- [ ] **Step 5: Final full check**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS (includes the `storefrontUrl` unit test).

---

## Notes for the implementer

- Do not add a WhatsApp/social share button, link analytics, or a header share control — explicitly out of scope (see spec).
- No DB migration, no `store.ts` change, no new env var. If you find yourself editing those, stop — the plan is off track.
