import { useState } from 'react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { updateMerchantConfig } from '../store'
import { useSaved } from './useSaved'
import CustomDatesCalendar from './CustomDatesCalendar'
import {
  fulfilmentConfig, customDateBounds, pruneCustomDates, validateCustomDates,
  DEFAULT_TIMEZONE, FULFILMENT_HORIZON_DAYS,
  SLOT_MINUTES, slotsBetween, validateSlotHours, minutesToTime,
  type FulfilmentMode, type CustomDatesError, type SlotHoursError, type SlotMinutes,
} from '@bitetime/shared'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger } from '../components/ui/select'
import { Switch } from '../components/ui/switch'

const CARD = 'bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border max-sm:p-4 max-sm:mb-6'
const HEADING = 'font-heading text-[15px] font-medium text-primary mb-4 flex items-center gap-2'

// Every zone the runtime knows, so a merchant anywhere can name their own clock. The one-entry
// fallback is for a runtime without `supportedValuesOf` — the default is the only shop clock
// this platform has ever had, so a merchant who cannot see the list is not stranded.
const TIMEZONES: string[] = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [DEFAULT_TIMEZONE]

const WEEKDAYS: { value: number; en: string; zh: string }[] = [
  { value: 0, en: 'Sun', zh: '周日' },
  { value: 1, en: 'Mon', zh: '周一' },
  { value: 2, en: 'Tue', zh: '周二' },
  { value: 3, en: 'Wed', zh: '周三' },
  { value: 4, en: 'Thu', zh: '周四' },
  { value: 5, en: 'Fri', zh: '周五' },
  { value: 6, en: 'Sat', zh: '周六' },
]

/**
 * One weekday's row of the hours editor (#282). `open`/`close` are kept for a CLOSED day too, so
 * ticking it back open restores what the merchant typed rather than a default.
 */
interface HoursRow { open: string; close: string; closed: boolean }

const DEFAULT_ROW: HoursRow = { open: '09:00', close: '18:00', closed: true }

const NOTICE_OPTIONS: { value: number; en: string; zh: string }[] = [
  { value: 0, en: 'No notice', zh: '无需提前' },
  { value: 30, en: '30 minutes', zh: '30 分钟' },
  { value: 60, en: '1 hour', zh: '1 小时' },
  { value: 90, en: '1.5 hours', zh: '1.5 小时' },
  { value: 120, en: '2 hours', zh: '2 小时' },
  { value: 180, en: '3 hours', zh: '3 小时' },
  { value: 240, en: '4 hours', zh: '4 小时' },
  { value: 1440, en: '1 day', zh: '1 天' },
]

/**
 * Every half hour of the day, `00:00` … `23:30`, for the opening-hours selects. A list rather than
 * a native `<input type="time">`: the merchant picks and never types, so a cleared field or a
 * `9:00` can never reach the row, and the AM/PM segments of the native control are gone. The
 * half-hour step matches the smallest slot length.
 */
const HALF_HOURS: string[] = Array.from({ length: 48 }, (_, i) => minutesToTime(i * 30))

