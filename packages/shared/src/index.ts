// Rules that must hold identically in the frontend and the backend. Source-only: both
// workspaces compile TypeScript themselves (Vite/esbuild/Vitest), so there is no build
// step and no dist — the consumers bundle this source directly.
export { MIN_PASSWORD_LENGTH, isPasswordLongEnough } from './password.js'
export { MAX_CART_QTY, MAX_CART_LINES, isCart } from './cart.js'
export {
  validateFeedback, isFeedbackCategory, isFeedbackStatus,
  FEEDBACK_CATEGORIES, FEEDBACK_STATUSES, FEEDBACK_MAX_LENGTH,
} from './feedback.js'
export type {
  FeedbackCategory, FeedbackStatus, FeedbackDraft, FeedbackValidation,
} from './feedback.js'
export {
  priceOrder, voucherError, shippingFee, voucherFromRow, shopRates, shopTax,
  promoState, promoClaims, productFromRow,
  EM_STATES, DEFAULT_WM_RATE,
} from './pricing.js'
export type {
  PriceInput, PriceBreakdown, PriceLine,
  VoucherCtx, VoucherErrorCode,
  PricedProduct, PricedVoucher, PromoState, ShopTax,
} from './pricing.js'
export {
  fulfilmentConfig, isTimezone, todayInZone,
  isDateSelectable, selectableDates,
  DEFAULT_FULFILMENT, DEFAULT_TIMEZONE,
} from './fulfilment.js'
export type { FulfilmentConfig } from './fulfilment.js'
