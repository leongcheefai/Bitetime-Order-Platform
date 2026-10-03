import type { HitpayStatus } from './store'

/** How often the open QR asks whether it was paid. The webhook covers a hidden tab. */
export const POLL_MS = 3000

export function secondsLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
}

export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** The dynamic QR replaces the static instructions only for a connected shop's unpaid order. */
export function paysWithHitpay(merchant: { hitpay_connected?: boolean | null }, status: string | null | undefined): boolean {
  return merchant.hitpay_connected === true && status === 'pending_payment'
}

const PAID_ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed']

/**
 * Paid when the order moved past `pending_payment` to a live status — by this payment, or by the
 * merchant's own hand, and a QR still asking for money then is wrong. NOT when it was cancelled:
 * a cancelled order is never "Payment received", even if money arrived (the shop refunds it).
 */
export function isPaid(s: HitpayStatus): boolean {
  return PAID_ORDER_STATUSES.includes(s.orderStatus)
}

export function isCancelled(s: HitpayStatus): boolean {
  return s.orderStatus === 'cancelled'
}
