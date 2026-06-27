# P2 — Merchant Signup + Onboarding (expanded)

> Subagent-driven, run-and-verify. Builds on P0 (schema/RLS) + P1 (router/session/role). Delivers: a prospective merchant signs up with a shop name (+ email/password), gets an auto-generated slug (editable once), a `merchants` row is created in `pending`, and they land on a "waiting for approval" screen. Merchant login routes them by status.

**Role model (locked):** A user is a **merchant** iff they own a `merchants` row (`merchants.owner_id = auth.uid()`), resolved via `fetchMyMerchant`. This avoids the P0 privilege-guard trigger (which blocks clients setting `app_role`) and the profile-restructure debt (deferred to P4). **Superadmin** stays on the transitional email fallback from P1 until P3. **Customer** = default.

**Verify:** `npm run dev` → `/merchant/signup` creates a pending merchant and shows the pending screen; `/merchant/login` signs in and routes (no merchant → signup; pending → pending screen; active → dashboard placeholder); `RequireRole role="merchant"` now passes for merchant owners. `npm test` green; new unit tests for pure/store logic.

## Global Constraints
- React 19.2.x / Vite 8.x; all Supabase access via `src/store.js`.
- Bilingual: all copy via `t(en, zh)` from `useSession()`.
- Slug rules (P0 `src/slug.js`): `resolveSlug(name, { taken, id })`, `RESERVED_SLUGS`. Auto-gen; editable once (then `slug_locked`); collisions suffixed; reserved blocked; pinyin for Chinese.
- Order prefix derived from slug, uppercased, alphanumeric, first 2 chars, fallback `SH`.
- RLS already permits: client INSERT into `merchants` with `owner_id = auth.uid()` (`merchants_insert_self`), public SELECT (slug/owner lookup), owner UPDATE. DML grants exist (P0). DB `unique(slug)` backstops slug races.
- Do not break the legacy `/` experience or P1 routing.
- Email-confirmation caveat: if Supabase local has email confirmations ON, auto-sign-in after signup fails; the signup screen must show a "confirm your email, then log in to finish" fallback and finish merchant creation on first login when the user owns no merchant. (Local default is confirmations OFF — happy path auto-signs-in.)

---

### Task 2.1: `orderPrefix` pure function

**Files:** Create `src/orderPrefix.js`, `src/orderPrefix.test.js`

**Interfaces:** Produces `orderPrefix(slug) => string` — uppercased, alphanumeric-only, first 2 chars; fallback `'SH'` when fewer than 2 alphanumerics.

- [ ] **Step 1: Failing test** (`src/orderPrefix.test.js`)

```js
import { describe, it, expect } from 'vitest'
import { orderPrefix } from './orderPrefix'

describe('orderPrefix', () => {
  it('takes first two alphanumerics uppercased', () => {
    expect(orderPrefix('cookie-corner')).toBe('CO')
    expect(orderPrefix('dian-xin-pu')).toBe('DI')
  })
  it('skips non-alphanumerics', () => {
    expect(orderPrefix('a-b-c')).toBe('AB')
  })
  it('falls back to SH when too short', () => {
    expect(orderPrefix('x')).toBe('SH')
    expect(orderPrefix('')).toBe('SH')
  })
})
```

- [ ] **Step 2: Run → FAIL.** `npm test -- src/orderPrefix.test.js`

- [ ] **Step 3: Implement** (`src/orderPrefix.js`)

```js
export function orderPrefix(slug) {
  const alnum = String(slug ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return alnum.length >= 2 ? alnum.slice(0, 2) : 'SH'
}
```

- [ ] **Step 4: Run → PASS**, full `npm test` green.
- [ ] **Step 5: Commit** — `feat: add orderPrefix derivation`

---

### Task 2.2: Store — merchant create/lookup/slug

**Files:** Modify `src/store.js`; extend `src/store.test.js`

**Interfaces:**
- `listTakenSlugs() => Promise<string[]>` — all existing merchant slugs.
- `createMerchant({ name }) => Promise<Merchant>` — resolves a unique slug from `name` against `listTakenSlugs()`, derives `order_prefix`, inserts `{ name, slug, order_prefix, owner_id: auth uid, status: 'pending' }`, returns the row.
- `fetchMyMerchant(userId) => Promise<Merchant | null>` — merchant owned by `userId`.
- `updateMerchantSlug(id, slug) => Promise<Merchant>` — updates slug only when not `slug_locked` (re-validate against reserved + taken); throws on reserved/taken.

