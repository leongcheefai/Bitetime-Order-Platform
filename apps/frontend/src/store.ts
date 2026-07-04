import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { resolveSlug, RESERVED_SLUGS } from './slug';
import { orderPrefix } from './orderPrefix';
import { resolveReferredByCode } from './referralCode'
import type { ReferredShop, Voucher } from './types';

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

// The profiles restructure made `id` a surrogate PK and moved auth identity to
// `user_id`; the only unique index on user_id alone is partial (merchant_id IS
// NULL), so ON CONFLICT-based upsert can't target it. Do an explicit
// select-then-insert/update on the user's global (merchant_id null) profile.
// Returns any write error (null on success); RLS blocks the write until the
// user has a session, which is expected during pending email confirmation.
async function ensureGlobalProfile(fields: {
  user_id: string
  name: string
  email?: string | null
  email_confirmed: boolean
  referral_code?: string
}) {
  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', fields.user_id)
    .is('merchant_id', null)
    .maybeSingle();
  if (existing) {
    const { error } = await supabase.from('profiles').update(fields).eq('id', existing.id);
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
    .select('id, name, email, app_role, merchant_id')
    .eq('user_id', userId)
    .is('merchant_id', null)
    .maybeSingle();
  if (error) return null;
  return data;
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

export function voucherFromRow(row: any): Voucher {
  return {
    id: row.id,
    code: row.code,
    type: row.kind,                 // 'percent' | 'fixed'
    value: Number(row.amount),
    maxUses: row.max_uses ?? null,
    usedBy: Array.isArray(row.used_by) ? row.used_by : [],
  } as Voucher;
}

export async function fetchMerchantVouchers(merchantId: string): Promise<Voucher[]> {
  if (!merchantId) return [];
  const { data, error } = await supabase
    .from('vouchers').select('*').eq('merchant_id', merchantId);
  if (error) return [];
  return (data ?? []).map(voucherFromRow);
}

// Record a redemption. Customers cannot write the vouchers table under RLS, so
// this goes through a security-definer RPC that enforces max_uses / one-per-
// customer server-side.
export async function redeemVoucher(merchantId: string, code: string, entry: string) {
  const { error } = await supabase.rpc('redeem_voucher', {
    p_merchant: merchantId,
    p_code: code,
    p_entry: (entry || '').toLowerCase(),
  });
  if (error) throw error;
}

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

// Shops that signed up with the current user's referral code. Reads the
// my_referred_shops SECURITY DEFINER RPC, which filters by the caller's own code and
// returns only name/created_at/status.
export async function fetchReferredShops(): Promise<ReferredShop[]> {
  const { data, error } = await supabase.rpc('my_referred_shops')
  if (error) throw error
  return (data ?? []) as ReferredShop[]
}

// ── Multi-tenant order placement ─────────────────────────────────────────────

const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled']

export async function placeOrder({ merchantId, customerName, customerWa, mode, address, shippingFee, items, total, currency }: {
  merchantId: string
  customerName: string
  customerWa: string
  mode: string
  address?: any
  shippingFee?: number
  items: any
  total: number
  currency?: string
}) {
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
    currency: currency ?? 'MYR',
    order_number: orderNumber,
    status: 'new',
  }).select().single()
  if (error) throw error
  return { order: data, orderNumber }
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
