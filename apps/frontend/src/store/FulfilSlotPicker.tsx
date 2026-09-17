import { cn } from '@/lib/utils'
import type { Slot } from '@bitetime/shared'
import { formatSlotRange } from '../orderDate'

interface Props {
  /** Every slot the shop offers on the chosen date, in order. */
  slots: Slot[]
  value: Slot | null
  onChange: (slot: Slot) => void
  t: (en: string, zh: string) => string
}

const same = (a: Slot | null, b: Slot) => a !== null && a.from === b.from && a.to === b.to

/**
 * The time slots of one date, as toggle buttons (#282).
 *
 * Closed slots are HIDDEN, not greyed — the opposite of the date grid, on purpose. A greyed
 * Monday teaches the customer the shop is shut that day; a grey run of 08:00, 08:30, 09:00
 * before opening time teaches nothing and pushes the open slots off a phone screen. Everything
 * shown is derived from `slots`, so this component holds no rule of its own and cannot
 * disagree with the one the backend enforces.
 */
export default function FulfilSlotPicker({ slots, value, onChange, t }: Props) {
  if (slots.length === 0) {
    return (
      <div className="text-[14px] text-muted-foreground leading-[1.5]">
        {t('No time slots are left for this date. Please pick another date.',
           '该日期已无可选时段，请选择其他日期。')}
      </div>
    )
  }
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('Choose a time slot', '选择时段')}>
      {slots.map(s => {
        const selected = same(value, s)
        return (
          <button
            key={s.from}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(s)}
            className={cn(
              'h-10 pointer-coarse:min-h-11 px-3 rounded-md text-[14px] font-sans tabular-nums transition-all border',
              'focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2',
              selected
                ? 'border-[0.5px] border-primary bg-brand-wash text-primary font-medium'
                : 'border-border bg-card text-foreground hover:border-primary cursor-pointer',
            )}
          >
            {formatSlotRange(s.from, s.to)}
          </button>
        )
      })}
    </div>
  )
}
