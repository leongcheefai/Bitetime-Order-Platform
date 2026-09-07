import type { Translate } from '../types'
import { STATUS_BADGE, STATUS_LABELS } from '../orderStatus'
import { statusChips } from './orderStatusChips'

/**
 * The order list's status tallies, which are also its status filter.
 *
 * One control rather than two: a merchant who can see that four orders are Preparing wants to
 * read those four, and a separate dropdown next to the same four figures would ask them to say
 * it twice.
 *
 * The colour is carried by the SELECTED chip only. An unselected chip is a neutral outline, so
 * the row reads as a tally rather than as six competing badges — and, less cosmetically, the
 * badge palette is contrast-checked as a filled pill (tokens.test.ts) and a dimmed copy of one
 * is a pair nothing has proved.
 */
export default function OrderStatusFilter({
  counts, selected, onSelect, t,
}: {
  counts: Record<string, number> | null
  selected: string
  onSelect: (status: string) => void
  t: Translate
}) {
  const chips = statusChips(counts, selected)

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5" role="group"
         aria-label={t('Filter orders by status', '按状态筛选订单')}>
      {chips.map(chip => {
        const on = chip.status === selected
        const label = chip.status
          ? t(STATUS_LABELS[chip.status]?.en ?? chip.status, STATUS_LABELS[chip.status]?.zh ?? chip.status)
          : t('All', '全部')
        const tone = on
          ? (chip.status ? STATUS_BADGE[chip.status]?.className : 'bg-primary text-primary-foreground border-transparent')
          : 'bg-card text-muted-foreground border-border hover:border-primary hover:text-primary'
        return (
          <button
            key={chip.status || 'all'}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(on && chip.status ? '' : chip.status)}
            className={`inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-[3px] pointer-coarse:min-h-9 pointer-coarse:px-3 text-[12px] font-medium
                        cursor-pointer transition-colors ${tone}`}
          >
            <span>{label}</span>
            <span className="tabular-nums opacity-80">{chip.count}</span>
          </button>
        )
      })}
    </div>
  )
}
