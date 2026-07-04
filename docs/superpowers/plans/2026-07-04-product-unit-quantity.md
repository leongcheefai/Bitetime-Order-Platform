# Product Unit Quantity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let merchants attach a decimal quantity to a product's unit so it displays as "100 g" / "1 pcs" / "1.5 kg" — display-only, no pricing change.

**Architecture:** New `numeric` column `products.unit_quantity` (default 1). A pure `productUnit.ts` module holds `coerceQuantity` + `formatUnit`, shared by the merchant dashboard and the storefront. The edit dialog gains a number input next to the existing unit dropdown; both display sites prefix the quantity via `formatUnit`.

**Tech Stack:** React 19 + Vite + TypeScript, Vitest, Supabase (Postgres migrations), shadcn-style UI components.

## Global Constraints

- Frontend uses **raw snake_case DB column names** (`p.unit`, `p.name_zh`, `p.image_urls`). No snake↔camel mapper exists. The field is `unit_quantity` everywhere.
- Localisation: every user string via `t(en, zh)`. Displays currently show the **raw** unit value (not localized) — do not add unit localization; out of scope.
- Pricing (`src/pricing.ts`, order totals) must not change. It never reads `unit`/`unit_quantity`.
- Migrations: adding a `.sql` file does not apply it. Local apply: `pnpm --filter @bitetime/backend db:migrate`.
- Run tests from repo root: `pnpm --filter @bitetime/frontend test`.
- Commit messages end with: `Claude-Session: https://claude.ai/code/session_01XgZ3EuZwdESJosrijjiD2x`

---

### Task 1: Pure helper module `productUnit.ts` (TDD)

**Files:**
- Create: `apps/frontend/src/productUnit.ts`
- Test: `apps/frontend/src/productUnit.test.ts`

**Interfaces:**
- Produces:
  - `coerceQuantity(v: unknown): number` — finite `> 0` → the number; else `1`.
  - `formatUnit(quantity: unknown, unit: string): string` — `` `${coerceQuantity(quantity)} ${unit}` ``.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/productUnit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { coerceQuantity, formatUnit } from './productUnit'

describe('coerceQuantity', () => {
  it('passes through a positive whole number', () => {
    expect(coerceQuantity(100)).toBe(100)
  })
  it('passes through a positive decimal', () => {
    expect(coerceQuantity(1.5)).toBe(1.5)
  })
  it('parses a numeric string', () => {
    expect(coerceQuantity('250')).toBe(250)
  })
  it('falls back to 1 for blank, zero, negative, and non-numeric', () => {
    expect(coerceQuantity('')).toBe(1)
    expect(coerceQuantity(0)).toBe(1)
    expect(coerceQuantity(-5)).toBe(1)
    expect(coerceQuantity('abc')).toBe(1)
    expect(coerceQuantity(NaN)).toBe(1)
    expect(coerceQuantity(null)).toBe(1)
    expect(coerceQuantity(undefined)).toBe(1)
  })
})

