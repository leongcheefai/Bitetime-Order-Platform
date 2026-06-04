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
  return data.user;
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getCurrentUser() {
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}

export function onAuthChange(callback) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
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
  if (error) console.error('Failed to save order to Supabase:', error.message);
}
