# Product unit quantity (display-only)

**Date:** 2026-07-04
**Status:** Approved design

## Problem

Products carry a `unit` (enum: `pcs`, `box`, `set`, `pack`, `dozen`, `bottle`, `jar`, `tray`, `slice`, `kg`, `g`). Merchants want to attach a **quantity** to that unit so a product reads as `100 g`, `1 pcs`, `1.5 kg` — describing the packaging/portion the price refers to.

This is **display-only**. It does not affect pricing or order math.

## Scope

In scope:
- Store a per-product unit quantity.
- Let merchants enter it in the product edit dialog.
- Show `<quantity> <unit>` wherever the unit is currently displayed.

Out of scope (explicitly):
- Per-unit-quantity pricing (price is still per product).
- Orderable steps / multipliers.
- Any change to `pricing.ts` or order totals.

## Design

### Data

New migration adds a column to `products`:

```sql
alter table products
  add column unit_quantity numeric not null default 1;
```

- `numeric` — decimals allowed (`1.5`, `0.25`, `100`).
- `not null default 1` — existing rows backfill to `1`; new rows without an explicit value get `1`.
- The `product_unit` enum is unchanged.

Apply locally with `pnpm --filter @bitetime/backend db:migrate` so PostgREST's schema cache sees the column.

### Type

The frontend uses **raw snake_case DB columns** — `fetchProducts` does `select('*')` and returns rows untouched; `upsertProduct` writes the object as-is. There is no snake↔camel mapper. So the field is `unit_quantity` everywhere (matching `merchant_id`, `name_zh`, `image_urls`).

`apps/frontend/src/types.ts` — add to `Product`:

```ts
unit_quantity?: number  // defaults to 1
```

No `store.ts` change needed (`Product` already has `[key: string]: any`; the explicit field is for documentation).

### Helper module

New pure module `apps/frontend/src/productUnit.ts` (no React) so both the dashboard and storefront share one implementation and it's unit-testable:

```ts
// Coerce a form/DB value to a valid positive quantity; fall back to 1.
export function coerceQuantity(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 1
}

// Display: "<quantity> <unit>", always a single space. Legacy rows without a
// quantity render as "1 <unit>". `unit` is the raw enum value / label string
// the caller already resolves (display does not localize the unit today).
export function formatUnit(quantity: unknown, unit: string): string {
  return `${coerceQuantity(quantity)} ${unit}`
}
```

Displays currently show the **raw** `p.unit` string (not localized) — that behavior is unchanged; `formatUnit` only prefixes the quantity.

### Edit UI

`apps/frontend/src/merchant/ProductsManager.tsx`:
- `BLANK.unit_quantity = 1` (default when adding).
- `openEdit` loads `unit_quantity: p.unit_quantity ?? 1` (legacy rows).
- In the dialog (the existing unit `Select` block, :279–296), put a number input and the unit dropdown side by side, quantity **before** the unit:
  `[ 100 ] [ g ▾ ]`
  - `type=number`, `step="0.01"`, `min="0.01"`, bound to `form.unit_quantity`.
- `save` writes `unit_quantity: coerceQuantity(form.unit_quantity)` so `0`, blank, negative, or `NaN` never persist.

### Display

Replace bare-unit rendering with `formatUnit(...)` from `productUnit.ts`:
- Dashboard table cell — `ProductsManager.tsx:90`: `{formatMoney(p.price, currency)} / {formatUnit(p.unit_quantity, p.unit)}`
- Storefront menu item — `Storefront.tsx:310`: `{formatMoney(p.price, currency)} / {formatUnit(p.unit_quantity, p.unit || t('unit', '个'))}`

**Always a single space** between quantity and unit (locked decision — no per-unit spacing rule).

### Pricing

Untouched. `pricing.ts` does not read `unit` or `unit_quantity`. Zero change to order math or totals.

### Error handling

- `coerceQuantity` guarantees every saved product has a finite positive quantity (never `0`, negative, or `NaN`).
- Legacy rows / missing value on load or display: treated as `1`.

## Testing

- Unit test for `productUnit.ts`: `formatUnit` whole number (`1 pcs`), decimal (`1.5 kg`); `coerceQuantity` for blank / `0` / negative / `NaN` / valid decimal → correct fallback to `1` or pass-through.
- Existing `store.ts` / pricing tests unaffected.
- UI verified by run-and-verify (per repo convention — no component tests).

## Files touched

| File | Change |
|------|--------|
| `apps/backend/supabase/migrations/<new>.sql` | add `unit_quantity numeric not null default 1` |
| `apps/frontend/src/productUnit.ts` | new — `coerceQuantity`, `formatUnit` |
| `apps/frontend/src/productUnit.test.ts` | new — unit tests |
| `apps/frontend/src/types.ts` | add `unit_quantity?: number` to `Product` |
| `apps/frontend/src/merchant/ProductsManager.tsx` | default, edit-load, dialog number input, save coerce, table display |
| `apps/frontend/src/store/Storefront.tsx` | use `formatUnit` in menu item display |
