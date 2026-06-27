# P3 — Super-admin Approval Queue (expanded)

> Subagent-driven, run-and-verify. Builds on P0–P2. Delivers: the platform owner reviews merchants and approves (`active`) / suspends them, from `/admin/merchants`.

**Auth approach (transitional, consistent with P1/P2):** The platform owner is recognized by **email** on both sides — client (`SessionContext` role fallback → `superadmin`) and DB (baseline `is_owner()` email function). P3 extends the `merchants` UPDATE RLS policy to also allow `is_owner()`, so the owner can change any merchant's status without per-merchant ownership. Real `profiles.app_role='superadmin'` seeding + dropping the email fallback remains deferred (tracked) — it needs the profile-code restructure (P4).

**Verify:** owner visits `/admin/merchants`, sees merchants grouped by status, approves a pending one (→ active), suspends one (→ suspended); changes persist (DB) and the merchant's `/merchant` view reflects status. Non-owner hitting `/admin/*` is redirected. `npm test` green.

## Global Constraints
- All Supabase access via `store.js`. Bilingual `t()`. React 19/Vite 8.
- RLS: `merchants_select_public` already allows reading all merchants (slug resolution) — `fetchAllMerchants` works for the owner. Only UPDATE needs widening.
- Do not break P1/P2 routing or the legacy `/`.

---

### Task 3.1: RLS — let the platform owner update any merchant

**Files:** Create `supabase/migrations/20260627120400_owner_can_manage_merchants.sql`

**Interfaces:** Produces a merchants UPDATE policy that also permits `is_owner()` (email-based, from baseline).

- [ ] **Step 1: Migration**

```sql
-- The platform owner (email-based is_owner(), baseline) can update any merchant
-- — needed for the approval queue before real superadmin role seeding (P4).
drop policy if exists merchants_update_own_or_super on public.merchants;
create policy merchants_update_own_or_super on public.merchants
  for update
  using (owner_id = auth.uid() or public.is_superadmin() or public.is_owner())
  with check (owner_id = auth.uid() or public.is_superadmin() or public.is_owner());
```

- [ ] **Step 2:** Apply locally — `supabase db reset` clean across all migrations.
- [ ] **Step 3: Commit** — `feat(db): allow platform owner to update any merchant`

---

### Task 3.2: Store — list all merchants + set status

**Files:** Modify `src/store.js`; extend `src/store.test.js`

**Interfaces:**
- `fetchAllMerchants() => Promise<Merchant[]>` — all merchants, newest first.
- `setMerchantStatus(id, status) => Promise<Merchant>` — status must be one of `active|suspended|pending`; updates and returns the row.

- [ ] **Step 1: Failing tests** (append to `src/store.test.js`, reuse the mock harness; the `select` terminal-list pattern is already used by `listTakenSlugs` — follow it; for `setMerchantStatus` assert `update({status}).eq('id', id)` and that an invalid status throws before any DB call).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** in `store.js`:

```js
const MERCHANT_STATUSES = ['pending', 'active', 'suspended']

export async function fetchAllMerchants() {
  const { data, error } = await supabase
    .from('merchants').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function setMerchantStatus(id, status) {
  if (!MERCHANT_STATUSES.includes(status)) throw new Error('Invalid status')
  const { data, error } = await supabase
    .from('merchants').update({ status }).eq('id', id).select().single()
  if (error) throw error
  return data
}
```

- [ ] **Step 4: Run → PASS**, full `npm test` green.
- [ ] **Step 5: Commit** — `feat: fetchAllMerchants and setMerchantStatus store functions`

---

### Task 3.3: Admin merchants queue UI

**Files:** Create `src/admin/AdminMerchants.jsx`; modify `src/AppRouter.jsx`

**Interfaces:** `/admin/merchants` behind `RequireRole role="superadmin"` → `AdminMerchants`. Lists merchants; per row shows name/slug/status and actions: pending → **Approve** (setMerchantStatus active) + **Reject** (suspended); active → **Suspend**; suspended → **Reactivate** (active). Refetches after each action.

- [ ] **Step 1: `src/admin/AdminMerchants.jsx`**

```jsx
import { useEffect, useState } from 'react'
import { fetchAllMerchants, setMerchantStatus } from '../store'
import { useSession } from '../SessionContext'

export default function AdminMerchants() {
  const { t } = useSession()
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(null)

  async function load() { setRows(await fetchAllMerchants()) }
  useEffect(() => { load() }, [])

  async function act(id, status) {
    setBusy(id)
    try { await setMerchantStatus(id, status); await load() }
    finally { setBusy(null) }
  }

  if (!rows) return <div style={{ padding: 24 }}>{t('Loading…','加载中…')}</div>

  return (
    <div style={{ padding: 24, maxWidth: 760 }}>
      <h2>{t('Merchants','商家')}</h2>
      {rows.length === 0 && <p>{t('No merchants yet.','暂无商家。')}</p>}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={{ textAlign:'left' }}>{t('Shop','店铺')}</th>
          <th style={{ textAlign:'left' }}>{t('Slug','网址')}</th>
          <th style={{ textAlign:'left' }}>{t('Status','状态')}</th>
          <th>{t('Actions','操作')}</th>
        </tr></thead>
        <tbody>
          {rows.map(m => (
            <tr key={m.id} style={{ borderTop:'1px solid #eee' }}>
              <td>{m.name}</td>
              <td>/s/{m.slug}</td>
              <td>{m.status}</td>
              <td style={{ textAlign:'right' }}>
                {m.status === 'pending' && <>
                  <button disabled={busy===m.id} onClick={() => act(m.id,'active')}>{t('Approve','批准')}</button>{' '}
                  <button disabled={busy===m.id} onClick={() => act(m.id,'suspended')}>{t('Reject','拒绝')}</button>
                </>}
                {m.status === 'active' && <button disabled={busy===m.id} onClick={() => act(m.id,'suspended')}>{t('Suspend','暂停')}</button>}
                {m.status === 'suspended' && <button disabled={busy===m.id} onClick={() => act(m.id,'active')}>{t('Reactivate','恢复')}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 2: Route** — in `AppRouter.jsx` replace the `/admin/*` placeholder:

```jsx
<Route path="/admin/merchants" element={<RequireRole role="superadmin"><AdminMerchants /></RequireRole>} />
<Route path="/admin" element={<RequireRole role="superadmin"><AdminMerchants /></RequireRole>} />
```
Import `AdminMerchants`. Keep other routes.

- [ ] **Step 3: Verify** (run-and-verify) — as the owner (email-fallback superadmin), visit `/admin/merchants`: see merchants; approve a pending one → status flips to active and the row updates; suspend → suspended. Confirm in DB. Non-superadmin → redirect. `npm test` green; `npm run build` ok.
- [ ] **Step 4: Commit** — `feat: super-admin merchant approval queue`

---

## P3 Done
Owner approves/suspends merchants from `/admin/merchants` (replacing the manual SQL flips). Transitional email-owner = superadmin on both client and DB (via is_owner()).

**Carry-forward:** real `profiles.app_role='superadmin'` seeding + dropping the email fallback → deferred, needs profile-code restructure (P4); approval emails/audit log out of scope; `slug_locked` lifecycle still not DB-enforced.
