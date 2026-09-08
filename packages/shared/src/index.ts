// Rules that must hold identically in the frontend and the backend. Source-only: both
// workspaces compile TypeScript themselves (Vite/esbuild/Vitest), so there is no build
// step and no dist — the consumers bundle this source directly.
export { MIN_PASSWORD_LENGTH, isPasswordLongEnough } from './password.js'
export { BUSINESS_NATURES, isBusinessNature } from './businessNature.js'
export type { BusinessNature } from './businessNature.js'
export { CURRENCY_CODES, DEFAULT_CURRENCY, isCurrencyCode } from './currency.js'
export type { CurrencyCode } from './currency.js'
export { MAX_CART_QTY, MAX_CART_LINES, MAX_CART_ENTRIES, isCart } from './cart.js'
export {
  validateFeedback, isFeedbackCategory, isFeedbackStatus,
  validateFeedbackImage, validateFeedbackImages,
  FEEDBACK_CATEGORIES, FEEDBACK_STATUSES, FEEDBACK_MAX_LENGTH,
  FEEDBACK_MAX_IMAGES, MAX_FEEDBACK_IMAGE_BYTES, FEEDBACK_IMAGE_TYPES,
} from './feedback.js'
export type {
  FeedbackCategory, FeedbackStatus, FeedbackDraft, FeedbackValidation,
  FeedbackImageValidation, FeedbackImagesValidation, FeedbackImageError,
} from './feedback.js'
export {
  validateTrialFeedback,
  TRIAL_FEEDBACK_RATING_MIN, TRIAL_FEEDBACK_RATING_MAX, TRIAL_FEEDBACK_COMMENT_MAX_LENGTH,
} from './trialFeedback.js'
export type { TrialFeedbackDraft, TrialFeedbackValidation } from './trialFeedback.js'
export {
  validateOrderReview,
  ORDER_REVIEW_RATING_MIN, ORDER_REVIEW_RATING_MAX, ORDER_REVIEW_COMMENT_MAX_LENGTH,
} from './orderReview.js'
export type { OrderReviewDraft, OrderReviewValidation } from './orderReview.js'
export {
  priceOrder, voucherError, voucherExpired, voucherBelowMinimum, voucherApplies,
  shippingFee, voucherFromRow, shopRates, shopTax,
  promoState, promoClaims, productFromRow, optionGroupsFromRow,
  shopDistance, routedKm, distanceFee, exceedsMaxKm,
  shopMethods, offersMethod, firstOfferedMethod, FULFILMENT_METHODS, isDistancePriced,
  EM_STATES, DEFAULT_WM_RATE,
} from './pricing.js'
export type {
  PriceInput, PriceBreakdown, PriceLine,
  VoucherCtx, VoucherErrorCode,
  PricedProduct, PricedVoucher, PromoState, ShopTax, ShopDistance,
  ShopMethods, FulfilmentMethod,
} from './pricing.js'
export {
  fulfilmentConfig, isTimezone, todayInZone,
  isDateSelectable, selectableDates,
  customDateBounds, pruneCustomDates, validateCustomDates,
  fulfilmentWarning,
  DEFAULT_FULFILMENT, DEFAULT_TIMEZONE,
  FULFILMENT_HORIZON_DAYS, MAX_CUSTOM_DATES, DATES_ENDING_SOON_DAYS,
} from './fulfilment.js'
export type { FulfilmentConfig, FulfilmentMode, CustomDatesError, FulfilmentWarning } from './fulfilment.js'
export { REFUSAL_STATUS, ORDER_REFUSALS, QUOTE_REFUSAL_STATUS, QUOTE_REFUSALS } from './refusal.js'
export type { OrderRefusal, QuoteRefusal } from './refusal.js'
export {
  computeMerchantStats, granularityFor, ordersInWindow, windowTotals, isBooked,
  REVENUE_RANGES, isRevenueRange, parseCustomRange, MAX_CUSTOM_SPAN_DAYS,
} from './merchantStats.js'
export type {
  MerchantStats, SeriesPoint, SeriesWindow, Slice, StatusSlice, Delta, Granularity,
  StatsOrder, StatsOrderItem, StatsVoucher, WindowTotals, RevenueRange,
  CustomRangeError, CustomRangeResult,
} from './merchantStats.js'
export {
  canonicalJson, cartLineKey, validateSelections, validateOptionGroups,
  snapshotSelections, picksDelta,
  canBeAnswered,
  MAX_PICK_QTY, MAX_GROUPS_PER_PRODUCT, MAX_OPTIONS_PER_GROUP,
} from './options.js'
export type {
  Option, OptionGroup, Selection, CartLine, PickSnapshot,
  SelectionError, GroupConfigError,
} from './options.js'
export {
  validateMenuCategories, menuCategoriesFromRow, categoryMatchKey,
  MAX_MENU_CATEGORIES, MENU_CATEGORY_NAME_MAX,
} from './menuCategories.js'
export type { MenuCategory, CategoryConfigError } from './menuCategories.js'
export { INVOICE_STATUSES, canIssueInvoice } from './invoice.js'
export { validateShopDescription, SHOP_DESCRIPTION_MAX } from './shopDescription.js'
export type { ShopDescriptionError } from './shopDescription.js'
export { normalizeBrandColor, PLATFORM_BRAND_COLOR } from './brandColor.js'
export {
  PAST_DUE_GRACE_DAYS, pastDueDeadline, pastDueGraceExpired, pastDueDaysLeft,
} from './dunning.js'
export { pendingShopMetadata, pendingShopFromMetadata, pendingShopFromBody } from './pendingShop.js'
export type { PendingShop } from './pendingShop.js'
export type { BrandColorError, BrandColorResult } from './brandColor.js'
export { canShareReferral } from './referralSharing.js'
export type { ReferralBillingSnapshot } from './referralSharing.js'
export { ORDER_EVENT_KINDS } from './orderEvents.js'
export type { OrderEventKind, OrderActorKind, OrderEvent } from './orderEvents.js'
