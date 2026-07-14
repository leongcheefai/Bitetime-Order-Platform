import type { User } from '@supabase/supabase-js';
import { voucherFromRow } from '@bitetime/shared';
import { supabase } from './supabase';
import { resolveSlug, RESERVED_SLUGS } from './slug';
import { orderPrefix } from './orderPrefix';
import { resolveReferredByCode } from './referralCode'
import { SignupError, signupErrorCode } from './signupError'
import type { Order, ReferredShop, Voucher } from './types';
import type { SavedDetails } from './savedDetails';
import { resetRedirectUrl } from './resetPassword';
import type { AddressParts } from './types'

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signUp(name: string, email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });
  if (error) throw error;
  if (data.user) {
    // If email confirmation is required, there is no session yet and RLS will
    // block this write — it succeeds once the user confirms and signs in, which
    // is handled in onAuthChange below.
    await ensureGlobalProfile({
      user_id: data.user.id,
      name,
      email,
      email_confirmed: !!data.user.email_confirmed_at,
    });
  }
  return data.user;
}

// Customer sign-up. Goes through the backend rather than supabase.auth.signUp because
// email confirmation is on project-wide (it protects merchants, who own shops and Stripe
// billing) — a client-side signUp would return no session and strand the customer in their
// inbox holding a cart. The backend creates the account pre-confirmed with the service role;
// signing in here is what puts the session in this tab, so the cart survives and the order
// they were placing is recorded against them.
export async function signUpCustomer(email: string, password: string) {
  let res: Response
  try {
    res = await fetch(`${API_URL}/api/customer/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  } catch {
    throw new SignupError('network')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new SignupError(signupErrorCode(res.status, body))
  }
  try {
    return await signIn(email, password)
  } catch {
    // The account exists from here on, so a failure now is NOT a wrong password — telling
    // the customer it was would be a lie about credentials we just set for them. Distinct
    // code, so the panel can say what actually happened and offer sign-in.
    throw new SignupError('signin_failed')
  }
}

// The profiles restructure made `id` a surrogate PK and moved auth identity to
// `user_id`; the only unique index on user_id alone is partial (merchant_id IS
// NULL), so ON CONFLICT-based upsert can't target it. Do an explicit
// select-then-insert/update on the user's global (merchant_id null) profile.
// Returns any write error (null on success); RLS blocks the write until the
// user has a session, which is expected during pending email confirmation.
// The one place that knows how to find a user's global profile row. Both writers go through it,
// so the identity rule ("global" means merchant_id IS NULL) is stated once, not once per caller.
async function globalProfileId(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', userId)
    .is('merchant_id', null)
    .maybeSingle();
  return data?.id ?? null;
}

async function ensureGlobalProfile(fields: {
  user_id: string
  name: string
  email?: string | null
  email_confirmed: boolean
  referral_code?: string
}) {
  const existingId = await globalProfileId(fields.user_id);
  if (existingId) {
    const { error } = await supabase.from('profiles').update(fields).eq('id', existingId);
    return error;
  }
  const { error } = await supabase
    .from('profiles')
    .insert({ ...fields, created_at: new Date().toISOString() });
  return error;
}

export async function fetchProfileByUserId(userId: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, email, app_role, merchant_id, whatsapp, delivery_address')
    .eq('user_id', userId)
    .is('merchant_id', null)
    .maybeSingle();
  if (error) return null;
  return data;
}

/**
 * Save what a signed-in customer just typed at checkout, so they never type it again — at this
 * shop or any other. Silent: the customer asked for none of this and is shown no checkbox.
 *
 * Best-effort by design. It runs after an order is already placed, so a failure here must cost
 * the customer nothing but a retype next time; it must never surface as a failed order.
 *
 * Writes the GLOBAL profile (merchant_id null) — the same row `ensureGlobalProfile` maintains, and
 * found the same way, via `globalProfileId`. An address belongs to the customer, not to a shop.
 */
export async function saveCustomerDetails(fields: SavedDetails): Promise<void> {
  if (Object.keys(fields).length === 0) return
  const user = await getCurrentUser()
  if (!user) return // a guest saves nothing, ever — that is what makes the gate's warning true
  const existingId = await globalProfileId(user.id)
  if (existingId) {
    await supabase.from('profiles').update(fields).eq('id', existingId)
    return
  }
  await supabase
    .from('profiles')
    .insert({ ...fields, user_id: user.id, email: user.email, created_at: new Date().toISOString() })
}

const MERCHANT_STATUSES = ['pending', 'active', 'suspended']

export async function fetchAllMerchants() {
  const { data, error } = await supabase
    .from('merchants').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

// Status is the billing enforcement boundary and is service_role-only at the DB
// layer (guard_merchant_status trigger). Direct PostgREST updates are blocked, so
// admin suspend/reject/reactivate goes through the superadmin backend endpoint.
export async function setMerchantStatus(id: string, status: string) {
  if (!MERCHANT_STATUSES.includes(status)) throw new Error('Invalid status')
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')
  const res = await fetch(`${API_URL}/api/admin/set-merchant-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ merchantId: id, status }),
  })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}))
    throw new Error(error || 'Status update failed')
  }
  return res.json()
}

