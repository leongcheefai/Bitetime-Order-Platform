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

`apps/frontend/src/types.ts` — add to `Product`:

```ts
unitQuantity: number  // defaults to 1
```

`apps/frontend/src/store.ts` — map `unit_quantity` ↔ `unitQuantity` in the product read/write mappers, alongside the existing `unit` mapping.

### Edit UI

`apps/frontend/src/merchant/ProductsManager.tsx`:
- `BLANK.unitQuantity = 1` (default when adding).
- On edit load, fall back to `1` if absent (legacy rows).
- In the dialog (near the existing unit `Select`, ~:281), add a number input **before** the unit dropdown:
  `[ 100 ] [ g ▾ ]`
  - `type=number`, `min` > 0 (e.g. `step="0.01"`, `min="0.01"`), default `1`.
  - Reject blank / non-positive on save (coerce to `1` or block save — see Error handling).

### Display

Add a pure helper (co-locate with the UNITS map in `ProductsManager.tsx`, exported for reuse and testing):

```ts
formatUnit(quantity: number, unitLabel: string): string
// => `${quantity} ${unitLabel}`  e.g. "100 g", "1 pcs", "1.5 kg"
```

- **Always a single space** between quantity and unit (locked decision — no per-unit spacing rule).
- `unitLabel` is the already-localized label from the existing UNITS map (EN/ZH), so bilingual display is preserved.

Replace bare-unit rendering with `formatUnit(...)` at:
- Dashboard table cell — `ProductsManager.tsx:90`
- Storefront menu item — `Storefront.tsx:310`

### Pricing

Untouched. `pricing.ts` does not read `unit` or `unitQuantity`. Zero change to order math or totals.

### Error handling

- Empty / non-positive quantity input: on save, coerce to `1` (never persist `0`, negative, or `NaN`). Keeps the invariant that every product has a valid positive quantity.
- Legacy rows / missing value on load: treat as `1`.

## Testing

- Unit test for `formatUnit`: whole number (`1 pcs`), decimal (`1.5 kg`), with both EN and ZH unit labels, confirming the single-space format.
- Existing `store.ts` / pricing tests unaffected; add coverage for the `unitQuantity` mapper round-trip if the store mapper has existing tests.
- UI verified by run-and-verify (per repo convention — no component tests).

## Files touched

| File | Change |
|------|--------|
| `apps/backend/supabase/migrations/<new>.sql` | add `unit_quantity numeric not null default 1` |
| `apps/frontend/src/types.ts` | add `unitQuantity` to `Product` |
| `apps/frontend/src/store.ts` | map `unit_quantity` ↔ `unitQuantity` |
| `apps/frontend/src/merchant/ProductsManager.tsx` | default, edit-load fallback, dialog number input, `formatUnit` helper, table display |
| `apps/frontend/src/store/Storefront.tsx` | use `formatUnit` in menu item display |
| `apps/frontend/src/merchant/*.test.ts` | `formatUnit` unit test |
