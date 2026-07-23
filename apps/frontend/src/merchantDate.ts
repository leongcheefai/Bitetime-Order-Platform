// Merchant-dashboard date formatters — fixed to `en-MY`, NOT language-aware.
//
// Deliberately separate from `orderDate.ts`, whose helpers follow the customer's
// `lang` because they render on customer-facing screens (order history, /track).
// The dashboard is the merchant's own back-office and reads one way regardless of
// the storefront language toggle, so these pin the locale.

// An instant to the minute — the orders table and the order-detail header.
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-MY', { dateStyle: 'short', timeStyle: 'short' })
}

// A day, no time — the customers table and the order-history lines.
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-MY', { dateStyle: 'medium' })
}