// Superadmin: grant a merchant free Pro (active + pro, no Stripe charge). Goes
// through the backend, which writes status/plan/billing with the service-role key.
export async function compMerchant(id: string) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')
  const res = await fetch(`${API_URL}/api/admin/comp-merchant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ merchantId: id }),
  })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}))
    throw new Error(error || 'Comp failed')
  }
  return res.json()
}

export async function fetchMerchantBySlug(slug: string | undefined) {
  const s = (slug || '').trim().toLowerCase()
  if (!s || RESERVED_SLUGS.includes(s)) return null
  const { data, error } = await supabase
    .from('merchants')
    .select('*')
    .eq('slug', s)
    .single()
  if (error) return null
  return data
}

export async function listTakenSlugs() {
  const { data, error } = await supabase.from('merchants').select('slug')
  if (error) return []
  return (data ?? []).map(r => r.slug)
}

export async function fetchMyMerchant(userId: string) {
  if (!userId) return null
  const { data, error } = await supabase
    .from('merchants').select('*').eq('owner_id', userId).maybeSingle()
  if (error) return null
  return data ?? null
}

export async function createMerchant({ name, plan = 'basic', billing = 'monthly', region = 'US', referredByCode }: { name: string; plan?: string; billing?: string; region?: string; referredByCode?: string }) {
  const user = await getCurrentUser()
  if (!user) throw new Error('Not signed in')
  const taken = await listTakenSlugs()
  const slug = await resolveSlug(name, { taken, id: user.id })
  const { data, error } = await supabase
    .from('merchants')
    .insert({
      name, slug, order_prefix: orderPrefix(slug), owner_id: user.id, status: 'pending',
      plan, billing_cycle: billing, billing_region: region,
      referred_by_code: resolveReferredByCode(referredByCode, referralCodeOf(user.id)),
    })
    .select().single()
  if (error) throw error
  return data
}

// ── Billing (Stripe via the Hono backend) ──────────────────────────────────────

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

// Create a Stripe Checkout Session for the current merchant and return its URL.
// `region` bills the region the pricing page displayed (defaults server-side).
export async function startCheckout({ plan, billing, region }: { plan: string; billing: string; region?: string }) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')
  const res = await fetch(`${API_URL}/api/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan, billing, region }),
  })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}))
    throw new Error(error || 'Could not start checkout')
  }
  const { url } = await res.json()
  return url
}

// Region-resolved platform subscription pricing from the backend. `country` is an
// optional override forwarded as `?country=` (used to preview a region locally / in QA).
export interface PlatformPricing {
  region: string
  currency: string
  prices: {
    basic: { monthly: number; yearly: number }
    pro: { monthly: number; yearly: number }
  }
}

