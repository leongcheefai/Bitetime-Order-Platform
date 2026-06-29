import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { resolveSlug, RESERVED_SLUGS } from './slug';
import { orderPrefix } from './orderPrefix';
import type { Order, Settings, Voucher } from './types';

export const DEFAULTS = {
  products: [
    { id: 'chewy',   name: 'Soft & chewy cookies',  desc: 'Classic melt-in-your-mouth goodness', price: 12, unit: 'pc'  },
    { id: 'crinkle', name: 'Crinkle cookies',        desc: 'Chewy center with powdery tops',      price: 12, unit: 'pc'  },
    { id: 'lava',    name: 'Stuffed / lava cookies', desc: 'Oozy filling inside every bite',      price: 15, unit: 'pc'  },
    { id: 'box',     name: 'Cookie box / gift set',  desc: 'Beautifully packed assortment',       price: 45, unit: 'box' },
  ],
  shipping: { WM: 8, EM: 18 },
  sameday: {
    enabled: false, origin: '', originLat: null, originLng: null, base: 7, perKm: 1.5, maxKm: 20,
    // Each slot stays selectable until its cutoff hour (24h) passes
    slots: [
      { label: '10:00 AM – 12:00 PM', cutoff: 10 },
      { label: '1:00 PM – 3:00 PM', cutoff: 13 },
      { label: '4:00 PM – 6:00 PM', cutoff: 16 },
    ],
  },
  pickup: { address: '', hours: '' },
  paymentNote: '',
  availableDays: [1, 2, 3, 4, 5, 6],
  leadDays: 3,
  blockedDates: [],
  tgToken: '',
  tgChatId: '',
  ejsServiceId: '',
  ejsTemplateId: '',
  ejsShippingTemplateId: '',
  ejsPublicKey: '',
};

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
    // block this insert — it will succeed (or upsert) once the user confirms
    // and signs in, which is handled in onAuthChange below.
    await supabase.from('profiles').upsert({
      id: data.user.id,
      name,
      email,
      email_confirmed: !!data.user.email_confirmed_at,
      created_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  }
  return data.user;
}

export async function fetchProfileByUserId(userId: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, email, app_role, merchant_id')
    .eq('id', userId)
    .single();
  if (error) return null;
  return data;
}

export async function fetchProfileByEmail(email: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, email')
    .eq('email', email.toLowerCase().trim())
    .single();
  if (error) return null;
  return data;
}

export async function fetchAllProfiles() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, email, email_confirmed, created_at')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

const MERCHANT_STATUSES = ['pending', 'active', 'suspended']

