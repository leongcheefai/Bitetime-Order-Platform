import { ReceiptText, Clock, Package, Truck, CircleCheck, Ban } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Translate } from '../types'

// The four states an order actually moves through (`cancelled` is off this path — handled below).
// Mirrors ORDER_STATUSES minus the terminal cancel, so the tracker and the badge never disagree.
const FLOW = ['new', 'preparing', 'ready', 'completed'] as const

type Step = { icon: LucideIcon; label: (t: Translate, delivery: boolean) => string }

const STEPS: Step[] = [
  { icon: ReceiptText, label: t => t('Placed', '已下单') },
  { icon: Clock, label: t => t('Preparing', '备料中') },
  { icon: Package, label: t => t('Ready', '已备好') },
  {
    // The last node speaks the fulfilment mode's language: a delivery is "Delivered", a pickup
    // "Picked up" — same status, two truthful words.
    icon: CircleCheck,
    label: (t, delivery) => (delivery ? t('Delivered', '已送达') : t('Picked up', '已取货')),
  },
]

/**
 * Horizontal four-step progress tracker for a single order — the "where is it now" the expanded
 * row exists to answer, lifted out of the status badge into something a customer reads at a glance.
 *
 * Timestamps are deliberately absent: orders store only `created_at`, not per-transition times, so a
 * fabricated "11:00 AM" under each node would be a lie. Node + label + the highlighted current step
 * is the honest surface the data supports.
 */
export default function OrderTimeline({
  status,
  mode,
  t,
}: {
  status: string
  mode?: string
  t: Translate
}) {
  const delivery = mode === 'delivery'

  // A cancelled order never rejoins the flow — a greyed-out four-step line would imply it might.
  if (status === 'cancelled') {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-danger-border bg-rose-pale px-3 py-2.5 mt-3">
        <Ban className="size-4 shrink-0 text-danger" strokeWidth={1.75} />
        <span className="text-[13px] font-medium text-danger">{t('Order cancelled', '订单已取消')}</span>
      </div>
    )
  }

  // Anything unrecognised (a status added later, a legacy row) reads as freshly placed rather than
  // vanishing the tracker.
  const currentIdx = Math.max(0, FLOW.indexOf(status as (typeof FLOW)[number]))
  const lastDelivered = STEPS.length - 1

  return (
    <ol className="flex items-start mt-3" aria-label={t('Order progress', '订单进度')}>
      {STEPS.map((step, i) => {
        const current = i === currentIdx
        const reached = i <= currentIdx
        const Icon = i === lastDelivered && delivery ? Truck : step.icon
        return (
          <li key={i} className="relative flex flex-1 flex-col items-center gap-1.5">
            {/* Connector to the previous node. Sits behind the icons at their vertical centre
                (icon is size-7 → 14px half). Solid oxblood once the segment is behind us, dashed
                clay while it's still ahead — the dashed tail is the "not there yet" of the mock. */}
            {i > 0 && (
              <span
                aria-hidden
                className={cn(
                  'absolute right-1/2 top-[13px] h-0.5 w-full',
                  reached ? 'bg-oxblood' : 'border-t-2 border-dashed border-clay-border',
                )}
              />
            )}
            <span
              className={cn(
                'relative z-[1] flex size-7 items-center justify-center rounded-full transition-colors',
                reached
                  ? 'bg-oxblood text-cream'
                  : 'border-[1.5px] border-clay-border bg-surface-raised text-clay-muted',
                // The live step gets a soft halo so the eye lands on it first.
                current && 'ring-4 ring-oxblood/15',
              )}
            >
              <Icon className="size-[15px]" strokeWidth={2} />
            </span>
            <span
              className={cn(
                'text-center text-[11px] leading-tight',
                reached ? 'font-medium text-oxblood' : 'text-rose-muted',
              )}
            >
              {step.label(t, delivery)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