export async function fetchPlatformPricing(country?: string): Promise<PlatformPricing> {
  const qs = country ? `?country=${encodeURIComponent(country)}` : ''
  const res = await fetch(`${API_URL}/api/pricing${qs}`)
  if (!res.ok) throw new Error('Could not load pricing')
  return res.json()
}

export interface MerchantBilling {
  merchant_id: string
  stripe_customer_id?: string | null
  stripe_subscription_id?: string | null
  status?: string | null
  trial_ends_at?: string | null
  current_period_end?: string | null
}

// Superadmin: read every merchant's billing row (RLS grants superadmins read on all).
export async function fetchAllBilling(): Promise<MerchantBilling[]> {
  const { data, error } = await supabase.from('merchant_billing').select('*')
  if (error) throw error
  return data ?? []
}

// Read the merchant's authoritative billing row (owner-readable via RLS).
export async function fetchMyBilling(merchantId: string) {
  if (!merchantId) return null
  const { data, error } = await supabase
    .from('merchant_billing').select('*').eq('merchant_id', merchantId).maybeSingle()
  if (error) return null
  return data ?? null
}

// Superadmin approval goes through the backend: it creates the Stripe customer
// + cardless trialing subscription and flips the shop active in one step.
export async function approveMerchant(merchantId: string) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')
  const res = await fetch(`${API_URL}/api/admin/approve-merchant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ merchantId }),
  })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}))
    throw new Error(error || 'Approval failed')
  }
  return res.json()
}

// Open the Stripe billing portal for the signed-in merchant (add/update card).
export async function openBillingPortal(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')
  const res = await fetch(`${API_URL}/api/billing/portal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}))
    throw new Error(error || 'Could not open billing portal')
  }
  const { url } = await res.json()
  return url
}

export async function updateMerchantSlug(id: string, slug: string) {
  const s = (slug || '').trim().toLowerCase()
  if (!s || RESERVED_SLUGS.includes(s)) throw new Error('Reserved or empty slug')
  const taken = await listTakenSlugs()
  if (taken.includes(s)) throw new Error('Slug already taken')
  const { data, error } = await supabase
    .from('merchants').update({ slug: s }).eq('id', id).select().single()
  if (error) throw error
  return data
}

/**
 * Ask Supabase to email a recovery link. Deliberately NOT mirrored on the custom signup endpoint:
 * going through Supabase buys two things for free that a custom endpoint would force us to rebuild
 * — its own rate limiting, and NON-ENUMERATION (the call succeeds whether or not the address has an
 * account, so the caller can only ever show the neutral message).
 *
 * Note the asymmetry with signup, which DOES disclose that an email already has an account. That
 * was accepted knowingly there. Do not "fix" reset to match it: the leak exists once already, and
 * there is no reason to open a second.
 */
export async function requestPasswordReset(email: string, shopSlug: string | null): Promise<void> {
  // NEVER throws, and never reports the outcome. That is the whole guarantee, and it lives here so
  // that no caller can leak it by accident: Supabase's per-email cooldown only fires when a mail is
  // actually SENT — i.e. only for an address that has an account — so an error surfaced to the UI
  // would tell an attacker which addresses are registered. Two requests a minute apart is the whole
  // attack. Callers show the neutral message unconditionally because there is nothing else to show.
  //
  // The cost is real and accepted: a genuine failure (network down) looks like success to the
  // customer, who waits for a mail that never comes. Enumeration is the worse of the two.
  try {
    await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: resetRedirectUrl(window.location.origin, shopSlug),
    })
  } catch { /* swallowed on purpose — see above */ }
}

