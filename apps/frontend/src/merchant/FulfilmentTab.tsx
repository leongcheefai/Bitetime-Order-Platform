import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { updateMerchantConfig } from '../store'
import { fulfilmentConfig, DEFAULT_TIMEZONE } from '@bitetime/shared'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger } from '../components/ui/select'

const CARD = 'bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border max-sm:p-4 max-sm:mb-6'
const HEADING = 'font-heading text-[15px] font-medium text-oxblood mb-4 flex items-center gap-2'

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

interface TabProps { onDirtyChange: (dirty: boolean) => void }

export default function FulfilmentTab({ onDirtyChange }: TabProps) {
  const { t, merchant, refreshMerchant } = useSession()

  // fulfilmentConfig, not a local `?? 0` / `?? 14`: this form shows the merchant what a shop
  // with no saved config ACTUALLY OFFERS, and that is decided by one function on both sides of
  // the wire. A second set of fallbacks here would show a window the storefront never renders.
  const initial = () => {
    const cfg = fulfilmentConfig(merchant!.config)
    return {
      lead: String(cfg.lead_days),
      window: String(cfg.window_days),
      closed: cfg.closed_weekdays,
      timezone: merchant!.timezone ?? DEFAULT_TIMEZONE,
    }
  }
  const [saved, setSaved] = useState(initial)
  const [fields, setFields] = useState(saved)
  const [busy, setBusy] = useState(false)

  const dirty =
    fields.lead !== saved.lead ||
    fields.window !== saved.window ||
    fields.timezone !== saved.timezone ||
    fields.closed.join(',') !== saved.closed.join(',')

  // The container tracks one dirty flag for the active tab and registers it with the NavGuard.
  // Not ShopSettings' `useTabDirty`, which is typed to SettingsFields (a flat string map) and
  // cannot hold this tab's number[] of closed weekdays. Same contract, different shape.
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])

  const allClosed = fields.closed.length === 7

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
    setBusy(true)
    try {
      // fulfilmentConfig is what READS this bag on both sides of the wire, so it is what WRITES
      // it too — the form cannot save a shape the storefront then reads back differently.
      const fulfilment = fulfilmentConfig({
        fulfilment: {
          lead_days: Number(fields.lead),
          window_days: Number(fields.window),
          closed_weekdays: fields.closed,
        },
      })
      await updateMerchantConfig(merchant!.id, {
        config: { ...(merchant!.config ?? {}), fulfilment },
        timezone: fields.timezone,
      })
      await refreshMerchant()
      // Show back what was SAVED, not what was typed: `fulfilmentConfig` clamps, and a merchant
      // who typed 999 must not be left reading 999 while their shop offers 90.
      const applied = {
        lead: String(fulfilment.lead_days),
        window: String(fulfilment.window_days),
        closed: fulfilment.closed_weekdays,
        timezone: fields.timezone,
      }
      setFields(applied)
      setSaved(applied)
      toast.success(t('Fulfilment saved', '取货设置已保存'))
    } catch (err: any) {
      toast.error(err.message || t('Save failed', '保存失败'))
    } finally { setBusy(false) }
  }

  return (
    <form onSubmit={save}>
      <div className={CARD}>
        <h3 className={HEADING}>{t('Order dates', '可选日期')}</h3>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="ff-lead">{t('Days of notice you need', '需要提前的天数')}</Label>
            <Input id="ff-lead" type="number" min="0" max="30" value={fields.lead} variant="compact"
              onChange={e => setFields(f => ({ ...f, lead: e.target.value }))} />
            <p className="text-[12px] text-rose-muted mt-1 leading-[1.5]">
              {t('0 lets customers order for today. 1 means the earliest they can pick is tomorrow.',
                 '填 0 表示顾客可选当天。填 1 表示最早只能选明天。')}
            </p>
          </div>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="ff-window">{t('How many days ahead you take orders', '可提前预订的天数')}</Label>
            <Input id="ff-window" type="number" min="1" max="90" value={fields.window} variant="compact"
              onChange={e => setFields(f => ({ ...f, window: e.target.value }))} />
            <p className="text-[12px] text-rose-muted mt-1 leading-[1.5]">
              {t('Counted from the earliest date above. Closed days come out of this range — they do not extend it.',
                 '从上面最早可选日期起算。休息日会从这段日期中扣除，不会顺延。')}
            </p>
          </div>
        </div>
      </div>

      <div className={CARD}>
        <h3 className={HEADING}>{t('Closed days', '休息日')}</h3>
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
                  'hover:border-oxblood focus-visible:outline-2 focus-visible:outline-oxblood focus-visible:outline-offset-2 ' +
                  (on
                    ? 'border-[1.5px] border-oxblood bg-oxblood-tint text-oxblood font-medium'
                    : 'border-clay-border bg-surface-raised text-ink')
                }
              >
                {t(d.en, d.zh)}
              </button>
            )
          })}
        </div>
        <p className="text-[12px] text-rose-muted mt-3 leading-[1.5]">
          {allClosed
            ? t('Every day is marked closed — customers would have no date to pick.', '所有日期都标记为休息，顾客将无日期可选。')
            : t('Days you take no orders. Customers cannot pick these.', '不接单的日子，顾客无法选择。')}
        </p>
      </div>

      <div className={CARD}>
        <h3 className={HEADING}>{t('Time zone', '时区')}</h3>
        <div className="flex flex-col gap-[6px]">
          <Label htmlFor="ff-tz">{t('Your shop’s clock', '店铺所在时区')}</Label>
          <Select value={fields.timezone} onValueChange={v => setFields(f => ({ ...f, timezone: v }))}>
            <SelectTrigger id="ff-tz" className="w-full max-w-[280px]" aria-label={t('Time zone', '时区')}>
              <span className="truncate">{fields.timezone}</span>
            </SelectTrigger>
            <SelectContent>
              {TIMEZONES.map(tz => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-[12px] text-rose-muted mt-1 leading-[1.5]">
            {t('Decides which date counts as “today” for your customers, wherever they are ordering from.',
               '决定顾客下单时“今天”是哪一天，无论他们身在何处。')}
          </p>
        </div>
      </div>

      <Button type="submit" size="md" className="mt-1" disabled={busy || allClosed}>
        {busy ? t('Saving…', '保存中…') : t('Save fulfilment', '保存取货设置')}
      </Button>
    </form>
  )
}
