import { supabase } from './supabase';

export const DEFAULTS = {
  products: [
    { id: 'chewy',   name: 'Soft & chewy cookies',  desc: 'Classic melt-in-your-mouth goodness', price: 12, unit: 'pc'  },
    { id: 'crinkle', name: 'Crinkle cookies',        desc: 'Chewy center with powdery tops',      price: 12, unit: 'pc'  },
    { id: 'lava',    name: 'Stuffed / lava cookies', desc: 'Oozy filling inside every bite',      price: 15, unit: 'pc'  },
    { id: 'box',     name: 'Cookie box / gift set',  desc: 'Beautifully packed assortment',       price: 45, unit: 'box' },
  ],
  shipping: { WM: 8, EM: 18 },
  tgToken: '8706031871:AAHaSZlTqokNvgvgSh0_2vcRqgj6lcFOxaU',
  tgChatId: '671603959',
  ejsServiceId: '',
  ejsTemplateId: '',
  ejsPublicKey: '',
};

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signUp(name, email, password) {
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

export async function fetchAllProfiles() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, email, email_confirmed, created_at')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getCurrentUser() {
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}

export function onAuthChange(callback) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
    const user = session?.user ?? null;
    if (user && (event === 'SIGNED_IN' || event === 'USER_UPDATED')) {
      // Ensure profile exists and email_confirmed is up to date.
      // This handles the case where email confirmation was required at signUp
      // and the profile insert was blocked by RLS (no session at that point).
      await supabase.from('profiles').upsert({
        id: user.id,
        name: user.user_metadata?.name || user.email?.split('@')[0] || '',
        email: user.email,
        email_confirmed: !!user.email_confirmed_at,
        created_at: user.created_at,
      }, { onConflict: 'id' });
    }
    callback(user);
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

export function saveSettingsToStorage(settings) {
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

export async function saveSettingsToDB(settings) {
  await supabase
    .from('settings')
    .upsert({ key: 'main', value: settings }, { onConflict: 'key' });
  saveSettingsToStorage(settings);
}

// ── Orders ────────────────────────────────────────────────────────────────────

export async function saveOrder(order) {
  const { error } = await supabase.from('orders').insert(order);
  if (error) console.error('Failed to save order to Supabase:', error.message, error.code, error.details, error.hint);
}

export async function fetchUserOrders(userId) {
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

export async function loadOrderStatuses() {
  const { data } = await supabase.from('settings').select('value').eq('key', 'order_statuses').single();
  return data?.value ?? {};
}

export async function loadOrderAWBs() {
  const { data } = await supabase.from('settings').select('value').eq('key', 'order_awb').single();
  return data?.value ?? {};
}

export async function saveOrderAWB(orderNumber, awb) {
  const current = await loadOrderAWBs();
  const updated = { ...current, [orderNumber]: awb };
  const { error } = await supabase.from('settings').upsert({ key: 'order_awb', value: updated }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  return updated;
}

export async function saveOrderStatus(orderNumber, status) {
  const current = await loadOrderStatuses();
  const updated = { ...current, [orderNumber]: status };
  const { error } = await supabase.from('settings').upsert({ key: 'order_statuses', value: updated }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  return updated;
}

// ── Delivery address ──────────────────────────────────────────────────────────

export function loadDeliveryAddressLocal(userId) {
  try {
    const raw = localStorage.getItem(`bitetime_addr_${userId}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function saveDeliveryAddress(userId, address) {
  localStorage.setItem(`bitetime_addr_${userId}`, JSON.stringify(address));
  await supabase.from('profiles').upsert({ id: userId, delivery_address: address }, { onConflict: 'id' });
}

// ── Vouchers ──────────────────────────────────────────────────────────────────

export async function loadVouchers() {
  const { data } = await supabase.from('settings').select('value').eq('key', 'vouchers').single();
  return data?.value ?? [];
}

export async function saveVouchers(vouchers) {
  await supabase.from('settings').upsert({ key: 'vouchers', value: vouchers }, { onConflict: 'key' });
}

export async function createVoucher(voucher) {
  const list = await loadVouchers();
  const updated = [voucher, ...list];
  await saveVouchers(updated);
  return updated;
}

export async function markVoucherUsed(code) {
  const list = await loadVouchers();
  const updated = list.map(v => v.code === code ? { ...v, used: true } : v);
  await saveVouchers(updated);
  return updated;
}

export async function loadDeliveryAddress(userId) {
  const local = loadDeliveryAddressLocal(userId);
  if (local) return local;
  const { data } = await supabase.from('profiles').select('delivery_address').eq('id', userId).single();
  if (data?.delivery_address) {
    localStorage.setItem(`bitetime_addr_${userId}`, JSON.stringify(data.delivery_address));
    return data.delivery_address;
  }
  return null;
}