describe('formatUnit', () => {
  it('joins quantity and unit with a single space', () => {
    expect(formatUnit(100, 'g')).toBe('100 g')
    expect(formatUnit(1, 'pcs')).toBe('1 pcs')
    expect(formatUnit(1.5, 'kg')).toBe('1.5 kg')
  })
  it('treats a missing quantity as 1', () => {
    expect(formatUnit(undefined, 'pcs')).toBe('1 pcs')
    expect(formatUnit(0, 'g')).toBe('1 g')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bitetime/frontend test -- productUnit`
Expected: FAIL — cannot resolve `./productUnit` / functions not defined.

- [ ] **Step 3: Write minimal implementation**

Create `apps/frontend/src/productUnit.ts`:

```ts
// Shared, pure helpers for a product's unit quantity (display-only feature).
// The frontend stores the value as the raw DB column `unit_quantity` (numeric).

// Coerce a form/DB value to a valid positive quantity; fall back to 1 so a
// product never displays or persists 0, a negative, or NaN.
export function coerceQuantity(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 1
}

// Display: "<quantity> <unit>", always a single space. Legacy rows without a
// quantity render as "1 <unit>". `unit` is the raw string the caller resolves;
// display does not localize the unit today.
export function formatUnit(quantity: unknown, unit: string): string {
  return `${coerceQuantity(quantity)} ${unit}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bitetime/frontend test -- productUnit`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/productUnit.ts apps/frontend/src/productUnit.test.ts
git commit -m "feat(products): add unit-quantity helper module

Claude-Session: https://claude.ai/code/session_01XgZ3EuZwdESJosrijjiD2x"
```

---

### Task 2: DB migration + `Product` type

**Files:**
- Create: `apps/backend/supabase/migrations/20260704000000_product_unit_quantity.sql`
- Modify: `apps/frontend/src/types.ts:53` (add field under `unit?`)

**Interfaces:**
- Produces: column `products.unit_quantity numeric not null default 1`; `Product.unit_quantity?: number`.

- [ ] **Step 1: Write the migration**

Create `apps/backend/supabase/migrations/20260704000000_product_unit_quantity.sql`:

```sql
-- Add a per-product unit quantity (display-only): "100 g", "1 pcs", "1.5 kg".
-- numeric so decimals are allowed; default 1 backfills existing rows.
alter table public.products
  add column unit_quantity numeric not null default 1;

-- Refresh PostgREST's schema cache so the new column is visible immediately.
notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply the migration locally**

Run: `pnpm --filter @bitetime/backend db:migrate`
Expected: migration applies cleanly; no error. (Requires local Supabase running.)

- [ ] **Step 3: Add the type field**

In `apps/frontend/src/types.ts`, in the `Product` interface, add the field right after the `unit?` line (:53):

```ts
  unit?: string
  unit_quantity?: number  // display-only quantity paired with unit; defaults to 1
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS (no type errors).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/supabase/migrations/20260704000000_product_unit_quantity.sql apps/frontend/src/types.ts
git commit -m "feat(db): add products.unit_quantity column

Claude-Session: https://claude.ai/code/session_01XgZ3EuZwdESJosrijjiD2x"
```

---

### Task 3: Merchant dashboard — edit dialog input + table display

**Files:**
- Modify: `apps/frontend/src/merchant/ProductsManager.tsx`

**Interfaces:**
- Consumes: `coerceQuantity`, `formatUnit` from `../productUnit` (Task 1).

- [ ] **Step 1: Import the helpers**

At the top of `ProductsManager.tsx`, add after the `store` import (line 6):

```ts
import { coerceQuantity, formatUnit } from '../productUnit'
```

- [ ] **Step 2: Default the quantity when adding**

Change `BLANK` (line 36) to include the quantity:

```ts
const BLANK = { name: '', name_zh: '', descr: '', price: '', unit: 'pcs', unit_quantity: 1, active: true }
```

- [ ] **Step 3: Load the quantity when editing**

In `openEdit` (lines 152-160), add `unit_quantity` to the loaded `form`:

```ts
    setForm({
      name: p.name ?? '', name_zh: p.name_zh ?? '', descr: p.descr ?? '',
      price: String(p.price ?? ''), unit: p.unit ?? 'pc', unit_quantity: p.unit_quantity ?? 1, active: p.active,
    })
```

- [ ] **Step 4: Coerce the quantity on save**

In `save` (lines 165-176), coerce `unit_quantity` in both upsert branches. Replace the two `upsertProduct(...)` calls:

```ts
      if (editingProduct) {
        // Spread the original row first so sort / active / etc. survive the upsert.
        await upsertProduct({ ...editingProduct, ...form, image_urls: images, price: Number(form.price) || 0, unit_quantity: coerceQuantity(form.unit_quantity) })
      } else {
        await upsertProduct({
          ...form,
          id: draftId,
          image_urls: images,
          price: Number(form.price) || 0,
          unit_quantity: coerceQuantity(form.unit_quantity),
          merchant_id: merchant!.id,
        })
      }
```

- [ ] **Step 5: Add the quantity input beside the unit dropdown**

Replace the whole Unit field block (lines 279-296, the `<div>` wrapping the `Label htmlFor="pm-5"` and its `Select`) with a quantity input + the dropdown side by side:

```tsx
              <div className="flex flex-col gap-[6px]">
                <Label htmlFor="pm-5">{t('Unit', '单位')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="pm-qty"
                    variant="compact"
                    type="number"
                    step="0.01"
                    min="0.01"
                    className="w-24"
                    value={form.unit_quantity}
                    onChange={e => setForm({ ...form, unit_quantity: e.target.value })}
                    aria-label={t('Unit quantity', '单位数量')}
                    placeholder="1"
                  />
                  <Select value={form.unit} onValueChange={v => setForm({ ...form, unit: v })}>
                    <SelectTrigger id="pm-5" className="flex-1 bg-cream border-clay-border text-[13px]">
                      <SelectValue />
                    </SelectTrigger>
                    {/* z-modal-popover (400) floats above the dialog popup (z-modal). */}
                    <SelectContent className="z-modal-popover">
                      {/* Keep a legacy value (e.g. old "pc") selectable so existing rows survive. */}
                      {form.unit && !UNITS.some(u => u.value === form.unit) && (
                        <SelectItem value={form.unit}>{form.unit}</SelectItem>
                      )}
                      {UNITS.map(u => (
                        <SelectItem key={u.value} value={u.value}>{t(u.en, u.zh)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
```

- [ ] **Step 6: Show the quantity in the price/unit table cell**

In the `price` column cell (line 90), replace the bare `{p.unit}` with `formatUnit`:

```tsx
      return <span className="text-[13px] text-rose-muted whitespace-nowrap">{formatMoney(p.price, currency)} / {formatUnit(p.unit_quantity, p.unit)}</span>
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS.

- [ ] **Step 8: Run and verify in the app**

Run: `pnpm dev`, open the merchant dashboard, add/edit a product. Confirm: the quantity input sits left of the unit dropdown; saving `100` + `g` shows `RM… / 100 g` in the table; editing an existing product shows `1` for pre-existing rows; the unit dropdown still opens above the dialog and selecting a unit does not close the dialog.
Expected: all confirmed.

- [ ] **Step 9: Commit**

```bash
git add apps/frontend/src/merchant/ProductsManager.tsx
git commit -m "feat(products): edit + show unit quantity in dashboard

Claude-Session: https://claude.ai/code/session_01XgZ3EuZwdESJosrijjiD2x"
```

---

### Task 4: Storefront — show the quantity in the menu item

**Files:**
- Modify: `apps/frontend/src/store/Storefront.tsx` (~line 310)

**Interfaces:**
- Consumes: `formatUnit` from `../productUnit` (Task 1). Confirm the import path prefix matches the file's location (`src/store/Storefront.tsx` → `../productUnit`).

- [ ] **Step 1: Import the helper**

Add the import alongside the other `../` imports at the top of `Storefront.tsx`:

```ts
import { formatUnit } from '../productUnit'
```

- [ ] **Step 2: Use `formatUnit` in the price/unit line**

Replace the price line (currently `{formatMoney(p.price, currency)} / {p.unit || t('unit', '个')}`):

```tsx
                        {formatMoney(p.price, currency)} / {formatUnit(p.unit_quantity, p.unit || t('unit', '个'))}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS.

- [ ] **Step 4: Run and verify**

Run: `pnpm dev`, open a storefront (`/s/:slug`). Confirm a product with quantity `100` + unit `g` shows `RM… / 100 g`; a legacy product with no quantity shows `1 <unit>`.
Expected: confirmed.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/store/Storefront.tsx
git commit -m "feat(storefront): show unit quantity in menu item

Claude-Session: https://claude.ai/code/session_01XgZ3EuZwdESJosrijjiD2x"
```

---

## Self-review notes

- Spec coverage: data (Task 2), helper module (Task 1), edit UI (Task 3 s1-5), dashboard display (Task 3 s6), storefront display (Task 4), pricing untouched (no task edits pricing), testing (Task 1 tests + run-and-verify steps). All covered.
- Type consistency: `coerceQuantity` / `formatUnit` signatures identical across Tasks 1, 3, 4. Field name `unit_quantity` (snake_case) consistent everywhere.
- No placeholders: every code step shows full code.