- [ ] **Step 1: Failing tests** (append to `src/store.test.js`, reuse the existing `vi.mock('./supabase')` harness; you'll need the mock to support `.insert().select().single()`, `.update().eq().select().single()`, and `.select()` returning a list — extend the mock factory to expose chainable `insert`/`update`/`order` as needed and assert real behavior). Cover:
  - `fetchMyMerchant` returns the row for an owner, null on error.
  - `createMerchant` rejects/throws when name resolves to a reserved-only slug? (not required — resolveSlug already avoids reserved). Instead assert: it calls insert with `owner_id`, `status:'pending'`, a slug derived from name, and `order_prefix` from that slug.
  - `updateMerchantSlug` throws when the target slug is reserved.

Write concrete assertions on the arguments passed to the mocked supabase builder (table name, inserted object fields), not just return values.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** in `src/store.js` (add imports `resolveSlug`, `RESERVED_SLUGS` from `./slug`, `orderPrefix` from `./orderPrefix`, and `getCurrentUser` already exists):

```js
export async function listTakenSlugs() {
  const { data, error } = await supabase.from('merchants').select('slug')
  if (error) return []
  return (data ?? []).map(r => r.slug)
}

export async function fetchMyMerchant(userId) {
  if (!userId) return null
  const { data, error } = await supabase
    .from('merchants').select('*').eq('owner_id', userId).maybeSingle()
  if (error) return null
  return data ?? null
}

export async function createMerchant({ name }) {
  const user = await getCurrentUser()
  if (!user) throw new Error('Not signed in')
  const taken = await listTakenSlugs()
  const slug = resolveSlug(name, { taken, id: user.id })
  const { data, error } = await supabase
    .from('merchants')
    .insert({ name, slug, order_prefix: orderPrefix(slug), owner_id: user.id, status: 'pending' })
    .select().single()
  if (error) throw error
  return data
}

export async function updateMerchantSlug(id, slug) {
  const s = (slug || '').trim().toLowerCase()
  if (!s || RESERVED_SLUGS.includes(s)) throw new Error('Reserved or empty slug')
  const taken = await listTakenSlugs()
  if (taken.includes(s)) throw new Error('Slug already taken')
  const { data, error } = await supabase
    .from('merchants').update({ slug: s }).eq('id', id).select().single()
  if (error) throw error
  return data
}
```
(Note: `slug_locked` enforcement is also defended in the UI — the edit control is only shown pre-lock. DB-level lock enforcement is a P3 concern per the master plan.)

- [ ] **Step 4: Run → PASS**, full `npm test` green.
- [ ] **Step 5: Commit** — `feat: merchant create/lookup/slug store functions`

---

### Task 2.3: Session — owned merchant + merchant role

**Files:** Modify `src/SessionContext.jsx`

**Interfaces:** `useSession()` additionally returns `merchant` (the owned merchant or null) and `refreshMerchant()`. `role` becomes: `superadmin` (profile.app_role==='superadmin' OR transitional owner email) → else `merchant` (owns a merchant) → else `customer`.

- [ ] **Step 1: Implement.** In `SessionContext.jsx`:
  - import `fetchMyMerchant` from `./store`.
  - add `const [merchant, setMerchant] = useState(null)`.
  - in the auth effect, after setting account: `if (user) fetchMyMerchant(user.id).then(setMerchant); else setMerchant(null)`.
  - `const refreshMerchant = () => account && fetchMyMerchant(account.id).then(setMerchant)`.
  - role:
    ```js
    const isSuper = profile?.app_role === 'superadmin' || account?.email === USER_EMAIL // TODO(P3) drop email
    const role = isSuper ? 'superadmin' : (merchant ? 'merchant' : 'customer')
    ```
  - add `merchant`, `refreshMerchant` to the context value.

- [ ] **Step 2: Verify** — `npm run build`; `npm test` green. Reason: a signed-in user who owns a merchant now resolves `role==='merchant'`, so `RequireRole role="merchant"` passes.
- [ ] **Step 3: Commit** — `feat: resolve merchant role from owned merchant in session`

---

### Task 2.4: Merchant SignupScreen

**Files:** Create `src/merchant/SignupScreen.jsx`; modify `src/AppRouter.jsx` (route)

**Interfaces:** Renders at `/merchant/signup`. Fields: Shop name, email, password. Live slug preview via `toSlugBase`. On submit: `signUp(name,email,password)` → `signIn(email,password)` (to get a session when confirmations are off) → `createMerchant({name})` → `refreshMerchant()` → `navigate('/merchant/pending')`. If sign-in fails (confirmation required), show: "Check your email to confirm, then log in to finish setting up your shop."

- [ ] **Step 1: Implement** `src/merchant/SignupScreen.jsx`:

```jsx
import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { signUp, signIn, createMerchant } from '../store'
import { toSlugBase } from '../slug'
import { useSession } from '../SessionContext'

export default function SignupScreen() {
  const { t, refreshMerchant } = useSession()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const slugPreview = toSlugBase(name) || 'shop-…'

  async function onSubmit(e) {
    e.preventDefault()
    setBusy(true); setMsg('')
    try {
      await signUp(name, email, password)
      try {
        await signIn(email, password)
      } catch {
        setMsg(t('Account created. Check your email to confirm, then log in to finish setting up your shop.',
                 '账号已创建。请查收邮件确认，然后登录以完成店铺设置。'))
        setBusy(false); return
      }
      await createMerchant({ name })
      await refreshMerchant()
      navigate('/merchant/pending')
    } catch (err) {
      setMsg(err.message || t('Something went wrong.', '出错了。'))
      setBusy(false)
    }
  }

  return (
    <div className="form-wrap" style={{ maxWidth: 420 }}>
      <h2>{t('Start your shop', '开店')}</h2>
      <form onSubmit={onSubmit}>
        <label>{t('Shop name', '店铺名称')}
          <input value={name} onChange={e => setName(e.target.value)} required />
        </label>
        <p style={{ fontSize: 13, color: '#888' }}>{t('Your store URL', '店铺网址')}: /s/{slugPreview}</p>
        <label>{t('Email', '邮箱')}
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
        </label>
        <label>{t('Password', '密码')}
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
        </label>
        <button type="submit" disabled={busy}>{busy ? t('Creating…','创建中…') : t('Create shop','创建店铺')}</button>
      </form>
      {msg && <p style={{ color: '#c00' }}>{msg}</p>}
      <p><Link to="/merchant/login">{t('Already have a shop? Log in','已有店铺？登录')}</Link></p>
    </div>
  )
}
```

- [ ] **Step 2: Route** — in `AppRouter.jsx` add `<Route path="/merchant/signup" element={<SignupScreen />} />` (NOT behind RequireRole — prospective merchants are not yet merchants). Import it.
- [ ] **Step 3: Verify** — `npm run dev`, go to `/merchant/signup`, create a shop (local confirmations off), confirm a `merchants` row appears (Studio) with status `pending` and a slug; lands on pending screen (built next — until then it may 404/blank, acceptable mid-task). `npm test` green.
- [ ] **Step 4: Commit** — `feat: merchant signup screen`

---

### Task 2.5: Login + Pending + routing by status

**Files:** Create `src/merchant/LoginScreen.jsx`, `src/merchant/PendingScreen.jsx`, `src/merchant/MerchantHome.jsx` (status router); modify `src/AppRouter.jsx`

**Interfaces:**
- `/merchant/login` → `LoginScreen` (email/password → `signIn` → navigate `/merchant`).
- `/merchant` (behind `RequireRole role="merchant"`) → `MerchantHome`: reads `useSession().merchant`; if `status==='pending'` render `PendingScreen`; if `'suspended'` render a suspended notice; if `'active'` render the dashboard placeholder ("Merchant dashboard — P4").
- Unauthenticated/non-merchant hitting `/merchant` → `RequireRole` redirects to `/` (existing). Add: a signed-in user who owns no merchant should be sent to `/merchant/signup` — handle inside `MerchantHome` by `if (!merchant) return <Navigate to="/merchant/signup" />` (covers the role-resolved-but-no-merchant edge).

- [ ] **Step 1: `LoginScreen.jsx`**

```jsx
import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { signIn } from '../store'
import { useSession } from '../SessionContext'

export default function LoginScreen() {
  const { t, refreshMerchant } = useSession()
  const navigate = useNavigate()
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('')
  async function onSubmit(e) {
    e.preventDefault(); setBusy(true); setMsg('')
    try { await signIn(email, password); await refreshMerchant(); navigate('/merchant') }
    catch (err) { setMsg(err.message || t('Login failed','登录失败')); setBusy(false) }
  }
  return (
    <div className="form-wrap" style={{ maxWidth: 420 }}>
      <h2>{t('Merchant login','商家登录')}</h2>
      <form onSubmit={onSubmit}>
        <label>{t('Email','邮箱')}<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label>
        <label>{t('Password','密码')}<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required/></label>
        <button disabled={busy}>{busy?t('Logging in…','登录中…'):t('Log in','登录')}</button>
      </form>
      {msg && <p style={{color:'#c00'}}>{msg}</p>}
      <p><Link to="/merchant/signup">{t('New here? Start your shop','新用户？开店')}</Link></p>
    </div>
  )
}
```

- [ ] **Step 2: `PendingScreen.jsx`**

```jsx
import { useSession } from '../SessionContext'
export default function PendingScreen() {
  const { t, merchant } = useSession()
  return (
    <div className="form-wrap" style={{ maxWidth: 480 }}>
      <h2>{t('Shop pending approval','店铺待审核')}</h2>
      <p>{t('Your shop','您的店铺')} <b>{merchant?.name}</b> {t('is awaiting platform approval. You’ll be able to manage it once approved.','正在等待平台审核。审核通过后即可管理。')}</p>
      <p style={{ color:'#888' }}>{t('Store URL','店铺网址')}: /s/{merchant?.slug}</p>
    </div>
  )
}
```

- [ ] **Step 3: `MerchantHome.jsx`**

```jsx
import { Navigate } from 'react-router-dom'
import { useSession } from '../SessionContext'
import PendingScreen from './PendingScreen'
export default function MerchantHome() {
  const { t, merchant } = useSession()
  if (!merchant) return <Navigate to="/merchant/signup" replace />
  if (merchant.status === 'pending') return <PendingScreen />
  if (merchant.status === 'suspended') return <div className="form-wrap"><h2>{t('Shop suspended','店铺已暂停')}</h2></div>
  return <div className="form-wrap"><h2>{t('Merchant dashboard','商家后台')}</h2><p>{t('Coming in P4','P4 推出')}</p></div>
}
```

- [ ] **Step 4: Wire `AppRouter.jsx`** — replace the `/merchant/*` placeholder. Final merchant routes:

```jsx
<Route path="/merchant/signup" element={<SignupScreen />} />
<Route path="/merchant/login" element={<LoginScreen />} />
<Route path="/merchant" element={<RequireRole role="merchant"><MerchantHome /></RequireRole>} />
```
Keep `/admin/*` and `/s/:slug` as-is. Import the three new screens.

Note on RequireRole vs the no-merchant edge: a signed-in user who owns no merchant resolves `role==='customer'`, so `RequireRole role="merchant"` redirects them to `/` before `MerchantHome` runs. That's fine — the `MerchantHome` `!merchant` guard covers the race where the merchant was just created and session is mid-refresh. Prospective merchants reach signup via `/merchant/signup` (unguarded) directly.

- [ ] **Step 5: Verify** (run-and-verify) — `npm run dev`:
  - `/merchant/signup` → create shop → pending screen.
  - sign out, `/merchant/login` → log in → `/merchant` → pending screen (status pending).
  - in Studio set that merchant's `status='active'` → reload `/merchant` → dashboard placeholder.
  - `/merchant` while signed out → redirect to `/`.
  - `npm test` green.
- [ ] **Step 6: Commit** — `feat: merchant login, pending screen, and status routing`

---

## P2 Done
Merchant can self-sign-up (shop name → auto-slug → pending), log in, and is routed by status. `RequireRole role="merchant"` works off owned-merchant. Superadmin still transitional-email (P3).

**Carry-forward:** slug edit-once UI not yet built (only `updateMerchantSlug` store fn exists — wire an "edit slug" control during onboarding in a follow-up or fold into P4 settings); DB-level `slug_locked`/status-lifecycle enforcement → P3; email-confirmation-ON flow finishes merchant creation on first login (handle in P3/P4 if confirmations get enabled); profile-code still on legacy `id==user.id` path (P4).
