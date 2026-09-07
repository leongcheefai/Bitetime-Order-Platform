import { useState } from 'react'
import { enGB, zhCN } from 'react-day-picker/locale'
// `ui/calendar`, never a native `<input type="date">`.
//
// The native control paints the BROWSER's picker — Chrome's blue accent, its own type, a
// `dd/mm/yyyy` placeholder — beside the dashboard's other date pickers, which render through the
// app's own tokens. See the note at the top of CustomDatesCalendar.tsx: both of those were moved
// onto this one component precisely because the library's styling leaked between them, and a
// native input is the same failure from the other direction.
//
// This file exists so there is ONE of these rather than one per form. It was two before it was
// one, for about an hour.
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { todayInZone, DEFAULT_TIMEZONE } from '@bitetime/shared'
import { cn } from '@/lib/utils'
// The `YYYY-MM-DD` <-> local-midnight bridge, tested as a pair of exact inverses. The only place
// in the app allowed to build a `Date` for a calendar date — see calendarDate.ts for why local
// and not UTC, and why mixing the two conventions puts a date on the wrong day.
import { toDate, toIso } from './calendarDate'

interface Props {
  /** `YYYY-MM-DD`, or '' for none. */
  value: string
  onChange: (iso: string) => void
  /** The shop's timezone. Decides which day is "today", and so which days are past. */
  tz?: string | null
  /**
   * Which further days render DISABLED, by their `YYYY-MM-DD`, on top of the past. The order
   * drawer passes the shop's own Fulfilment settings through it, so the picker offers exactly
   * the days the save would accept.
   */
  isDisabled?: (iso: string) => boolean
  t: (en: string, zh: string) => string
  lang: 'en' | 'zh'
  /** What the trigger says with no date set. */
  placeholder?: string
  /** Offer a Clear action. Off where an enclosing checkbox already clears the field. */
  clearable?: boolean
  id?: string
}

/**
 * A single calendar date, as a themed picker.
 *
 * The value is a `YYYY-MM-DD` STRING and stays one — this component never produces an instant.
 * Which moment a merchant's chosen day begins or ends depends on the shop's timezone and on what
 * the field means, and both of those are the caller's business, not a date picker's.
 *
 * Days before the SHOP's today render DISABLED rather than hidden — the choice
 * `CustomDatesCalendar` and `FulfilDatePicker` both make, because a merchant who cannot find a
 * day assumes the calendar is broken. It is the shop's today and not the browser's, so a merchant
 * abroad sees the same floor their shop would.
 */
export default function DateField({ value, onChange, tz, isDisabled, t, lang, placeholder, clearable, id }: Props) {
  const [open, setOpen] = useState(false)
  const today = toDate(todayInZone(tz ?? DEFAULT_TIMEZONE, new Date()))
  // A stored date in the PAST still renders — an existing promo whose end has gone by must show
  // the merchant what it says, not an empty field. Only picking a past day is refused.
  const selected = value ? toDate(value) : undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            id={id}
            type="button"
            className={cn(
              'w-full rounded-sm border-[0.5px] border-border bg-background px-3 py-2 text-left text-[13px] transition-colors hover:border-primary',
              !value && 'text-muted-foreground',
            )}
          />
        }
      >
        {selected
          ? selected.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
          : (placeholder ?? t('Pick a date', '选择日期'))}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <Calendar
          mode="single"
          className="p-0"
          locale={lang === 'zh' ? zhCN : enGB}
          selected={selected}
          onSelect={d => { if (d) { onChange(toIso(d)); setOpen(false) } }}
          // `selected ?? today`, so reopening a set field lands on the month it is in rather than
          // on this one — otherwise editing next year's date starts with a year of scrolling.
          defaultMonth={selected ?? today}
          disabled={isDisabled ? [{ before: today }, (d: Date) => isDisabled(toIso(d))] : { before: today }}
          // A month and year dropdown, not twelve presses of an arrow: the dates these fields
          // hold are months out, and three years is past anything a shop would set.
          captionLayout="dropdown"
          startMonth={today}
          endMonth={new Date(today.getFullYear() + 3, 11, 31)}
        />
        {clearable && value && (
          <button
            type="button"
            className="mt-1 w-full rounded-lg px-2 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-primary"
            onClick={() => { onChange(''); setOpen(false) }}
          >
            {t('Clear date', '清除日期')}
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
