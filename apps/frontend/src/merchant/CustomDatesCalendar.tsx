import { useMemo } from 'react'
import { enGB, zhCN } from 'react-day-picker/locale'
// `ui/calendar`, not `DayPicker` directly, and NOT `react-day-picker/style.css`.
//
// This used to import that stylesheet — 11KB of library CSS, themed by 40 lines of `.rdp-*`
// overrides in `index.css` to look like the rest of the app. A CSS import is global whatever
// component asks for it, so the moment a SECOND day picker appeared (the revenue range, #234) it
// inherited the library's own blue accent and bold selected days, and no amount of scoping on
// this side could stop it: the leak came from the stylesheet, not from the wrapper.
//
// So both pickers now go through the one shadcn component, which styles itself with the app's
// own tokens and needs no library CSS at all. The 11KB and the overrides are gone with it.
import { Calendar } from '@/components/ui/calendar'
// The `YYYY-MM-DD` ↔ local-midnight `Date` bridge, extracted so it can be tested as a pair of
// exact inverses — see calendarDate.ts for why local and not UTC.
import { toDate, toIso } from './calendarDate'

interface Props {
  /** The ticked dates, `YYYY-MM-DD`, sorted. */
  value: string[]
  onChange: (dates: string[]) => void
  /** The horizon's bounds, `YYYY-MM-DD`, from `customDateBounds`. */
  first: string
  last: string
  t: (en: string, zh: string) => string
  lang: 'en' | 'zh'
}

export default function CustomDatesCalendar({ value, onChange, first, last, t, lang }: Props) {
  const selected = useMemo(() => value.map(toDate), [value])
  const start = toDate(first)
  const end = toDate(last)

  // Weekday included on purpose: a merchant picking festive dates is deciding around which day of
  // the week they fall, and reading that off the grid means finding the date again.
  const label = (iso: string) => toDate(iso).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-GB',
    { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <div className="flex gap-6 items-start max-md:flex-col max-md:gap-4">
      <div className="shrink-0">
        <Calendar
          mode="multiple"
          className="p-0"
          locale={lang === 'zh' ? zhCN : enGB}
          selected={selected}
          onSelect={days => onChange((days ?? []).map(toIso).sort())}
          startMonth={start}
          endMonth={end}
          defaultMonth={selected[0] ?? start}
          // Past days and anything past the horizon render DISABLED rather than hidden, the same
          // choice `FulfilDatePicker` makes on the customer's side: a merchant who cannot find next
          // Monday assumes the calendar is broken, and the horizon is only legible if you can see
          // where it falls.
          disabled={[{ before: start }, { after: end }]}
          aria-label={t('Order dates', '可选日期')}
        />
        <p className="text-[12px] text-muted-foreground mt-2 leading-[1.5]">
          {t(`Dates can be picked up to ${last}.`, `最远可选至 ${last}。`)}
        </p>
      </div>

      {/* The picked dates in full, beside the grid rather than under it.
          The grid shows ONE month, and an allowlist runs to 90 days — so a shop delivering in
          August and October can never see both at once there, and checking what it has committed
          to means paging back and forth. This list is the only view of the whole commitment, and
          it is where a date gets removed without hunting for its cell. */}
      <div className="flex-1 min-w-[200px] w-full">
        <h4 className="text-[12px] font-medium text-primary uppercase tracking-[0.08em] mb-2">
          {value.length > 0
            ? t(`Picked dates (${value.length})`, `已选日期（${value.length}）`)
            : t('Picked dates', '已选日期')}
        </h4>
        {value.length === 0 ? (
          <p className="text-[13px] text-muted-foreground leading-[1.5]">
            {t('Nothing picked yet. Tap the days you deliver on.', '尚未选择。请点选你的配送日期。')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1 max-h-[280px] overflow-y-auto pr-1 m-0 p-0 list-none">
            {value.map(iso => (
              <li
                key={iso}
                className="flex items-center gap-2 px-3 py-2 bg-background border-[0.5px] border-border rounded-md"
              >
                <span className="text-[14px] text-foreground flex-1 min-w-0 truncate">{label(iso)}</span>
                <button
                  type="button"
                  onClick={() => onChange(value.filter(d => d !== iso))}
                  aria-label={t(`Remove ${label(iso)}`, `移除 ${label(iso)}`)}
                  className={
                    'shrink-0 leading-none rounded-sm px-[6px] py-[2px] pointer-coarse:px-2.5 pointer-coarse:py-2 text-[15px] cursor-pointer ' +
                    'text-muted-foreground hover:text-primary ' +
                    'focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2'
                  }
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
