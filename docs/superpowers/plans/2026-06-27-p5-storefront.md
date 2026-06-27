# P5 — Customer Storefront + Merchant Orders (expanded)

> Subagent-driven, run-and-verify. Builds on P0–P4. Delivers: customers order from a merchant's storefront at `/s/:slug` (guest checkout), each order gets a per-merchant order number, and the merchant sees/manages those orders + customers in their dashboard (lighting up the P4 stub tabs).

**Scope (MVP):** guest checkout (no customer account required — mirrors the legacy app's guest flow). Order numbering via a security-definer `next_order_number` RPC over `order_counters`. Merchant Orders view (list + status). Merchant Customers view (derived from orders). **Deferred (noted):** Telegram notifications (now require a server-side edge function reading `merchant_secrets` — out of scope this phase); per-merchant customer accounts/login; vouchers; postcode/same-day/delivery-zone complexity (keep a simple pickup / flat-delivery choice using `merchant.shipping`).

**Verify:** visit `/s/<active-slug>` → see the merchant's active products → add quantities → enter name + WhatsApp → submit → success screen with order number + the merchant's payment note. Merchant dashboard → Orders shows it; change status persists. Suspended/pending shop → storefront shows unavailable. A second merchant cannot see the first's orders (RLS). `npm test` green.

## Global Constraints
- All Supabase via `store.js`. Bilingual `t()`. React 19/Vite 8.
- Orders table (P0): `merchant_id, customer_name, customer_wa, mode, address, shipping_fee, items jsonb, total, order_number, status, awb, note`.
- RLS: guest INSERT allowed (`orders_insert_any`); merchant reads/updates own via `current_merchant_id()`; `next_order_number` is SECURITY DEFINER (advances counter for guests).
- Storefront only serves `status === 'active'` merchants.
- Don't break P1–P4 or the legacy `/`.

---

### Task 5.1: `next_order_number` RPC

**Files:** Create `supabase/migrations/20260627120500_next_order_number.sql`

**Interfaces:** `next_order_number(p_merchant uuid) => text` — `<order_prefix>-YYMMDD-NNNN`, atomically advancing `order_counters` (reset to 50 on a new day, else +1). Granted to anon + authenticated.

- [ ] **Step 1: Migration**

```sql
create or replace function public.next_order_number(p_merchant uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text;
  v_today  text := to_char(now(), 'YYMMDD');
  v_value  int;
begin
  select order_prefix into v_prefix from public.merchants where id = p_merchant;
  if v_prefix is null then raise exception 'merchant not found'; end if;

  insert into public.order_counters (merchant_id, day, value)
    values (p_merchant, v_today, 50)
  on conflict (merchant_id) do update
    set day   = v_today,
        value = case when public.order_counters.day = v_today
                     then public.order_counters.value + 1
                     else 50 end
  returning value into v_value;

  return v_prefix || '-' || v_today || '-' || lpad(v_value::text, 4, '0');
end;
$$;

grant execute on function public.next_order_number(uuid) to anon, authenticated;
```

- [ ] **Step 2:** Apply — `supabase db reset` clean.
- [ ] **Step 3:** Quick sanity (psql): call it twice for one merchant → `...-0050` then `...-0051`. (Manual check; document in report.)
- [ ] **Step 4: Commit** — `feat(db): per-merchant next_order_number RPC`

---

### Task 5.2: Store — storefront order + merchant orders/customers

**Files:** Modify `src/store.js`; extend `src/store.test.js`

**Interfaces:**
- `placeOrder({ merchantId, customerName, customerWa, mode, address, shippingFee, items, total }) => Promise<{ order, orderNumber }>` — calls `supabase.rpc('next_order_number', { p_merchant })`, then inserts the order row (`status:'new'`), returns the row + number.
- `fetchMerchantOrders(merchantId) => Promise<Order[]>` — merchant's orders, newest first.
- `setOrderStatus(orderId, status) => Promise<Order>` — status in `new|preparing|ready|completed|cancelled`; updates `orders.status`.
- `fetchMerchantCustomers(merchantId) => Promise<{name, wa, orderCount, lastOrder}[]>` — derived by grouping the merchant's orders by `customer_wa`.

- [ ] **Step 1: Failing tests** (append to `src/store.test.js`; harness supports rpc? add an `rpc` mock to the `supabase` mock returning `{data,error}`). Assert: `placeOrder` calls `rpc('next_order_number',{p_merchant})` then `from('orders').insert(<obj with merchant_id, order_number, status:'new', items, total>)`; `setOrderStatus` rejects invalid status before DB; `fetchMerchantOrders` filters by merchant_id desc. `fetchMerchantCustomers` groups correctly (pure-ish given a mocked orders fetch).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** in `store.js`:

```js
const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled']

export async function placeOrder({ merchantId, customerName, customerWa, mode, address, shippingFee, items, total }) {
  const { data: orderNumber, error: rpcErr } = await supabase
    .rpc('next_order_number', { p_merchant: merchantId })
  if (rpcErr) throw rpcErr
  const { data, error } = await supabase.from('orders').insert({
    merchant_id: merchantId,
    customer_name: customerName,
    customer_wa: customerWa,
    mode, address,
    shipping_fee: shippingFee ?? 0,
    items, total,
    order_number: orderNumber,
    status: 'new',
  }).select().single()
  if (error) throw error
  return { order: data, orderNumber }
}

export async function fetchMerchantOrders(merchantId) {
  if (!merchantId) return []
  const { data, error } = await supabase
    .from('orders').select('*').eq('merchant_id', merchantId)
    .order('created_at', { ascending: false })
  if (error) return []
  return data ?? []
}

export async function setOrderStatus(orderId, status) {
  if (!ORDER_STATUSES.includes(status)) throw new Error('Invalid status')
  const { data, error } = await supabase
    .from('orders').update({ status }).eq('id', orderId).select().single()
  if (error) throw error
  return data
}

export async function fetchMerchantCustomers(merchantId) {
  const orders = await fetchMerchantOrders(merchantId)
  const byWa = new Map()
  for (const o of orders) {
    const key = o.customer_wa || o.customer_name || '—'
    const cur = byWa.get(key) || { name: o.customer_name, wa: o.customer_wa, orderCount: 0, lastOrder: o.created_at }
    cur.orderCount += 1
    if (o.created_at > cur.lastOrder) cur.lastOrder = o.created_at
    byWa.set(key, cur)
  }
  return [...byWa.values()]
}
```
Note: there is an existing `saveOrder` for the legacy flow — leave it; `placeOrder` is the multi-tenant path.

- [ ] **Step 4: Run → PASS**, full `npm test` green.
- [ ] **Step 5: Commit** — `feat: storefront order placement + merchant orders/customers store fns`

---

### Task 5.3: Storefront order page

**Files:** Create `src/store/Storefront.jsx`; modify `src/AppRouter.jsx` (StorefrontShell → render Storefront when active)

**Interfaces:** At `/s/:slug` (via `MerchantProvider`): if `loading` → spinner; `notFound` or `status !== 'active'` → "shop unavailable" (brand styled); else render `Storefront`: merchant header, active products (from `fetchProducts(merchant.id)`, filter `active`) with qty steppers, a fulfilment choice (Pickup / Delivery using `merchant.shipping.WM` as a flat delivery fee + an address field when Delivery), customer Name + WhatsApp, live total, **Place order** → `placeOrder(...)` → success view with order number + `merchant.payment_note`. Bilingual; reuse `.mm-*`/existing classes for styling consistency.

- [ ] **Step 1: Implement `src/store/Storefront.jsx`** — cart state `{ [productId]: qty }`; compute items + total; pickup/delivery toggle; submit via `placeOrder`. (Write complete, production-quality component code: loading/empty/success states, disabled submit when cart empty or name/wa missing, error handling.)
- [ ] **Step 2: Wire `AppRouter.jsx`** — replace the StorefrontShell placeholder body: keep loading/notFound, add `merchant.status !== 'active'` → unavailable, else `<Storefront />`. (Storefront reads `useMerchant()`.)
- [ ] **Step 3: Verify** (run-and-verify) — `/s/owner-test-shop` (active, has the Brown Butter Cookie product) → add qty → enter name + WhatsApp → Place order → success with order number `<PREFIX>-YYMMDD-NNNN` + payment note. Order row in DB with merchant_id + status new. Pending/suspended slug → unavailable. `npm test` green; `npm run build` ok.
- [ ] **Step 4: Commit** — `feat: customer storefront order flow at /s/:slug`

---

### Task 5.4: Merchant Orders + Customers views

**Files:** Create `src/merchant/OrdersView.jsx`, `src/merchant/CustomersView.jsx`; modify `src/merchant/Dashboard.jsx`

**Interfaces:** Dashboard enables the **Orders** and **Customers** tabs (remove the "Soon" disabled state). `OrdersView`: `fetchMerchantOrders(merchant.id)` → list (order number, time, customer, items summary, total, status) with a status `<select>` → `setOrderStatus`. `CustomersView`: `fetchMerchantCustomers(merchant.id)` → list (name, WhatsApp, order count, last order).

- [ ] **Step 1: `OrdersView.jsx`** — list + per-order status select (options = the 5 statuses), refetch/update on change; empty state. Use existing/`.mm-*` styling.
- [ ] **Step 2: `CustomersView.jsx`** — simple table (name, WhatsApp, # orders, last order date); empty state.
- [ ] **Step 3: `Dashboard.jsx`** — add `orders` and `customers` to `SECTIONS`; render `OrdersView`/`CustomersView`; drop the disabled "Soon" spans.
- [ ] **Step 4: Verify** — as the merchant, Orders shows the order placed in 5.3; change its status → persists (reload). Customers shows the customer. `npm test` green; `npm run build` ok.
- [ ] **Step 5: Commit** — `feat: merchant orders and customers dashboard views`

---

## P5 Done
Customers order from `/s/:slug` (guest), per-merchant order numbers, merchant manages orders + sees customers. Original ask — *manage their customers* — delivered (view layer).

**Carry-forward to P6 / later:** Telegram notifications via a Supabase edge function reading `merchant_secrets` (server-side); per-merchant customer accounts + order history + vouchers at the storefront; richer delivery (postcodes/same-day) ported from the legacy OrderForm; profile-code restructure + real superadmin seeding; retire the legacy global single-tenant `/` order flow once storefront reaches parity.