/** Set the new password for the session the recovery link just established. */
export async function updatePassword(password: string) {
  const { error } = await supabase.auth.updateUser({ password })
  if (error) throw error
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getCurrentUser() {
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}

export function onAuthChange(callback: (user: User | null, event?: string) => void) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    const user = session?.user ?? null;
    if (user && (event === 'SIGNED_IN' || event === 'USER_UPDATED')) {
      // Ensure profile exists and email_confirmed is up to date.
      // This handles the case where email confirmation was required at signUp
      // and the profile insert was blocked by RLS (no session at that point).
      // Deferred via setTimeout: awaiting a Supabase call inside onAuthStateChange
      // deadlocks the client's internal auth lock and hangs all later requests.
      setTimeout(() => {
        ensureGlobalProfile({
          user_id: user.id,
          name: user.user_metadata?.name || user.email?.split('@')[0] || '',
          email: user.email,
          email_confirmed: !!user.email_confirmed_at,
          referral_code: referralCodeOf(user.id),
        }).then((error) => {
          if (error) console.error('Profile upsert failed:', error.message);
        });
      }, 0);
    }
    callback(user, event);
  });
  return () => subscription.unsubscribe();
}

// ── Vouchers ──────────────────────────────────────────────────────────────────

// Uses left on a voucher. Infinity = no total cap (still capped to 1 per customer).
export function voucherUsesLeft(v: Voucher) {
  const count = Array.isArray(v.usedBy) ? v.usedBy.length : 0;
  if (v.maxUses == null || v.maxUses === '') return Infinity;
  return Math.max(0, Number(v.maxUses) - count);
}

// True when the voucher can no longer be redeemed by anyone.
export function voucherFullyUsed(v: Voucher) {
  // Legacy single-use vouchers: `used:true` with no usedBy list.
  if (v.used && !Array.isArray(v.usedBy)) return true;
  return voucherUsesLeft(v) <= 0;
}

// ── Multi-tenant vouchers (per-merchant `vouchers` table) ─────────────────────
// Reads the merchant-scoped `vouchers` table and maps its columns onto the
// Voucher shape the pricing module expects.

// The row → domain mapping now lives in @bitetime/shared: the backend prices orders from the
// same voucher rows, and a second copy of this mapping is a second way for the two sides to
// disagree about what a voucher is worth.
export { voucherFromRow } from '@bitetime/shared'

export async function fetchMerchantVouchers(merchantId: string): Promise<Voucher[]> {
  if (!merchantId) return [];
  const { data, error } = await supabase
    .from('vouchers').select('*').eq('merchant_id', merchantId);
  if (error) return [];
  return (data ?? []).map(voucherFromRow);
}

// Fetch one voucher by code with its current used_by, bypassing any stale
// in-memory snapshot. Used to re-validate one-per-customer just before an order
// is placed (the page-load snapshot never sees this session's own redemption).
export async function fetchMerchantVoucher(merchantId: string, code: string): Promise<Voucher | null> {
  if (!merchantId || !code) return null;
  const { data, error } = await supabase
    .from('vouchers').select('*')
    .eq('merchant_id', merchantId).eq('code', code).maybeSingle();
  if (error || !data) return null;
  return voucherFromRow(data);
}

// `redeemVoucher` is gone, and its absence is the fix. Redemption was a SECOND call made
// after the order was already committed, so a failure left the customer holding a discount on
// a voucher that was never marked used — reusable forever. The claim now happens inside
// placeOrder's transaction, server-side. There is no longer a second call to swallow.

// Merchant-facing voucher management (writes the merchant's own rows — allowed
// by vouchers_write_own).
export async function createMerchantVoucher(input: {
  merchantId: string; code: string; kind: string; amount: number; maxUses?: number | null;
}): Promise<Voucher> {
  const { data, error } = await supabase.from('vouchers').insert({
    merchant_id: input.merchantId,
    code: input.code.trim().toUpperCase(),
    kind: input.kind,
    amount: input.amount,
    max_uses: input.maxUses ?? null,
  }).select().single();
  if (error) throw error;
  return voucherFromRow(data);
}