export async function fetchAllMerchants() {
  const { data, error } = await supabase
    .from('merchants').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function setMerchantStatus(id: string, status: string) {
  if (!MERCHANT_STATUSES.includes(status)) throw new Error('Invalid status')
  const { data, error } = await supabase
    .from('merchants').update({ status }).eq('id', id).select().single()
  if (error) throw error
  return data
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

export async function createMerchant({ name, plan = 'basic', billing = 'monthly' }: { name: string; plan?: string; billing?: string }) {
  const user = await getCurrentUser()
  if (!user) throw new Error('Not signed in')
  const taken = await listTakenSlugs()
  const slug = await resolveSlug(name, { taken, id: user.id })
  const { data, error } = await supabase
    .from('merchants')
    .insert({
      name, slug, order_prefix: orderPrefix(slug), owner_id: user.id, status: 'pending',
      plan, billing_cycle: billing,
    })
    .select().single()
  if (error) throw error
  return data
}

// ── Billing (Stripe via the Hono backend) ──────────────────────────────────────

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

// Create a Stripe Checkout Session for the current merchant and return its URL.
export async function startCheckout({ plan, billing }: { plan: string; billing: string }) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')
  const res = await fetch(`${API_URL}/api/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan, billing }),
  })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}))
    throw new Error(error || 'Could not start checkout')
  }
  const { url } = await res.json()
  return url
}

// Read the merchant's authoritative billing row (owner-readable via RLS).
export async function fetchMyBilling(merchantId: string) {
  if (!merchantId) return null
  const { data, error } = await supabase
    .from('merchant_billing').select('*').eq('merchant_id', merchantId).maybeSingle()
  if (error) return null
  return data ?? null
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

export async function resetPassword(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  if (error) throw error;
}

export async function updatePassword(newPassword: string) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
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
        supabase.from('profiles').upsert({
          id: user.id,
          name: user.user_metadata?.name || user.email?.split('@')[0] || '',
          email: user.email,
          email_confirmed: !!user.email_confirmed_at,
          created_at: user.created_at,
          referral_code: referralCodeOf(user.id),
        }, { onConflict: 'id' }).then(({ error }) => {
          if (error) console.error('Profile upsert failed:', error.message);
        });
      }, 0);
    }
    callback(user, event);
  });
  return () => subscription.unsubscribe();
}

// ── Settings ──────────────────────────────────────────────────────────────────

export function loadSettings() {
  try {
    const saved = localStorage.getItem('bitetime_settings');
    return saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(DEFAULTS));
  } catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
}

export function saveSettingsToStorage(settings: Settings) {
  localStorage.setItem('bitetime_settings', JSON.stringify(settings));
}

export async function loadSettingsFromDB() {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'main')
    .single();
  if (error || !data) return null;
  return data.value;
}

export async function saveSettingsToDB(settings: Settings) {
  await supabase
    .from('settings')
    .upsert({ key: 'main', value: settings }, { onConflict: 'key' });
  saveSettingsToStorage(settings);
}

// ── Orders ────────────────────────────────────────────────────────────────────

export async function saveOrder(order: Order) {
  const { error } = await supabase.from('orders').insert(order);
  if (error) {
    console.error('Failed to save order to Supabase:', error.message, error.code, error.details, error.hint);
    throw new Error(error.message);
  }
}

// Re-link an order to a customer account (or null to unlink).
// Returns the updated row; throws if RLS blocks the update (0 rows returned).
export async function updateOrderUser(orderNumber: string, userId: string | null) {
  const { data, error } = await supabase
    .from('orders')
    .update({ user_id: userId })
    .eq('order_number', orderNumber)
    .select('order_number');
  if (error) {
    console.error('Failed to update order user:', error.message, error.code, error.details, error.hint);
    throw new Error(error.message);
  }
  if (!data?.length) throw new Error('Update blocked by database policy (orders RLS)');
}

export async function fetchUserOrders(userId: string) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) { console.error('Failed to fetch orders:', error.message, error.code, error.details, error.hint); return []; }
  return data ?? [];
}

export async function fetchAllOrders() {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) { console.error('Failed to fetch all orders:', error.message); return []; }
  return data ?? [];
}

// Flat list of every line item sold, with the order timestamp.
// Lets a promo count only sales made on/after its start date, so the
// quantity limit starts from 0 when the promo begins (ignores past sales).
// Uses the product_sales() RPC (security definer) so guests can count promo
// sales without read access to the orders table; falls back to a direct
// query for sessions that can read orders (owner).
export async function fetchProductSales() {
  const { data, error } = await supabase.rpc('product_sales');
  if (!error && Array.isArray(data)) {
    return data.filter(r => r.id).map(r => ({ id: r.id, qty: Number(r.qty) || 0, at: r.at }));
  }
  const orders = await fetchAllOrders();
  const sales = [];
  for (const o of orders) {
    for (const item of (o.items || [])) {
      if (item.id) sales.push({ id: item.id, qty: item.qty || 0, at: o.created_at });
    }
  }
  return sales;
}

export async function loadOrderStatuses() {
  const { data } = await supabase.from('settings').select('value').eq('key', 'order_statuses').single();
  return data?.value ?? {};
}

export async function loadOrderAWBs() {
  const { data } = await supabase.from('settings').select('value').eq('key', 'order_awb').single();
  return data?.value ?? {};
}

export async function saveOrderAWB(orderNumber: string, awb: string) {
  const current = await loadOrderAWBs();
  const updated = { ...current, [orderNumber]: awb };
  const { error } = await supabase.from('settings').upsert({ key: 'order_awb', value: updated }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  return updated;
}

export async function saveOrderStatus(orderNumber: string, status: string) {
  const current = await loadOrderStatuses();
  const updated = { ...current, [orderNumber]: status };
  const { error } = await supabase.from('settings').upsert({ key: 'order_statuses', value: updated }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  return updated;
}

// ── Delivery address ──────────────────────────────────────────────────────────

export function loadDeliveryAddressLocal(userId: string) {
  try {
    const raw = localStorage.getItem(`bitetime_addr_${userId}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function saveDeliveryAddress(userId: string, address: any) {
  localStorage.setItem(`bitetime_addr_${userId}`, JSON.stringify(address));
  await supabase.from('profiles').upsert({ id: userId, delivery_address: address }, { onConflict: 'id' });
}

// ── Order counter ─────────────────────────────────────────────────────────────

export async function getNextOrderNumber() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const today = `${yy}${mm}${dd}`;

  const { data } = await supabase.from('settings').select('value').eq('key', 'order_counter').single();
  const current = data?.value ?? null;

  const nextValue = (current && current.date === today) ? current.value + 1 : 50;
  await supabase.from('settings').upsert({ key: 'order_counter', value: { date: today, value: nextValue } }, { onConflict: 'key' });

  return `BT-${today}-${String(nextValue).padStart(4, '0')}`;
}

// ── Vouchers ──────────────────────────────────────────────────────────────────

export async function loadVouchers() {
  const { data } = await supabase.from('settings').select('value').eq('key', 'vouchers').single();
  return data?.value ?? [];
}

export async function saveVouchers(vouchers: Voucher[]) {
  await supabase.from('settings').upsert({ key: 'vouchers', value: vouchers }, { onConflict: 'key' });
}

export async function createVoucher(voucher: Voucher) {
  const list = await loadVouchers();
  const updated = [voucher, ...list];
  await saveVouchers(updated);
  return updated;
}

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

export async function markVoucherUsed(code: string, email: string) {
  const list = await loadVouchers();
  const e = (email || '').toLowerCase();
  const updated = list.map((v: Voucher) => {
    if (v.code !== code) return v;
    const usedBy = Array.isArray(v.usedBy) ? v.usedBy : [];
    // Use email so we can enforce one-per-customer; fall back to a unique
    // guest token so anonymous redemptions still count toward maxUses.
    const entry = e || `guest-${Date.now()}`;
    return { ...v, usedBy: usedBy.includes(entry) ? usedBy : [...usedBy, entry] };
  });
  await saveVouchers(updated);
  return updated;
}

export async function deleteVoucher(code: string) {
  const list = await loadVouchers();
  const updated = list.filter((v: Voucher) => v.code !== code);
  await saveVouchers(updated);
  return updated;
}

// ── Multi-tenant vouchers (per-merchant `vouchers` table) ─────────────────────
// The legacy functions above read a single-tenant `settings` blob. These read
// the merchant-scoped `vouchers` table and map its columns onto the Voucher
// shape the pricing module expects.

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

export async function fetchProfileByReferralCode(code: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, email')
    .eq('referral_code', (code || '').trim().toUpperCase())
    .single();
  if (error) return null;
  return data;
}

// True when no past order matches this WhatsApp number or account email.
// Uses a security-definer RPC because guests cannot read the orders table.
export async function isNewCustomer(wa: string, email: string) {
  const { data, error } = await supabase.rpc('is_new_customer', { p_wa: wa || '', p_email: email || '' });
  if (error) { console.error('is_new_customer RPC failed:', error.message); return false; }
  return data === true;
}

// Ledger of earned referral gifts, stored in the settings key-value table.
// Entry: { id, orderNumber, referrerCode, referrerUserId, giftProductId,
//          giftProductName, status: 'pending' | 'redeemed', createdAt, redeemedOrder }
export async function loadReferralRewards() {
  const { data } = await supabase.from('settings').select('value').eq('key', 'referral_rewards').single();
  return data?.value ?? [];
}

export async function saveReferralRewards(rewards: any) {
  await supabase.from('settings').upsert({ key: 'referral_rewards', value: rewards }, { onConflict: 'key' });
}

export async function loadOrderNotes() {
  const { data } = await supabase.from('settings').select('value').eq('key', 'order_notes').single();
  return data?.value ?? {};
}

export async function saveOrderNote(orderNumber: string, note: string) {
  const current = await loadOrderNotes();
  const updated = { ...current };
  if (note) updated[orderNumber] = note;
  else delete updated[orderNumber];
  const { error } = await supabase.from('settings').upsert({ key: 'order_notes', value: updated }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  return updated;
}

export async function loadDeliveryAddress(userId: string) {
  const local = loadDeliveryAddressLocal(userId);
  if (local) return local;
  const { data } = await supabase.from('profiles').select('delivery_address').eq('id', userId).single();
  if (data?.delivery_address) {
    localStorage.setItem(`bitetime_addr_${userId}`, JSON.stringify(data.delivery_address));
    return data.delivery_address;
  }
  return null;
}

// ── Multi-tenant order placement ─────────────────────────────────────────────

const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled']

export async function placeOrder({ merchantId, customerName, customerWa, mode, address, shippingFee, items, total }: {
  merchantId: string
  customerName: string
  customerWa: string
  mode: string
  address?: any
  shippingFee?: number
  items: any
  total: number
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
    order_number: orderNumber,
    status: 'new',
  }).select().single()
  if (error) throw error
  return { order: data, orderNumber }
}

export async function fetchMerchantOrders(merchantId: string) {
  if (!merchantId) return []
  const { data, error } = await supabase
    .from('orders').select('*').eq('merchant_id', merchantId)
    .order('created_at', { ascending: false })
  if (error) return []
  return data ?? []
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
