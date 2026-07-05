# Postcode autofill + split delivery address — design

**Date:** 2026-07-05
**Status:** approved (pre-implementation)

## Problem

The merchant storefront (`store/Storefront.tsx`) collects the delivery address as a
single free-text `<Textarea>`. Two consequences:

1. No structured city/state, so orders can't be validated or sorted by locality, and
   nothing helps the customer type their address correctly.
2. The storefront hardcodes the West-Malaysia (WM) shipping fee and never collects
   state, so the WM/EM regional pricing already built into `pricing.ts` never fires.

## Goals

- When a customer selects **Delivery** and enters a **postcode**, auto-fill **City**
  and **State**.
- Split the single delivery-address box into structured fields:
  **Line1 + Postcode + City + State**.
- As a free win, feed the resolved state into `priceOrder()` so delivery pricing
  becomes regional (WM/EM) instead of a hardcoded WM flat fee.

Malaysia-only. Bundled (offline) postcode dataset.

## Non-goals (YAGNI)

- Prefilling the form from a signed-in customer's saved `profiles.delivery_address`.
- A city dropdown for postcodes that map to multiple localities (pick the first;
  the field stays editable).
- Merchant-facing UI to configure the EM shipping rate (falls back to WM until set).
- Non-Malaysian postcodes / international addresses.

## Current state (as found)

| Thing | Location |
|-------|----------|
| `address` string state | `Storefront.tsx:46` |
| Delivery `<Textarea>` | `Storefront.tsx:405–417` |
| `address` passed to `placeOrder` | `Storefront.tsx:154` |
| `priceOrder()` call — both rates equal, `resolvedShipping: fee`, no `state` | `Storefront.tsx:81–88` |
| Hardcoded `deliveryFee = merchant?.shipping?.WM ?? 8` | `Storefront.tsx:70` |
| `priceOrder` already supports `state` + `rates.WM/EM` | `pricing.ts:26–54` |
| `EM_STATES = ['Sabah', 'Sarawak', 'W.P. Labuan']` | `pricing.ts:43` |
| `placeOrder` inserts `address` as-is | `store.ts:407–433` |
| `orders.address` column is `text` | `supabase/migrations/20260626120000_init_schema.sql:66` |
| `Order.address?: any` | `types.ts:85` |
| Address read (merchant detail) | `merchant/OrdersView.tsx:288` |
| Address read (Telegram) | `apps/backend/src/notify.ts:47` |
| `profiles.delivery_address` already `jsonb` (unused here) | `migrations/…fix_drift…:10` |

Address is read/displayed in exactly **2** places (OrdersView, backend notify) — small
blast radius. TrackOrder and the customer success view do not show address.

## Components

### 1. Postcode dataset + lookup — `src/postcodes.ts` (+ `src/postcodes-my.json`)

- **Data file** `postcodes-my.json`: compact map `{ [postcode5]: "City|STATE" }`, one
  entry per postcode. `STATE` is the **canonical full state name** (see §2) so it can
  be compared directly against `EM_STATES`.
- **Generation:** a committed one-off script (`apps/frontend/scripts/gen-postcodes.ts`)
  transforms an upstream open Malaysian postcode dataset into `postcodes-my.json`. The
  generated JSON is checked in; the script is not run at build time. Upstream source
  chosen at implementation (e.g. a maintained `state → city → [postcodes]` dataset),
  documented in a header comment in the script. State names are normalised to the
  canonical set during generation.
- **Loading:** `postcodes-my.json` is loaded via **dynamic `import()`** the first time
  Delivery is selected, so pickup-only sessions never pay the bytes. `lookupPostcode`
  awaits (or memoises) that import.
- **API:**
  ```ts
  export async function lookupPostcode(code: string): Promise<{ city: string; state: string } | null>
  ```
  Returns `null` for unknown / non-5-digit input. For a postcode with multiple
  localities, returns the first city.

### 2. Canonical MY states — `src/states-my.ts`

- Exported `MY_STATES: string[]` — the 16 states/territories, using the **exact
  strings** that `EM_STATES` uses for East Malaysia (`'Sabah'`, `'Sarawak'`,
  `'W.P. Labuan'`) so `shippingFee()` resolves correctly. Used to populate the State
  `<select>` and to normalise dataset generation.

### 3. Address fields UI — `Storefront.tsx`

Replace the single `<Textarea>` (405–417) with four controls inside the existing
`mode === 'delivery'` block:

| Field | Control | Behaviour |
|-------|---------|-----------|
| Line 1 | text input | street / building / unit; `placeholder` "Street, building, unit…" |
| Postcode | text input | numeric, `maxLength=5`. When it reaches 5 digits → `lookupPostcode` → set City + State |
| City | text input | prefilled by lookup, **editable** |
| State | `<select>` of `MY_STATES` | prefilled by lookup, **editable** |

- All labels via `t(en, zh)`.
- Autofill never blocks manual edits: a lookup hit sets city/state, the customer may
  overwrite either. A lookup miss leaves them as-is for manual entry.
- **Submit gating:** extend `canSubmit` so that when `mode === 'delivery'`, all of
  `line1`, `postcode` (5 digits), `city`, `state` are non-empty.

### 4. State shape + type

- Replace `const [address, setAddress] = useState('')` with an object:
  ```ts
  const [address, setAddress] = useState<AddressParts>({ line1: '', postcode: '', city: '', state: '' })
  ```
- New exported type in `types.ts`:
  ```ts
  export interface AddressParts { line1: string; postcode: string; city: string; state: string }
  ```
- `Order.address` stays `any` (holds `AddressParts` for new rows, `string` for legacy).

### 5. Shipping wiring — `Storefront.tsx`

- Compute rates from the merchant settings:
  `WM = merchant?.shipping?.WM ?? 8`, `EM = merchant?.shipping?.EM ?? WM`.
- `priceOrder({ …, mode, state: mode === 'delivery' ? address.state : null,
  rates: { WM, EM } })` — **drop `resolvedShipping`** so region logic runs.
- Derive the displayed delivery fee from `bd.shipping` instead of the hardcoded `fee`.
- Result: EM states get the EM rate; everything else gets WM. With no EM rate
  configured, `EM` falls back to `WM` → identical to today's behaviour.

### 6. Storage + migration

- **Migration** `apps/backend/supabase/migrations/<ts>_orders_address_jsonb.sql`:
  ```sql
  alter table orders
    alter column address type jsonb
    using case when address is null then null else to_jsonb(address) end;
  ```
  Existing text rows become JSON strings (still valid jsonb, still readable by the
  formatter). Apply locally with `pnpm --filter @bitetime/backend db:migrate` before
  the app queries the new shape.
- `placeOrder` (`store.ts:407`) passes the `AddressParts` object straight through; the
  Supabase insert now lands it in the `jsonb` column. Type the `address` param as
  `AddressParts | string`.

### 7. Display formatter

Because `order.address` may now be an object, both read sites must format it (raw
render would show `[object Object]`).

- **Frontend** `formatAddress(addr: AddressParts | string | null | undefined): string`
  — in `src/address.ts` (or colocated with `AddressParts`). Object →
  `"line1, postcode city, state"` (skip empties). String → returned as-is. Nullish →
  `''`. Used at `OrdersView.tsx:288`.
- **Backend** `notify.ts` — a small twin formatter (backend cannot import frontend
  code). Handles the same object/string/nullish cases at `notify.ts:47`.

## Data flow

```
Delivery selected
  └─ dynamic import postcodes-my.json (once)
Customer types postcode (5 digits)
  └─ lookupPostcode → { city, state } → setAddress({ …, city, state })   [editable]
Customer submits
  └─ priceOrder({ state: address.state, rates:{WM,EM} }) → regional shipping
  └─ placeOrder({ address: AddressParts }) → orders.address (jsonb)
Merchant views order / Telegram fires
  └─ formatAddress(order.address) → human string
```

## Testing

- **Unit** (`*.test.ts`, run by `pnpm test`):
  - `lookupPostcode`: known postcode → correct city+state; unknown → null; <5 digits →
    null; a known multi-locality postcode → first city.
  - `formatAddress` (frontend + backend twin): `AddressParts` object → joined string;
    legacy string → unchanged; `null`/`undefined` → `''`.
  - `pricing.ts` already covers WM/EM `shippingFee` — no new pricing test needed beyond
    confirming the storefront now passes `state`.
- **UI:** run-and-verify per repo convention — Delivery → type a postcode → City+State
  autofill → edit City → place order → check the merchant order detail and Telegram
  message render the formatted address.

## Risks / open items

- **Dataset source & size** — resolved at implementation. Keep the JSON compact
  (`"City|STATE"` values, no whitespace) and lazy-load it. Note the source + license in
  the generator script header.
- **State-name drift** — the dataset's state strings must exactly match `MY_STATES` /
  `EM_STATES`; normalise during generation. A mismatch silently drops EM pricing.
- **Legacy rows** — old orders keep a string address; the formatter's string branch
  covers display. The migration's `to_jsonb(text)` makes them valid jsonb.
