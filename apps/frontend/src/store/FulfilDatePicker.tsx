import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface Props {
  /** Every date the shop is taking, `YYYY-MM-DD`, ascending. */
  available: string[]
  value: string | null
  onChange: (date: string) => void
  t: (en: string, zh: string) => string
  lang: 'en' | 'zh'
}

const DAY = 86_400_000
const ms = (date: string) => Date.parse(`${date}T00:00:00Z`)
const iso = (n: number) => new Date(n).toISOString().slice(0, 10)

/**
 * A month grid of the dates this shop is taking.
 *
 * Unavailable days render DISABLED rather than hidden. A customer who cannot find Monday
 * assumes the picker is broken; a customer who sees Monday greyed out learns the shop is shut
 * that day, which is the fact the merchant configured. Everything the grid shows is derived
 * from `available` — this component holds no rule of its own, so it cannot disagree with the
 * one the backend enforces.
 */
export default function FulfilDatePicker({ available, value, onChange, t, lang }: Props) {
  const open = useMemo(() => new Set(available), [available])
  const first = available[0] ?? null
  const last = available[available.length - 1] ?? null

  // Which month the grid is showing. Starts on the month holding the first available date, so
  // a shop with a week of lead time opens on the month the customer can actually order in.
  const [cursor, setCursor] = useState(() => {
    const d = new Date(first ? ms(first) : Date.now())
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() }
  })

  const monthLabel = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(cursor.year, cursor.month, 1)))

  const weekdayLabels = [
    t('Su', '日'), t('Mo', '一'), t('Tu', '二'), t('We', '三'),
    t('Th', '四'), t('Fr', '五'), t('Sa', '六'),
  ]

  const monthStart = Date.UTC(cursor.year, cursor.month, 1)
  const daysInMonth = new Date(Date.UTC(cursor.year, cursor.month + 1, 0)).getUTCDate()
  const leading = new Date(monthStart).getUTCDay() // blank cells before the 1st

  // Bounded by the window: there is nothing to see outside it, and a customer paging through
  // empty months is a customer who thinks the shop has no dates at all.
  const canPrev = first !== null && monthStart > ms(first)
  const canNext = last !== null && Date.UTC(cursor.year, cursor.month + 1, 1) <= ms(last)

  const step = (delta: number) => setCursor(c => {
    const d = new Date(Date.UTC(c.year, c.month + delta, 1))
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() }
  })

  if (available.length === 0) {
    return (
      <div className="text-[14px] text-muted-foreground leading-[1.5]">
        {t('This shop is not taking orders for any date right now. Please check back later.',
           '本店目前暂不接受任何日期的订单，请稍后再试。')}
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <Button
          type="button" variant="outline" size="icon" onClick={() => step(-1)} disabled={!canPrev}
          aria-label={t('Previous month', '上个月')}
          className="bg-card text-foreground disabled:cursor-not-allowed hover:enabled:border-primary"
        >‹</Button>
        <div aria-live="polite" className="text-[14px] font-medium text-primary">{monthLabel}</div>
        <Button
          type="button" variant="outline" size="icon" onClick={() => step(1)} disabled={!canNext}
          aria-label={t('Next month', '下个月')}
          className="bg-card text-foreground disabled:cursor-not-allowed hover:enabled:border-primary"
        >›</Button>
      </div>

      {/* A GROUP of toggle buttons, not an ARIA grid: `role="grid"` owes a row/gridcell tree
          and arrow-key navigation, and a flat run of `aria-pressed` buttons inside it is what
          axe reports as a critical "required children" failure. The day buttons are already
          complete controls on their own; the group only gives the set a name. */}
      <div className="grid grid-cols-7 gap-1" role="group" aria-label={t('Choose a date', '选择日期')}>
        {weekdayLabels.map((w, i) => (
          <div key={i} className="text-[11px] text-muted-foreground text-center py-1" aria-hidden="true">{w}</div>
        ))}
        {Array.from({ length: leading }, (_, i) => <div key={`pad-${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const date = iso(monthStart + i * DAY)
          const selectable = open.has(date)
          const selected = value === date
          return (
            <button
              key={date}
              type="button"
              disabled={!selectable}
              aria-pressed={selected}
              aria-label={date}
              onClick={() => onChange(date)}
              className={cn(
                'h-10 pointer-coarse:min-h-11 rounded-md text-[14px] font-sans transition-all border',
                'focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2',
                selected
                  ? 'border-[0.5px] border-primary bg-brand-100 text-primary font-medium'
                  : selectable
                    ? 'border-border bg-card text-foreground hover:border-primary cursor-pointer'
                    // Greyed, not gone: the customer must be able to SEE that the shop is shut
                    // on this day rather than wonder where it went.
                    : 'border-transparent bg-transparent text-foreground/25 cursor-not-allowed',
              )}
            >
              {i + 1}
            </button>
          )
        })}
      </div>
    </div>
  )
}
