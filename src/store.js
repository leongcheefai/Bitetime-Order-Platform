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

export function loadSettings() {
  try {
    const saved = localStorage.getItem('bitetime_settings');
    return saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(DEFAULTS));
  } catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
}

export function saveSettingsToStorage(settings) {
  localStorage.setItem('bitetime_settings', JSON.stringify(settings));
}

export function getUsers() {
  try { return JSON.parse(localStorage.getItem('bitetime_users') || '[]'); } catch { return []; }
}

export function saveUsers(users) {
  localStorage.setItem('bitetime_users', JSON.stringify(users));
}

export function getSession() { return localStorage.getItem('bitetime_session'); }
export function setSession(email) { localStorage.setItem('bitetime_session', email); }
export function clearSession() { localStorage.removeItem('bitetime_session'); }
