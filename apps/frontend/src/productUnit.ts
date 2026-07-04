// Shared, pure helpers for a product's unit quantity (display-only feature).
// The frontend stores the value as the raw DB column `unit_quantity` (numeric).

// Coerce a form/DB value to a valid positive quantity; fall back to 1 so a
// product never displays or persists 0, a negative, or NaN.
export function coerceQuantity(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 1
}

// Display: "<quantity> <unit>", always a single space. Legacy rows without a
// quantity render as "1 <unit>". `unit` is the raw string the caller resolves;
// display does not localize the unit today.
export function formatUnit(quantity: unknown, unit: string): string {
  return `${coerceQuantity(quantity)} ${unit}`
}