export async function deleteMerchantVoucher(id: string) {
  const { error } = await supabase.from('vouchers').delete().eq('id', id);
  if (error) throw error;
}

// ── Referral program ─────────────────────────────────────────────────────────
// A member's referral code is the first 8 hex chars of their profile UUID,
// so the code itself identifies the referrer. Also stored in
// profiles.referral_code for lookup.
export function referralCodeOf(userId: string) {
  return (userId || '').replace(/-/g, '').slice(0, 8).toUpperCase();
}

// Shops that signed up with the current user's referral code.
//
// The code is never sent — the backend derives it from the bearer token, exactly as the
// my_referred_shops RPC this replaces derived it from auth.uid(). Sending it would turn the
// endpoint into a cross-tenant read of any referrer's shops.
export async function fetchReferredShops(): Promise<ReferredShop[]> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')
  const res = await fetch(`${API_URL}/api/referrals/shops`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}))
    throw new Error(error || 'Could not load referred shops')
  }
  return (await res.json()) as ReferredShop[]
}

// ── Multi-tenant order placement ─────────────────────────────────────────────

const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled']

/**
 * Why an order was refused, in the backend's own words.
 *
 * A DELIBERATE TWIN of `OrderErrorCode` in `apps/backend/src/orders.ts` — the backend is a
 * separate workspace, and these codes are the wire contract between them. Add a code there and
 * you must add it here and give it a `t(en, zh)` message in `Storefront.tsx`'s `handleSubmit`
 * catch block (VOUCHER_REFUSALS is the table for the voucher ones), or the customer gets
 * "something went wrong" for a refusal we know the reason for.
 */
export type OrderErrorCode =
  | 'merchant_not_found'
  | 'merchant_inactive'
  | 'voucher_not_found'
  | 'voucher_already_used'
  | 'voucher_fully_used'
  | 'voucher_entry_required'
  | 'price_changed'
  | 'product_unavailable'
  | 'delivery_state_required'

/**
 * A refusal the customer can do something about — retry without the voucher, come back later.
 *
 * `network` and `order_failed` are the browser's own additions, and have no backend twin: the
 * first is a fetch that never landed, the second a server fault with no code to explain it.
 */
export class OrderError extends Error {
  constructor(readonly code: OrderErrorCode | 'order_failed' | 'network') {
    super(code)
    this.name = 'OrderError'
  }
}

/**
 * Place an order: ONE call, which commits the order number, the order row, the voucher claim
 * and THE PRICE in a single transaction server-side.
 *
 * This used to be three trips from the browser with no transaction around them — take a
 * number, insert the order, then record the redemption — and the storefront threw the third
 * one's error away. A failed redemption therefore left the order committed with the discount
 * applied and the voucher never marked used, so the customer kept the discount and could
 * reuse the voucher forever. The three trips are now one, and a failed claim rolls the order
 * back rather than gifting it.
 *
 * The browser no longer has INSERT on `orders` at all (the grant is revoked), so there is no
 * path back to the old shape even by accident. `user_id` is not sent: the backend takes it
 * from this request's JWT, and sending it would be ignored.
 *
 * We send what the customer WANTS (the cart) and what they SAW (`quotedTotal`) — never what it
 * costs. The backend derives every number from its own rows; sending a total would mean any
 * client could name its own. If the backend's price disagrees with our quote it refuses with
 * `price_changed` rather than charging a number the customer never confirmed.
 */
