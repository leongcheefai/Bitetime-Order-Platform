# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # start Vite dev server (localhost:5173)
npm run build      # production build → dist/
npm run lint       # ESLint check
npm run preview    # serve dist/ locally
npm run deploy     # build with GITHUB_PAGES=true and push to gh-pages branch
```

No test suite exists in this project.

## Architecture

Single-page React app (Vite + React 19, no router). All state lives in `App.jsx`; there is no global state library.

### Auth & roles

- Supabase Auth handles login/registration (`src/supabase.js`, `src/store.js`)
- `OWNER_EMAIL = 'bitetimeandco@gmail.com'` in `App.jsx` gates the owner layout — only that email gets the admin sidebar
- Regular users see the customer order form + side drawer

### Two layouts rendered from App.jsx

1. **Owner layout** — sidebar (`OWNER_NAV`) with pages: Home (order form), Orders, Menu & Settings, Users, Vouchers, Customer View (preview)
2. **Customer layout** — single page with a hamburger side drawer for Personal Details / Vouchers / Order History

`ownerPage` state drives which panel renders in the owner layout. `accountSection` state drives which sub-section of `CustomerSettings` is shown in both layouts.

### Data layer (`src/store.js`)

All Supabase calls go through `store.js`. Key Supabase tables:

| Table | Purpose |
|-------|---------|
| `profiles` | User profile + saved delivery address |
| `orders` | All customer orders |
| `settings` | Key-value store — `main` (product/shipping config), `order_statuses` (map of order_number → status), `order_awb` (map of order_number → tracking number), `vouchers` (array) |

Settings are also cached in `localStorage` (`bitetime_settings`, `bitetime_addr_<userId>`). On load, `App.jsx` fetches from DB and overwrites the local cache.

### Order flow

`OrderForm` → collects items, delivery mode, date, voucher → calls `saveOrder()` → sends Telegram notification (via `settings.tgToken`/`tgChatId`) and optionally EmailJS → calls `onSuccess(orderNumber)` in parent.

Order numbers are generated as `BT-YYYYMMDD-XXXX` (random 4-char suffix) inside `OrderForm`.

### Shipping / postcodes

`src/postcodes.js` maps Malaysian postcodes → city. Shipping rates come from `settings.shipping`: `WM` (West Malaysia, RM 8) and `EM` (East Malaysia, RM 18). `lookupPostcode(code)` returns `{ city, state }` or `null`.

### Localisation

No i18n library. Every string is passed as `t(englishString, chineseString)` where `t = (en, zh) => lang === 'zh' ? zh : en`. The `lang` state (`'en'` | `'zh'`) lives in `App.jsx` and is passed as a prop.

### Deployment

`npm run deploy` sets `GITHUB_PAGES=true`, which changes the Vite `base` from `/` to `/Bitetime-Order-Platform/`, then pushes `dist/` to the `gh-pages` branch.
