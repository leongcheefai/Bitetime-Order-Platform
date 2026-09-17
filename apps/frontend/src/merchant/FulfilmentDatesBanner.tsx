import { useSession } from '../SessionContext'
import { fulfilmentConfig, fulfilmentWarning, DEFAULT_TIMEZONE } from '@bitetime/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The merchant-facing half of the pause (#210, ADR 0015).
 *
 * A rolling window cannot run dry, so this renders nothing for most shops. A shop on specific
 * dates can, and silence there is exactly the failure the feature was asked for in: the merchant
 * who ticked three dates in August must hear about it in July, not from a customer in September.
 *
 * Deliberately not dismissible, for the same reason `BillingBanner` is not — a shop that has
 * stopped taking orders is not a thing its owner should be able to hide from themselves.
 *
 * Everything here is derived from the merchant row already in session: no fetch, no scheduled
 * job, no send path. The cost of the warning is one pure function call per render.
 */
export default function FulfilmentDatesBanner({ onGoToFulfilment }: { onGoToFulfilment: () => void }) {
  const { t, lang, merchant } = useSession()
  if (!merchant) return null

  const cfg = fulfilmentConfig(merchant.config)
  const state = fulfilmentWarning(cfg, merchant.timezone ?? DEFAULT_TIMEZONE, new Date())
  if (state.kind === 'none') return null

  // Red for a shop that is already dark, amber for one that is about to be. The distinction is
  // the whole point of warning early rather than only reporting the outage.
  const urgent = state.kind === 'empty' || state.kind === 'review' || state.kind === 'no_slots'

  // Rendered in UTC because the date string IS a calendar date, not an instant — reading it in
  // the browser's zone is how "20 Aug" becomes "19 Aug" for a merchant travelling west.
  const lastLabel = state.kind === 'ending'
    ? new Date(`${state.last}T00:00:00Z`).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-GB',
        { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
    : ''

  const message =
    state.kind === 'review'
      ? t('Your shop is paused. Confirm your order dates to start taking orders again.',
           '店铺已暂停接单。请确认可选日期后重新开放。')
      : state.kind === 'no_slots'
        ? t('Your shop is not taking orders — time slots are on, but no open day holds a slot. Check your opening hours.',
             '店铺目前无法接单：已开启时段，但没有任何营业日能容纳一个时段。请检查营业时间。')
      : state.kind === 'empty'
        ? t('Your shop is not taking orders — every date you picked has passed. Add more dates.',
             '店铺目前无法接单：所选日期均已过期，请添加新的日期。')
        : t(`Your last order date is ${lastLabel}. Add more before customers run out of days to pick.`,
             `最后一个可选日期为 ${lastLabel}。请及时添加更多日期，以免顾客无日期可选。`)

  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-3 flex-wrap px-4 py-3 mb-5 rounded-md border-[0.5px] text-[13px] leading-[1.5]',
        urgent ? 'bg-danger-100 text-danger-fg border-danger-fg/25' : 'bg-warning-100 text-warning-fg border-warning-fg/25',
      )}
    >
      <span className="flex-1 min-w-[200px] font-medium">{message}</span>
      <Button type="button" size="sm" onClick={onGoToFulfilment} className="shrink-0">
        {t('Order dates', '可选日期')}
      </Button>
    </div>
  )
}