export async function placeOrder({ merchantId, customerName, customerWa, mode, address, cart, quotedTotal, voucherCode, voucherEntry }: {
  merchantId: string
  customerName: string
  customerWa: string
  // The wire contract, not a string: the backend allowlists exactly these two and 400s on
  // anything else, because `mode` selects the shipping fee. Mirrors PlaceOrderInput's union.
  mode: 'pickup' | 'delivery'
  address?: AddressParts | string
  cart: Record<string, number>
  quotedTotal: number
  voucherCode?: string | null
  voucherEntry?: string | null
}) {
  // Optional: a guest has no session, and guest checkout is a first-class path.
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token

  // `fetch` REJECTS on a network or CORS failure rather than returning a non-ok response, so
  // an offline customer would otherwise get a raw "Failed to fetch" on the checkout screen.
  const res = await fetch(`${API_URL}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      merchantId, customerName, customerWa, mode, address,
      cart, quotedTotal, voucherCode, voucherEntry,
    }),
  }).catch(() => null)
  if (!res) throw new OrderError('network')

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}))
    throw new OrderError(payload?.error ?? 'order_failed')
  }
  return (await res.json()) as { orderNumber: string }
}

// Trigger the server-side order notification (Telegram). The bot token stays on
// the backend, which reads it from merchant_secrets — only the order reference
// is sent from the browser.
export async function notifyOrderPlacedRemote(merchantId: string, orderNumber: string) {
  const res = await fetch(`${API_URL}/api/notify/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchantId, orderNumber }),
  })
  if (!res.ok) throw new Error('Order notification failed')
}

/**
 * How far back a customer's per-shop history goes. Stated on screen, never applied silently:
 * a truncated list with nothing said reads as "this is everything" when it isn't.
 */
export const ORDER_HISTORY_LIMIT = 20

/**
 * The orders *this* customer placed at *this* shop, newest first.
 *
 * The `user_id` filter is not belt-and-braces on top of RLS — it is the whole point. The select
 * policy grants a row to the ordering user OR the shop that owns it, so a merchant opening their
 * own storefront's history would be handed every customer's order at that shop. Filtering by the
 * signed-in uid is what makes "your orders" mean yours.
 */
export async function fetchMyOrdersAtShop(merchantId: string): Promise<Order[]> {
  if (!merchantId) return []
  const user = await getCurrentUser()
  if (!user) return [] // a guest has no history — by design, and permanently
  const { data, error } = await supabase
    .from('orders').select('*')
    .eq('merchant_id', merchantId)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(ORDER_HISTORY_LIMIT)
  // Throws rather than returning [] — this screen renders an empty list as "you haven't ordered
  // from this shop yet", so swallowing an error here would tell a customer with a year of orders
  // that they have none. An empty history and a broken query must not look alike.
  if (error) throw error
  return (data ?? []) as Order[]
}

export async function fetchMerchantOrders(merchantId: string) {
  if (!merchantId) return []
  const { data, error } = await supabase
    .from('orders').select('*').eq('merchant_id', merchantId)
    .order('created_at', { ascending: false })
  if (error) return []
  return data ?? []
}

// True once the merchant has ≥1 order — used to lock the currency selector so
// past orders and dashboard aggregates never silently re-denominate.
export async function merchantHasOrders(merchantId: string) {
  if (!merchantId) return false
  const { count, error } = await supabase
    .from('orders').select('id', { count: 'exact', head: true }).eq('merchant_id', merchantId)
  if (error) return false
  return (count ?? 0) > 0
}

export async function setOrderStatus(orderId: string, status: string) {
  if (!ORDER_STATUSES.includes(status)) throw new Error('Invalid status')
  const { data, error } = await supabase
    .from('orders').update({ status }).eq('id', orderId).select().single()
  if (error) throw error
  return data
}

export async function setOrderNote(orderId: string, note: string) {
  const trimmed = note.trim()
  const { data, error } = await supabase
    .from('orders').update({ note: trimmed || null }).eq('id', orderId).select().single()
  if (error) throw error
  return data
}

export async function setOrderTracking(orderId: string, courier: string | null, awb: string) {
  const trimmed = awb.trim()
  const { data, error } = await supabase
    .from('orders')
    .update({ courier: courier || null, awb: trimmed || null })
    .eq('id', orderId).select().single()
  if (error) throw error
  return data
}

