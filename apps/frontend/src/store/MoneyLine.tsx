import type { ReactNode } from 'react'

/**
 * One money row: label left, value right. The order-history row and the printed receipt both
 * state the same facts (a line item, a delivery fee, a voucher), and they must state them in
 * the same shape — a receipt whose fee row is laid out unlike the screen's reads as a different
 * document about a different order.
 */
export default function MoneyLine({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
      {/* The label shrinks and wraps, the money never does. shrink-0 on the label let a long
          product name push the value past the container's right edge (#92). */}
      <span className="min-w-0">{label}</span>
      <span className="shrink-0 text-right whitespace-nowrap">{value}</span>
    </div>
  )
}