function TimeSelect({ id, value, disabled, label, onChange }: {
  id: string; value: string; disabled: boolean; label: string; onChange: (v: string) => void
}) {
  return (
    <Select value={value} onValueChange={v => { if (v) onChange(v) }} disabled={disabled}>
      <SelectTrigger id={id} className="w-full" aria-label={label}>
        <span className="tabular-nums">{value}</span>
      </SelectTrigger>
      <SelectContent>
        {HALF_HOURS.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

const rowsFromHours = (hours: ({ open: string; close: string } | null)[]): HoursRow[] =>
  hours.map(h => (h ? { open: h.open, close: h.close, closed: false } : { ...DEFAULT_ROW }))

interface TabProps { onDirtyChange: (dirty: boolean) => void }

export default function FulfilmentTab({ onDirtyChange }: TabProps) {
  const { t, lang, merchant, refreshMerchant } = useSession()

  // fulfilmentConfig, not a local `?? 0` / `?? 14`: this form shows the merchant what a shop
  // with no saved config ACTUALLY OFFERS, and that is decided by one function on both sides of
  // the wire. A second set of fallbacks here would show a window the storefront never renders.
  const initial = () => {
    const cfg = fulfilmentConfig(merchant!.config)
    return {
      mode: cfg.mode as FulfilmentMode,
      lead: String(cfg.lead_days),
      window: String(cfg.window_days),
      closed: cfg.closed_weekdays,
      dates: cfg.custom_dates,
      timezone: merchant!.timezone ?? DEFAULT_TIMEZONE,
      slotsEnabled: cfg.slots_enabled,
      hours: rowsFromHours(cfg.hours),
      slotMinutes: String(cfg.slot_minutes),
      notice: String(cfg.slot_notice_minutes),
    }
  }
  const [initialFields] = useState(initial)
  const [fields, setFields] = useState(initialFields)
  const [busy, setBusy] = useState(false)

  // The shop is PAUSED until this merchant confirms (ADR 0015). Read off the SAVED config, never
  // off form state: it must survive every re-render and clear only when a save actually lands.
  const needsReview = fulfilmentConfig(merchant!.config).needs_review

  // Same shared save-cycle hook as ShopSettings' tabs (#123), but with this tab's own `eq`:
  // the shape carries two arrays that the flat-map `isDirty` cannot hold.
  const { commit } = useSaved(
    initialFields,
    fields,
    (a, b) =>
      a.mode === b.mode &&
      a.lead === b.lead &&
      a.window === b.window &&
      a.timezone === b.timezone &&
      a.closed.join(',') === b.closed.join(',') &&
      a.dates.join(',') === b.dates.join(',') &&
      a.slotsEnabled === b.slotsEnabled &&
      a.slotMinutes === b.slotMinutes &&
      a.notice === b.notice &&
      a.hours.map(h => `${h.closed}${h.open}${h.close}`).join(',') === b.hours.map(h => `${h.closed}${h.open}${h.close}`).join(','),
    onDirtyChange,
  )

  const custom = fields.mode === 'custom'
  // With slots ON the weekday rule is the hours editor, and `validateSlotHours` (`no_open_day`)
  // is what refuses a shop with every day unticked; this guard is the slots-OFF twin.
  const allClosed = !custom && !fields.slotsEnabled && fields.closed.length === 7

  /**
   * One weekday control at a time (#282). With slots on, the hours editor's checkboxes ARE the
   * closed days, and the "Closed days" card is hidden rather than shown beside them saying
   * something else. Flipping the switch carries the rule across so no day reopens by surprise:
   * on, the hours rows start from the closed days; off, the closed days are read back off the
   * rows. On save, `closed_weekdays` is written from whichever control was live, so the row
   * holds one truth and a shop that turns slots off later keeps the days it closed.
   */
  function setSlotsEnabled(on: boolean) {
    setFields(f => on
      ? { ...f, slotsEnabled: true, hours: f.hours.map((h, i) => (f.closed.includes(i) ? { ...h, closed: true } : h)) }
      : { ...f, slotsEnabled: false, closed: f.hours.flatMap((h, i) => (h.closed ? [i] : [])) })
  }
  const closedFromHours = (hours: HoursRow[]) => hours.flatMap((h, i) => (h.closed ? [i] : []))
  // The browser's own clock rather than the server-corrected one the storefront uses: this is a
  // settings form, where being a second out cannot cost an order, and the backend re-judges the
  // horizon against the shop's timezone anyway.
  const bounds = customDateBounds(fields.timezone, new Date())

  const dateErrorMessage = (code: CustomDatesError): string => ({
    no_dates: t('Pick at least one date, or customers cannot order at all.', '请至少选择一个日期，否则顾客无法下单。'),
    too_many: t('That is more dates than a shop can offer at once.', '所选日期数量超过上限。'),
    past_date: t('One of those dates has already passed.', '其中有日期已过期。'),
    beyond_horizon: t(`You can only take orders up to ${FULFILMENT_HORIZON_DAYS} days ahead.`,
                      `最多只能接受 ${FULFILMENT_HORIZON_DAYS} 天内的订单。`),
  })[code]

  const hoursErrorMessage = (code: SlotHoursError): string => ({
    invalid_time: t('Every open day needs an opening and a closing time.', '每个营业日都需要填写开门和关门时间。'),
    close_before_open: t('A closing time must be after its opening time.', '关门时间必须晚于开门时间。'),
    no_open_day: t('Open at least one day for long enough to fit one slot, or customers cannot order at all.',
                   '请至少有一天的营业时间能容纳一个时段，否则顾客无法下单。'),
  })[code]

  function toggleDay(d: number) {
    setFields(f => ({
      ...f,
      closed: f.closed.includes(d) ? f.closed.filter(x => x !== d) : [...f.closed, d].sort((a, b) => a - b),
    }))
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    // A shop closed all seven days offers the customer NO date at all, and the storefront's
    // picker would render empty with nothing to explain it. Refused here, where the merchant
    // is looking at the checkboxes that caused it.
    if (allClosed) {
      toast.error(t('Leave at least one day open, or customers cannot order at all.', '请至少保留一天营业，否则顾客无法下单。'))
      return
    }
    // Pruned BEFORE validating, so a stale tick left over from last month is dropped quietly
    // rather than refused: the merchant did nothing wrong, time passed.
    const dates = custom
      ? pruneCustomDates({ ...fulfilmentConfig(merchant!.config), custom_dates: fields.dates }, fields.timezone, new Date())
      : fields.dates
    if (custom) {
      const bad = validateCustomDates(dates, fields.timezone, new Date())
      if (bad) { toast.error(dateErrorMessage(bad)); return }
    }
    // The slot settings (#282). Judged on the RAW hours, because the reader turns a `close <= open`
    // day into a closed one and the merchant who typed it must be told.
    const rawHours = fields.hours.map(h => (h.closed ? null : { open: h.open, close: h.close }))
    const slotBag = {
      slots_enabled: fields.slotsEnabled,
      hours: rawHours,
      slot_minutes: Number(fields.slotMinutes),
      slot_notice_minutes: Number(fields.notice),
    }
    const badHours = validateSlotHours(rawHours, fulfilmentConfig({ fulfilment: slotBag }))
    if (badHours) { toast.error(hoursErrorMessage(badHours)); return }
    setBusy(true)
    try {
      // fulfilmentConfig is what READS this bag on both sides of the wire, so it is what WRITES
      // it too — the form cannot save a shape the storefront then reads back differently.
      const fulfilment = fulfilmentConfig({
        fulfilment: {
          mode: fields.mode,
          lead_days: Number(fields.lead),
          window_days: Number(fields.window),
          // Whichever weekday control was live — see `setSlotsEnabled`.
          closed_weekdays: fields.slotsEnabled ? closedFromHours(fields.hours) : fields.closed,
          custom_dates: dates,
          ...slotBag,
          // Saving IS the confirmation. The alert above the fields is what makes it deliberate.
          // Requiring an EDIT was rejected: change-then-revert is undetectable, and it would
          // force a merchant whose window was already right to make it wrong first (ADR 0015).
          needs_review: false,
        },
      })
      const saved = await updateMerchantConfig(merchant!.id, {
        config: { ...(merchant!.config ?? {}), fulfilment },
        timezone: fields.timezone,
      })
      if (!saved.ok) { toast.error(saved.error.message || t('Save failed', '保存失败')); return }
      await refreshMerchant()
      // Show back what was SAVED, not what was typed: `fulfilmentConfig` clamps, and a merchant
      // who typed 999 must not be left reading 999 while their shop offers 90.
      const applied = {
        mode: fulfilment.mode,
        lead: String(fulfilment.lead_days),
        window: String(fulfilment.window_days),
        closed: fulfilment.closed_weekdays,
        dates: fulfilment.custom_dates,
        timezone: fields.timezone,
        slotsEnabled: fulfilment.slots_enabled,
        hours: rowsFromHours(fulfilment.hours),
        slotMinutes: String(fulfilment.slot_minutes),
        notice: String(fulfilment.slot_notice_minutes),
      }
      setFields(applied)
      commit(applied)
      toast.success(needsReview
        ? t('Your shop is open again', '店铺已重新开放')
        : t('Fulfilment saved', '取货设置已保存'))
    } catch (err: any) {
      toast.error(err.message || t('Save failed', '保存失败'))
    } finally { setBusy(false) }
  }

  return (
    <form onSubmit={save}>
      {/* The merchant-facing half of the pause. Not dismissible: a shop that has stopped taking
          orders is not a thing its owner should be able to hide from themselves. */}
      {needsReview && (
        <div className="bg-brand-wash border-[0.5px] border-primary rounded-2xl p-5 mb-8 w-full box-border max-sm:p-4">
          <h3 className="font-heading text-[15px] font-medium text-primary mb-2">
            {t('Your shop is paused', '店铺已暂停接单')}
          </h3>
          <p className="text-[13px] text-foreground leading-[1.6]">
            {t('Your shop is back on the rolling window below. Customers cannot order until you confirm it.',
               '店铺已改回下方的滚动日期范围。确认后顾客才能继续下单。')}
          </p>
        </div>
      )}

      <div className={CARD}>
        <h3 className={HEADING}>{t('Order dates', '可选日期')}</h3>

        <RadioGroup
          value={fields.mode}
          onValueChange={v => setFields(f => ({ ...f, mode: v === 'custom' ? 'custom' : 'rolling' }))}
          className="flex flex-col gap-3 mb-5"
        >
          <label className="flex items-start gap-3 cursor-pointer">
            <RadioGroupItem value="rolling" id="ff-mode-rolling" className="mt-[3px]" />
            <span>
              <span className="block text-[14px] font-medium text-foreground">
                {t('Rolling window', '滚动日期范围')}
              </span>
              <span className="block text-[12px] text-muted-foreground leading-[1.5]">
                {t('Customers pick any day in a range that moves with today.', '顾客可在随当天滚动的日期范围内选择。')}
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <RadioGroupItem value="custom" id="ff-mode-custom" className="mt-[3px]" />
            <span>
              <span className="flex items-center gap-2 text-[14px] font-medium text-foreground">
                {t('Specific dates', '指定日期')}
              </span>
              <span className="block text-[12px] text-muted-foreground leading-[1.5]">
                {t('You tick the exact dates you deliver on. Days of notice and closed days do not apply.',
                   '由你勾选具体的配送日期，提前天数与休息日不再适用。')}
              </span>
            </span>
          </label>
        </RadioGroup>

        {custom ? (
          bounds && (
            <>
              <CustomDatesCalendar
                value={fields.dates}
                onChange={dates => setFields(f => ({ ...f, dates }))}
                first={bounds.first}
                last={bounds.last}
                t={t}
                lang={lang}
              />
              {/* The count lives on the list's own heading now, so this says only the thing the
                  list cannot: that removing a date is not retroactive. */}
              <p className="text-[12px] text-muted-foreground mt-3 leading-[1.5]">
                {fields.dates.length === 0
                  ? t('No dates picked — customers would have none to choose.', '尚未选择任何日期，顾客将无日期可选。')
                  : t('Removing a date only stops new orders — orders already placed for it are unaffected.',
                      '取消某个日期只会停止新订单，已下单的订单不受影响。')}
              </p>
            </>
          )
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="ff-lead">{t('Days of notice you need', '需要提前的天数')}</Label>
              <Input id="ff-lead" type="number" min="0" max="30" value={fields.lead} variant="compact"
                onChange={e => setFields(f => ({ ...f, lead: e.target.value }))} />
              <p className="text-[12px] text-muted-foreground mt-1 leading-[1.5]">
                {t('0 lets customers order for today. 1 means the earliest they can pick is tomorrow.',
                   '填 0 表示顾客可选当天。填 1 表示最早只能选明天。')}
              </p>
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="ff-window">{t('How many days ahead you take orders', '可提前预订的天数')}</Label>
              <Input id="ff-window" type="number" min="1" max="90" value={fields.window} variant="compact"
                onChange={e => setFields(f => ({ ...f, window: e.target.value }))} />
              <p className="text-[12px] text-muted-foreground mt-1 leading-[1.5]">
                {t('Counted from the earliest date above. Closed days come out of this range — they do not extend it.',
                   '从上面最早可选日期起算。休息日会从这段日期中扣除，不会顺延。')}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Greyed rather than hidden in custom mode: these settings are dormant, not gone, and they
          come back exactly as they were the moment the merchant returns to a rolling window.
          HIDDEN with slots on, though — there the hours editor below is the weekday control, and
          two controls for one fact is how one of them comes to lie (see `setSlotsEnabled`). */}
      {!fields.slotsEnabled && <div className={CARD}>
        <h3 className={HEADING}>{t('Closed days', '休息日')}</h3>
        {/* Live in BOTH modes, and deliberately not disabled in custom.
            Greying these out took the documented disabled treatment (one grey for every control),
            which erased WHICH days were closed — the merchant could not see their own setting
            until they switched back. Every other dormant setting in this dashboard stays legible:
            a disabled tax still shows its rate, and the express fee fields stay editable while
            express is off. So does this. Toggling here while custom dates are on is a real edit
            to what applies the moment the shop returns to a rolling window; the line below is
            what says it is not in effect right now. */}
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('Closed days', '休息日')}>
          {WEEKDAYS.map(d => {
            const on = fields.closed.includes(d.value)
            return (
              <button
                key={d.value}
                type="button"
                aria-pressed={on}
                onClick={() => toggleDay(d.value)}
                className={
                  'border rounded-md py-2 px-[14px] pointer-coarse:min-h-11 cursor-pointer text-[14px] font-sans transition-all ' +
                  'hover:border-primary focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 ' +
                  (on
                    ? 'border-[0.5px] border-primary bg-brand-wash text-primary font-medium'
                    : 'border-border bg-card text-foreground')
                }
              >
                {t(d.en, d.zh)}
              </button>
            )
          })}
        </div>
        <p className="text-[12px] text-muted-foreground mt-3 leading-[1.5]">
          {custom
            ? t('Not in effect while you are picking specific dates. These apply again if you switch back to a rolling window.',
                 '使用指定日期期间不生效。切换回滚动日期范围后将重新适用。')
            : allClosed
              ? t('Every day is marked closed — customers would have no date to pick.', '所有日期都标记为休息，顾客将无日期可选。')
              : t('Days you take no orders. Customers cannot pick these.', '不接单的日子，顾客无法选择。')}
        </p>
      </div>}

      {/* Time slots (#282). A window inside the date, from hours the merchant sets here. */}
      <div className={CARD}>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <h3 className={HEADING + ' mb-0'}>{t('Time slots', '时段')}</h3>
          <label className="flex items-center gap-2 text-[13px] text-foreground cursor-pointer">
            <Switch
              checked={fields.slotsEnabled}
              onCheckedChange={v => setSlotsEnabled(v === true)}
              aria-label={t('Let customers pick a time slot', '让顾客选择时段')}
            />
            {t('Let customers pick a time slot', '让顾客选择时段')}
          </label>
        </div>

        {/* Visible but disabled while off — the merchant sees what turning it on gives them, the
            way the express fee fields stay legible while express is off. */}
        <fieldset disabled={!fields.slotsEnabled} className="flex flex-col gap-5 disabled:opacity-60">
          <div>
            <Label className="mb-2 block">{t('Opening hours', '营业时间')}</Label>
            <div className="flex flex-col gap-2">
              {WEEKDAYS.map(d => {
                const row = fields.hours[d.value]
                const setRow = (patch: Partial<HoursRow>) =>
                  setFields(f => ({ ...f, hours: f.hours.map((h, i) => (i === d.value ? { ...h, ...patch } : h)) }))
                return (
                  <div key={d.value} className="grid grid-cols-[76px_1fr_auto_1fr] items-center gap-2">
                    <label className="flex items-center gap-2 text-[14px]">
                      <Checkbox
                        checked={!row.closed}
                        onCheckedChange={v => setRow({ closed: v !== true })}
                        aria-label={t(`Open on ${d.en}`, `${d.zh}营业`)}
                      />
                      {t(d.en, d.zh)}
                    </label>
                    <TimeSelect id={`ff-open-${d.value}`} value={row.open} disabled={row.closed}
                      label={t(`${d.en} opens`, `${d.zh}开门`)} onChange={open => setRow({ open })} />
                    <span className="text-muted-foreground">–</span>
                    <TimeSelect id={`ff-close-${d.value}`} value={row.close} disabled={row.closed}
                      label={t(`${d.en} closes`, `${d.zh}关门`)} onChange={close => setRow({ close })} />
                  </div>
                )
              })}
            </div>
            <p className="text-[12px] text-muted-foreground mt-2 leading-[1.5]">
              {t('An unticked day is a closed day. Customers cannot pick it.', '未勾选的日子即为休息日，顾客无法选择。')}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="ff-slot-minutes">{t('Slot length', '时段长度')}</Label>
              <Select value={fields.slotMinutes} onValueChange={v => setFields(f => ({ ...f, slotMinutes: v ?? f.slotMinutes }))}>
                <SelectTrigger id="ff-slot-minutes" className="w-full" aria-label={t('Slot length', '时段长度')}>
                  <span>{t(`${fields.slotMinutes} minutes`, `${fields.slotMinutes} 分钟`)}</span>
                </SelectTrigger>
                <SelectContent>
                  {SLOT_MINUTES.map(m => <SelectItem key={m} value={String(m)}>{t(`${m} minutes`, `${m} 分钟`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="ff-notice">{t('Customers must order at least', '顾客最少需提前')}</Label>
              <Select value={fields.notice} onValueChange={v => setFields(f => ({ ...f, notice: v ?? f.notice }))}>
                <SelectTrigger id="ff-notice" className="w-full" aria-label={t('Notice', '提前时间')}>
                  <span>{(() => { const o = NOTICE_OPTIONS.find(o => String(o.value) === fields.notice); return o ? t(o.en, o.zh) : fields.notice })()}</span>
                </SelectTrigger>
                <SelectContent>
                  {NOTICE_OPTIONS.map(o => <SelectItem key={o.value} value={String(o.value)}>{t(o.en, o.zh)}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[12px] text-muted-foreground mt-1 leading-[1.5]">
                {t('before the slot starts. Counted on your shop’s clock.', '于时段开始前下单。以店铺时区计算。')}
              </p>
            </div>
          </div>

          {/* What the storefront will offer, from the form's own values, before the save. */}
          <div className="text-[12px] text-muted-foreground leading-[1.6]">
            {WEEKDAYS.map(d => {
              const row = fields.hours[d.value]
              if (row.closed) return null
              const slots = slotsBetween({ open: row.open, close: row.close }, Number(fields.slotMinutes) as SlotMinutes)
              return (
                <div key={d.value} className={slots.length === 0 ? 'text-warning-fg' : ''}>
                  <span className="font-medium text-foreground">{t(d.en, d.zh)}:</span>{' '}
                  {slots.length === 0
                    ? t('0 slots — the hours are shorter than one slot', '0 个时段：营业时间短于一个时段')
                    : `${slots.slice(0, 4).map(s => `${s.from} – ${s.to}`).join(', ')}${slots.length > 4 ? ', …' : ''} (${t(`${slots.length} slots`, `${slots.length} 个时段`)})`}
                </div>
              )
            })}
          </div>
        </fieldset>
      </div>

      <div className={CARD}>
        <h3 className={HEADING}>{t('Time zone', '时区')}</h3>
        <div className="flex flex-col gap-[6px]">
          <Label htmlFor="ff-tz">{t('Your shop’s clock', '店铺所在时区')}</Label>
          <Select value={fields.timezone} onValueChange={v => setFields(f => ({ ...f, timezone: v ?? f.timezone }))}>
            <SelectTrigger id="ff-tz" className="w-full max-w-[280px]" aria-label={t('Time zone', '时区')}>
              <span className="truncate">{fields.timezone}</span>
            </SelectTrigger>
            <SelectContent>
              {TIMEZONES.map(tz => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-[12px] text-muted-foreground mt-1 leading-[1.5]">
            {t('Decides which date counts as “today” for your customers, wherever they are ordering from.',
               '决定顾客下单时“今天”是哪一天，无论他们身在何处。')}
          </p>
        </div>
      </div>

      <Button type="submit" size="md" className="mt-1" disabled={busy || allClosed}>
        {busy
          ? t('Saving…', '保存中…')
          : needsReview
            ? t('Confirm and reopen shop', '确认并重新开放店铺')
            : t('Save fulfilment', '保存取货设置')}
      </Button>
    </form>
  )
}