/**
 * The guest's only way back to an order. Costs the order number AND the phone that placed it:
 * order numbers are a per-shop daily counter, so the number alone is guessable and the endpoint
 * behind this is unauthenticated. The phone is what makes a guess cost ~10^8 tries instead of one.
 *
 * A wrong phone, a wrong number and a failed request are all the same `null` — and the caller
 * must keep showing one message for all of them. Telling them apart would hand back the oracle
 * the phone exists to remove. That is also why nothing here reads a status code or an error body:
 * there is nothing in either to read.
 */
export async function fetchOrderTracking(merchantId: string, orderNumber: string, phone: string) {
  const trimmed = orderNumber.trim()
  const trimmedPhone = phone.trim()
  if (!merchantId || !trimmed || !trimmedPhone) return null
  // `fetch` REJECTS on a network or CORS failure rather than returning a non-ok response, so
  // without this catch the promised null becomes a throw the moment the backend is unreachable.
  const res = await fetch(`${API_URL}/api/orders/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchantId, orderNumber: trimmed, phone: trimmedPhone }),
  }).catch(() => null)
  if (!res || !res.ok) return null
  return (await res.json()) as {
    status: string
    mode: string
    courier: string | null
    awb: string | null
    created_at: string
  } | null
}

export async function fetchMerchantCustomers(merchantId: string) {
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

// ── Products ──────────────────────────────────────────────────────────────────

export async function fetchProducts(merchantId: string) {
  if (!merchantId) return []
  const { data, error } = await supabase
    .from('products').select('*').eq('merchant_id', merchantId)
    .order('sort', { ascending: true }).order('created_at', { ascending: true })
  if (error) return []
  return data ?? []
}

export async function upsertProduct(product: any) {
  const { data, error } = await supabase.from('products').upsert(product).select().single()
  if (error) throw error
  return data
}

export async function deleteProduct(id: string) {
  const { error } = await supabase.from('products').delete().eq('id', id)
  if (error) throw error
}

// ── Product images (Supabase Storage: public `product-images` bucket) ──────────

export const PRODUCT_IMAGE_BUCKET = 'product-images'
export const MAX_PRODUCT_IMAGES = 5
export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024
export const PRODUCT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

// Resolve a stored path to a public URL for rendering.
export function productImageUrl(path: string): string {
  return supabase.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl
}

// Validate + upload files under {merchantId}/{productId}/…; returns stored paths.
export async function uploadProductImages(
  merchantId: string,
  productId: string,
  files: File[],
): Promise<string[]> {
  const paths: string[] = []
  for (const file of files) {
    if (!PRODUCT_IMAGE_TYPES.includes(file.type)) {
      throw new Error(`Unsupported image type: ${file.name}`)
    }
    if (file.size > MAX_PRODUCT_IMAGE_BYTES) {
      throw new Error(`Image too large (max 5MB): ${file.name}`)
    }
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `${merchantId}/${productId}/${crypto.randomUUID()}-${safe}`
    const { error } = await supabase.storage
      .from(PRODUCT_IMAGE_BUCKET)
      .upload(path, file, { contentType: file.type, upsert: true })
    if (error) throw error
    paths.push(path)
  }
  return paths
}

export async function deleteProductImages(paths: string[]): Promise<void> {
  if (!paths?.length) return
  const { error } = await supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove(paths)
  if (error) throw error
}

// ── Merchant config & secrets ─────────────────────────────────────────────────

export async function updateMerchantConfig(id: string, patch: any) {
  const { data, error } = await supabase.from('merchants').update(patch).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function fetchMerchantSecret(merchantId: string) {
  const { data, error } = await supabase
    .from('merchant_secrets').select('tg_token, tg_chat_id').eq('merchant_id', merchantId).maybeSingle()
  if (error) return null
  return data ?? null
}

export async function upsertMerchantSecret(merchantId: string, secret: any) {
  const { error } = await supabase
    .from('merchant_secrets').upsert({ merchant_id: merchantId, ...secret })
  if (error) throw error
}
