# P4 — Merchant Dashboard (expanded)

> Subagent-driven, run-and-verify. Builds on P0–P3. Delivers the active-merchant dashboard at `/merchant`: a shell with navigation, **product management** (create/edit/delete the merchant's own products), and **shop settings** (shipping rates, payment details, Telegram). Everything scoped to the signed-in merchant via RLS.

**Scope:** This phase delivers the original ask — *merchants create their own products* — plus shop config. **Orders** and **Customers** management are intentionally deferred to P5, because per-merchant orders/customers only exist once the storefront lets customers order. P4 adds nav stubs for them.

**Data model:** products live in the P0 `products` table (`merchant_id` FK, RLS `products_write_own`). Shop config lives in `merchants.config` (jsonb) + `merchants.shipping` + `merchants.payment_qr/payment_bank/payment_note`. Telegram secrets live in `merchant_secrets` (owner-only RLS). All reads/writes scoped through `current_merchant_id()` (owner_id = auth.uid()).

**Verify:** active merchant logs in → `/merchant` shows the dashboard → adds/edits/deletes products (persist in DB, visible only to them) → edits shipping + payment + Telegram → values persist. A second merchant cannot see the first's products (RLS). `npm test` green.

## Global Constraints
- All Supabase access via `store.js`. Bilingual `t()`. React 19/Vite 8.
- Scope every query to the session merchant (`useSession().merchant`); never trust a client-passed merchant_id for writes (RLS enforces, but pass the session merchant's id).
- Do not break P1–P3 or the legacy `/`.
- Product fields (P0 `products`): `name, name_zh, descr, descr_zh, price, unit, sort, active`.

---

### Task 4.1: Store — product CRUD + shop config

**Files:** Modify `src/store.js`; extend `src/store.test.js`

**Interfaces:**
- `fetchProducts(merchantId) => Promise<Product[]>` — products for a merchant, ordered by `sort` then `created_at`.
- `upsertProduct(product) => Promise<Product>` — insert (no id) or update (with id); `product` must include `merchant_id`.
- `deleteProduct(id) => Promise<void>`.
- `updateMerchantConfig(id, patch) => Promise<Merchant>` — patch is `{ name?, shipping?, config?, payment_qr?, payment_bank?, payment_note? }`; merges into the merchants row.
- `fetchMerchantSecret(merchantId) => Promise<{tg_token, tg_chat_id} | null>`; `upsertMerchantSecret(merchantId, {tg_token, tg_chat_id})`.

- [ ] **Step 1: Failing tests** (append to `src/store.test.js`, reuse harness). Assert: `fetchProducts` → `from('products').select('*').eq('merchant_id',id).order(...)`; `upsertProduct` → `from('products').upsert(obj)`; `deleteProduct` → `from('products').delete().eq('id',id)`; `updateMerchantConfig` → `from('merchants').update(patch).eq('id',id)`; secret fns → `from('merchant_secrets')...`. (You may need to add `delete`/`upsert` terminals to the mock harness — extend cleanly, keep all prior tests green.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** in `store.js`:

```js
export async function fetchProducts(merchantId) {
  if (!merchantId) return []
  const { data, error } = await supabase
    .from('products').select('*').eq('merchant_id', merchantId)
    .order('sort', { ascending: true }).order('created_at', { ascending: true })
  if (error) return []
  return data ?? []
}

export async function upsertProduct(product) {
  const { data, error } = await supabase.from('products').upsert(product).select().single()
  if (error) throw error
  return data
}

export async function deleteProduct(id) {
  const { error } = await supabase.from('products').delete().eq('id', id)
  if (error) throw error
}

export async function updateMerchantConfig(id, patch) {
  const { data, error } = await supabase.from('merchants').update(patch).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function fetchMerchantSecret(merchantId) {
  const { data, error } = await supabase
    .from('merchant_secrets').select('tg_token, tg_chat_id').eq('merchant_id', merchantId).maybeSingle()
  if (error) return null
  return data ?? null
}

export async function upsertMerchantSecret(merchantId, secret) {
  const { error } = await supabase
    .from('merchant_secrets').upsert({ merchant_id: merchantId, ...secret })
  if (error) throw error
}
```

- [ ] **Step 4: Run → PASS**, full `npm test` green.
- [ ] **Step 5: Commit** — `feat: product CRUD and merchant config store functions`

---

### Task 4.2: Dashboard shell + navigation

**Files:** Modify `src/merchant/MerchantHome.jsx`; create `src/merchant/Dashboard.jsx`

**Interfaces:** When `merchant.status === 'active'`, `MerchantHome` renders `<Dashboard/>`. Dashboard has a simple left/top nav with sections: **Products** (default), **Settings**, and disabled/stub items **Orders** and **Customers** (labeled "Coming in P5"). Section state is local (`useState`). Shows the shop name + `/s/<slug>` link.

- [ ] **Step 1: Create `src/merchant/Dashboard.jsx`** — nav + section switch:

```jsx
import { useState } from 'react'
import { useSession } from '../SessionContext'
import ProductsManager from './ProductsManager'
import ShopSettings from './ShopSettings'

const SECTIONS = [
  { key: 'products', en: 'Products', zh: '产品' },
  { key: 'settings', en: 'Settings', zh: '设置' },
]

export default function Dashboard() {
  const { t, merchant } = useSession()
  const [section, setSection] = useState('products')
  return (
    <div style={{ padding: 24, maxWidth: 880 }}>
      <h2>{merchant.name}</h2>
      <p style={{ color:'#888' }}>{t('Store','店铺')}: <a href={`/s/${merchant.slug}`}>/s/{merchant.slug}</a></p>
      <nav style={{ display:'flex', gap:12, margin:'12px 0', borderBottom:'1px solid #eee', paddingBottom:8 }}>
        {SECTIONS.map(s => (
          <button key={s.key} onClick={() => setSection(s.key)}
            style={{ fontWeight: section===s.key ? 700 : 400 }}>{t(s.en, s.zh)}</button>
        ))}
        <span style={{ color:'#bbb' }}>{t('Orders','订单')} ({t('P5','P5')})</span>
        <span style={{ color:'#bbb' }}>{t('Customers','顾客')} ({t('P5','P5')})</span>
      </nav>
      {section === 'products' && <ProductsManager />}
      {section === 'settings' && <ShopSettings />}
    </div>
  )
}
```

- [ ] **Step 2: `MerchantHome.jsx`** — for `status==='active'`, render `<Dashboard/>` instead of the placeholder. Keep pending/suspended branches.
- [ ] **Step 3: Verify** — `npm run build`. (ProductsManager/ShopSettings created next — build may fail until 4.3/4.4; acceptable mid-phase, OR stub them as empty default exports first then fill. Prefer: create minimal stub files in this task so build passes, fill in 4.3/4.4.)
- [ ] **Step 4: Commit** — `feat: merchant dashboard shell with section nav`

---

### Task 4.3: Products manager

**Files:** Create `src/merchant/ProductsManager.jsx`

**Interfaces:** Lists the session merchant's products (`fetchProducts(merchant.id)`); add a new product (name, optional zh name, descr, price, unit); edit inline or via a row form; toggle `active`; delete. Writes via `upsertProduct({ ...fields, merchant_id: merchant.id })` and `deleteProduct(id)`; refetches after each change.

- [ ] **Step 1: Implement** `src/merchant/ProductsManager.jsx`:

```jsx
import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchProducts, upsertProduct, deleteProduct } from '../store'

const BLANK = { name: '', name_zh: '', descr: '', price: '', unit: 'pc', active: true }

export default function ProductsManager() {
  const { t, merchant } = useSession()
  const [rows, setRows] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [busy, setBusy] = useState(false)

  async function load() { setRows(await fetchProducts(merchant.id)) }
  useEffect(() => { load() }, [merchant.id])

  async function save(e) {
    e.preventDefault(); setBusy(true)
    try {
      await upsertProduct({
        ...form,
        price: Number(form.price) || 0,
        merchant_id: merchant.id,
      })
      setForm(BLANK); await load()
    } finally { setBusy(false) }
  }

  async function toggleActive(p) { await upsertProduct({ ...p, active: !p.active }); await load() }
  async function remove(id) { await deleteProduct(id); await load() }

  if (!rows) return <p>{t('Loading…','加载中…')}</p>
  return (
    <div>
      <h3>{t('Your products','您的产品')}</h3>
      {rows.length === 0 && <p>{t('No products yet — add your first below.','还没有产品 — 在下方添加。')}</p>}
      <ul style={{ listStyle:'none', padding:0 }}>
        {rows.map(p => (
          <li key={p.id} style={{ borderTop:'1px solid #eee', padding:'8px 0', opacity: p.active ? 1 : 0.5 }}>
            <b>{p.name}</b>{p.name_zh ? ` / ${p.name_zh}` : ''} — RM {Number(p.price).toFixed(2)} / {p.unit}
            {!p.active && <em> ({t('hidden','已隐藏')})</em>}
            <span style={{ float:'right' }}>
              <button onClick={() => toggleActive(p)}>{p.active ? t('Hide','隐藏') : t('Show','显示')}</button>{' '}
              <button onClick={() => remove(p.id)}>{t('Delete','删除')}</button>
            </span>
          </li>
        ))}
      </ul>
      <form onSubmit={save} style={{ marginTop:16, display:'grid', gap:6, maxWidth:420 }}>
        <h4>{t('Add a product','添加产品')}</h4>
        <input placeholder={t('Name','名称')} value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required />
        <input placeholder={t('Chinese name (optional)','中文名称（可选）')} value={form.name_zh} onChange={e=>setForm({...form,name_zh:e.target.value})} />
        <input placeholder={t('Description','描述')} value={form.descr} onChange={e=>setForm({...form,descr:e.target.value})} />
        <input type="number" step="0.01" placeholder={t('Price (RM)','价格 (RM)')} value={form.price} onChange={e=>setForm({...form,price:e.target.value})} required />
        <input placeholder={t('Unit (pc/box)','单位')} value={form.unit} onChange={e=>setForm({...form,unit:e.target.value})} />
        <button disabled={busy}>{busy ? t('Saving…','保存中…') : t('Add product','添加产品')}</button>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: Verify** (run-and-verify) — active merchant → Products → add a product → appears in list + DB `products` row with correct `merchant_id`; hide/show toggles `active`; delete removes it. `npm test` green; `npm run build` ok.
- [ ] **Step 3: Commit** — `feat: merchant product management`

---

### Task 4.4: Shop settings (shipping, payment, Telegram)

**Files:** Create `src/merchant/ShopSettings.jsx`

**Interfaces:** Edits the session merchant's shipping rates (`shipping` jsonb `{WM, EM}`), payment fields (`payment_bank`, `payment_note`), and Telegram (`tg_token`, `tg_chat_id` via `merchant_secrets`). Loads current values; saves via `updateMerchantConfig(merchant.id, {...})` + `upsertMerchantSecret(merchant.id, {...})`; calls `refreshMerchant()` after save.

- [ ] **Step 1: Implement** `src/merchant/ShopSettings.jsx`:

```jsx
import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { updateMerchantConfig, fetchMerchantSecret, upsertMerchantSecret } from '../store'

export default function ShopSettings() {
  const { t, merchant, refreshMerchant } = useSession()
  const [wm, setWm] = useState(merchant.shipping?.WM ?? 8)
  const [em, setEm] = useState(merchant.shipping?.EM ?? 18)
  const [bank, setBank] = useState(merchant.payment_bank ?? '')
  const [note, setNote] = useState(merchant.payment_note ?? '')
  const [tgToken, setTgToken] = useState('')
  const [tgChat, setTgChat] = useState('')
  const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchMerchantSecret(merchant.id).then(s => {
      if (s) { setTgToken(s.tg_token ?? ''); setTgChat(s.tg_chat_id ?? '') }
    })
  }, [merchant.id])

  async function save(e) {
    e.preventDefault(); setBusy(true); setMsg('')
    try {
      await updateMerchantConfig(merchant.id, {
        shipping: { WM: Number(wm) || 0, EM: Number(em) || 0 },
        payment_bank: bank, payment_note: note,
      })
      await upsertMerchantSecret(merchant.id, { tg_token: tgToken, tg_chat_id: tgChat })
      await refreshMerchant()
      setMsg(t('Saved.','已保存。'))
    } catch (err) { setMsg(err.message || t('Save failed','保存失败')) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={save} style={{ display:'grid', gap:8, maxWidth:440 }}>
      <h3>{t('Shop settings','店铺设置')}</h3>
      <label>{t('Shipping West Malaysia (RM)','西马运费 (RM)')}
        <input type="number" step="0.01" value={wm} onChange={e=>setWm(e.target.value)} /></label>
      <label>{t('Shipping East Malaysia (RM)','东马运费 (RM)')}
        <input type="number" step="0.01" value={em} onChange={e=>setEm(e.target.value)} /></label>
      <label>{t('Bank / payment details','银行/付款信息')}
        <input value={bank} onChange={e=>setBank(e.target.value)} /></label>
      <label>{t('Payment note (shown to customers)','付款备注（顾客可见）')}
        <input value={note} onChange={e=>setNote(e.target.value)} /></label>
      <h4>{t('Order notifications (Telegram)','订单通知（Telegram）')}</h4>
      <label>{t('Bot token','机器人令牌')}
        <input value={tgToken} onChange={e=>setTgToken(e.target.value)} /></label>
      <label>{t('Chat ID','聊天 ID')}
        <input value={tgChat} onChange={e=>setTgChat(e.target.value)} /></label>
      <button disabled={busy}>{busy ? t('Saving…','保存中…') : t('Save settings','保存设置')}</button>
      {msg && <p>{msg}</p>}
    </form>
  )
}
```

- [ ] **Step 2: Verify** — active merchant → Settings → change shipping + payment + Telegram → Save → reload → values persist (config in `merchants`, tg in `merchant_secrets`). Confirm a second merchant can't read the first's `merchant_secrets` (RLS). `npm test` green.
- [ ] **Step 3: Commit** — `feat: merchant shop settings (shipping, payment, Telegram)`

---

## P4 Done
Active merchant gets a working dashboard: manages their own products and shop/payment/Telegram settings, fully tenant-scoped. Original ask — *merchants create their own products* — delivered.

**Carry-forward to P5:** customer storefront at `/s/:slug` consuming these products; per-merchant order creation (next_order_number RPC + merchant_id stamp + server-side Telegram via merchant_secrets); then merchant **Orders** + **Customers** management views light up (the nav stubs). Profile-code restructure + real superadmin seeding still pending.
