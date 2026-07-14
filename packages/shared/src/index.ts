// Rules that must hold identically in the frontend and the backend. Source-only: both
// workspaces compile TypeScript themselves (Vite/esbuild/Vitest), so there is no build
// step and no dist — the consumers bundle this source directly.
export { MIN_PASSWORD_LENGTH, isPasswordLongEnough } from './password.js'
export { MAX_CART_QTY, MAX_CART_LINES, isCart } from './cart.js'
export {
  priceOrder, voucherError, shippingFee, voucherFromRow, shopRates,
  promoState, promoClaims, productFromRow,
  EM_STATES, DEFAULT_WM_RATE,
} from './pricing.js'
export type {
  PriceInput, PriceBreakdown, PriceLine,
  VoucherCtx, VoucherErrorCode,
  PricedProduct, PricedVoucher, PromoState,
} from './pricing.js'
