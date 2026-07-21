import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { updateMerchantConfig, fetchMerchantSecret, upsertMerchantSecret, merchantHasOrders } from '../store'
import { shopRates, shopTax } from '@bitetime/shared'
import { CURRENCIES, CURRENCY_CODES, DEFAULT_CURRENCY, currencyDef } from '../currency'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger } from '../components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { useNavGuard } from './NavGuard'
import { isDirty, type SettingsFields } from './settingsDirty'
import ReferralTab from './ReferralTab'
import FulfilmentTab from './FulfilmentTab'

type TabKey = 'shipping' | 'fulfilment' | 'payment' | 'notifications' | 'referral'

// Tabbed Shop Settings (issue #19). A container renders a horizontal tab bar and
// the active tab's form; each tab is its own form with its own Save. Only the
// active tab can be dirty — the unsaved guard blocks leaving a dirty tab — so the
// container tracks a single `dirty` flag and registers it with the NavGuard.
export default function ShopSettings() {
  const { t } = useSession()
  const { guard, registerBlocker } = useNavGuard()
  const [tab, setTab] = useState<TabKey>('shipping')
  const [dirty, setDirty] = useState(false)

  // Register this section's dirty state so the Dashboard sidebar can guard against it.
  useEffect(() => {
    registerBlocker(() => dirty)
    return () => registerBlocker(null)
  }, [dirty, registerBlocker])

  // Warn on browser close/reload while there are unsaved edits.
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // Switching sub-tab routes through the guard; on Discard the old tab unmounts
  // (resetting its fields from the saved snapshot) and the new one mounts clean.
  const changeTab = (next: TabKey) => {
    if (next === tab) return
    guard(() => { setDirty(false); setTab(next) })
  }

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'shipping', label: t('Shipping', '运费') },
    { key: 'fulfilment', label: t('Fulfilment', '取货') },
    { key: 'payment', label: t('Payment', '付款') },
    { key: 'notifications', label: t('Notifications', '通知') },
    { key: 'referral', label: t('Referral', '推荐') },
  ]

  return (
    <div className="w-full">
      <Tabs value={tab} onValueChange={(v) => changeTab(v as TabKey)} className="mb-6">
        {/* Mobile: 4 nowrap tabs exceed the narrow column, so scroll horizontally
            with natural widths instead of clipping the last tab off-screen. */}
        <TabsList className="max-sm:justify-start max-sm:overflow-x-auto max-sm:[scrollbar-width:none] max-sm:[&::-webkit-scrollbar]:hidden">
          {TABS.map(({ key, label }) => (
            <TabsTrigger key={key} value={key} className="max-sm:flex-none">{label}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {tab === 'shipping' && <ShippingTab onDirtyChange={setDirty} />}
      {tab === 'fulfilment' && <FulfilmentTab onDirtyChange={setDirty} />}
      {tab === 'payment' && <PaymentTab onDirtyChange={setDirty} />}
      {tab === 'notifications' && <NotificationsTab onDirtyChange={setDirty} />}
      {tab === 'referral' && <ReferralTab />}
    </div>
  )
}

interface TabProps { onDirtyChange: (dirty: boolean) => void }

const CARD = 'bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border max-sm:p-4 max-sm:mb-6'
const HEADING = 'font-heading text-[15px] font-medium text-oxblood mb-4 flex items-center gap-2'

// Reports dirty state up whenever `saved` vs `fields` diverge. Returns a stable helper set.
function useTabDirty(saved: SettingsFields, fields: SettingsFields, onDirtyChange: (d: boolean) => void) {
  const dirty = isDirty(saved, fields)
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  return dirty
}

function SaveRow({ busy, label }: { busy: boolean; label: { idle: string; busy: string } }) {
  return (
    <Button type="submit" size="md" className="mt-1" disabled={busy}>
      {busy ? label.busy : label.idle}
    </Button>
  )
}

function ShippingTab({ onDirtyChange }: TabProps) {
  const { t, merchant, refreshMerchant } = useSession()
  const [saved, setSaved] = useState<SettingsFields>(() => {
    // shopRates, not a local `?? 8` / `?? 18`: this form shows the merchant what a row with a
    // missing key CHARGES, and the charge is decided by that one function on both sides of the
    // wire. A third fallback rule here would show a rate (EM 18) that nobody quotes and nobody
    // bills — and saving it would move a real price the merchant never meant to touch.
    const rates = shopRates(merchant!.shipping)
    // shopTax, not a local `?? 0`, for the same reason shopRates is used one line up: this form
    // shows the merchant what their shop CHARGES, and the charge is decided by that one function
    // on both sides of the wire.
    const tax = shopTax(merchant!)
    return {
      currency: merchant!.currency ?? DEFAULT_CURRENCY,
      wm: String(rates.WM),
      em: String(rates.EM),
      pickupAddress: merchant!.pickup_address ?? '',
      taxEnabled: tax.enabled,
      taxRate: tax.rate ? String(tax.rate) : '',
    }
  })
  const [fields, setFields] = useState<SettingsFields>(saved)
  const [busy, setBusy] = useState(false)
  // Currency locks after the first order so past orders/aggregates never
  // re-denominate. Assume locked until the check clears, so it can't flip open.
  const [currencyLocked, setCurrencyLocked] = useState(true)
  useTabDirty(saved, fields, onDirtyChange)

  useEffect(() => {
    let active = true
    merchantHasOrders(merchant!.id).then(has => { if (active) setCurrencyLocked(has) })
    return () => { active = false }
  }, [merchant!.id])

  // Live symbol drives the shipping-rate input labels.
  const symbol = currencyDef(fields.currency).symbol

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true)
    try {
      // shopRates is what READS this column on both sides of the wire, so it is what WRITES it
      // too — the same function, so the form cannot save a row it then reads back differently.
      //
      // It used to be `Number(fields.em) || 0`, and that quietly defeated the one guarantee
      // shopRates makes: a merchant who BLANKED the East-Malaysia field wrote an explicit 0 and
      // shipped to East Malaysia for FREE. shopRates promises a missing EM falls back to WM
      // precisely so that cannot happen, and the promise is worth nothing if the form in front
      // of it writes the zero by hand. A blank field is now "I did not name a rate" (→ WM); a
      // typed `0` is still an honest, deliberate zero.
      const shipping = shopRates({ WM: fields.wm, EM: fields.em })
      await updateMerchantConfig(merchant!.id, {
        // Guard against a stale locked value slipping through: only persist the
        // currency when it is still editable.
        ...(currencyLocked ? {} : { currency: fields.currency }),
        shipping,
        pickup_address: (fields.pickupAddress ?? '').trim() || null,
        // A blank rate box is 0, and 0 is "no tax" — the same collapse `shopTax` makes when it
        // reads the row back, so the form cannot save a value it then displays differently.
        // The checkbox is stored as typed: a merchant who unticks it keeps their rate on the
        // row, and reads it back as OFF because `shopTax` gates on the flag.
        tax_enabled: fields.taxEnabled,
        tax_rate: Number(fields.taxRate) || 0,
      })
      await refreshMerchant()
      // Show back the rates that were actually SAVED, not the blank that was typed — a merchant
      // must never be left looking at an empty box while their shop charges the WM rate.
      //
      // Tax goes through shopTax for the same reason: a ticked-but-blank rate is written as
      // `{tax_enabled: true, tax_rate: 0}`, which shopTax collapses to OFF when it reads the row
      // back on reload. Carrying `fields.taxEnabled` over verbatim would show CHECKED here and
      // UNCHECKED after a refresh — shopTax is what the checkbox must agree with.
      const tax = shopTax({ tax_enabled: fields.taxEnabled, tax_rate: Number(fields.taxRate) || 0 })
      const applied = {
        ...fields,
        wm: String(shipping.WM),
        em: String(shipping.EM),
        taxEnabled: tax.enabled,
        taxRate: tax.rate ? String(tax.rate) : '',
      }
      setFields(applied)
      setSaved(applied)
      toast.success(t('Settings saved', '设置已保存'))
    } catch (err: any) { toast.error(err.message || t('Save failed', '保存失败')) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={save}>
      <div className={CARD}>
        <h3 className={HEADING}>{t('Currency', '货币')}</h3>
        <div className="flex flex-col gap-[6px]">
          <Label htmlFor="shop-currency">{t('Base currency', '基础货币')}</Label>
          <Select
            value={fields.currency}
            onValueChange={(v) => setFields(f => ({ ...f, currency: v }))}
            disabled={currencyLocked}
          >
            <SelectTrigger id="shop-currency" className="w-full max-w-[280px]" aria-label={t('Base currency', '基础货币')}>
              {/* Trigger shows the short code + symbol so it never truncates the
                  country name mid-word on mobile; the full label lives in the list. */}
              <span className="truncate">
                {currencyDef(fields.currency).code} — {currencyDef(fields.currency).symbol}
              </span>
            </SelectTrigger>
            <SelectContent>
              {CURRENCY_CODES.map(code => (
                <SelectItem key={code} value={code}>
                  {CURRENCIES[code].code} — {CURRENCIES[code].symbol} · {CURRENCIES[code].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[12px] text-rose-muted mt-1 leading-[1.5]">
            {currencyLocked
              ? t('Currency is locked because your shop has orders — changing it would re-denominate past totals.',
                  '因店铺已有订单，货币已锁定 — 更改会重新换算历史金额。')
              : t('The unit for your prices and what customers see. Locked once your first order is placed.',
                  '您的价格和顾客看到的金额单位。首笔订单后将锁定。')}
          </p>
        </div>
      </div>
      <div className={CARD}>
        <h3 className={HEADING}>{t('Shipping rates', '运费')}</h3>
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-wm">{t(`West Malaysia (${symbol})`, `西马运费 (${symbol})`)}</Label>
            <Input id="shop-wm" type="number" step="0.01" value={fields.wm}
              onChange={e => setFields(f => ({ ...f, wm: e.target.value }))} variant="compact" />
          </div>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-em">{t(`East Malaysia (${symbol})`, `东马运费 (${symbol})`)}</Label>
            <Input id="shop-em" type="number" step="0.01" value={fields.em}
              onChange={e => setFields(f => ({ ...f, em: e.target.value }))} variant="compact" />
            {/* Says what a blank field does, because a blank field DOES something: it charges the
                West Malaysia rate. Free shipping to East Malaysia has to be typed as a 0. */}
            <p className="text-[12px] text-rose-muted mt-1 leading-[1.5]">
              {t('Blank East Malaysia charges the same as West Malaysia. Enter 0 for free East Malaysia delivery.',
                 '东马留空则按西马运费收取。填 0 表示东马免运费。')}
            </p>
          </div>
        </div>
      </div>
      <div className={CARD}>
        <h3 className={HEADING}>{t('Tax', '税')}</h3>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-[14px] text-ink">
            <input
              type="checkbox"
              checked={fields.taxEnabled}
              onChange={e => setFields(f => ({ ...f, taxEnabled: e.target.checked }))}
            />
            {t('Charge tax on orders', '订单收取税费')}
          </label>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-tax-rate">{t('Tax rate (%)', '税率 (%)')}</Label>
            <Input
              id="shop-tax-rate" type="number" step="0.01" min="0" max="100"
              value={fields.taxRate}
              disabled={!fields.taxEnabled}
              onChange={e => setFields(f => ({ ...f, taxRate: e.target.value }))}
              variant="compact"
            />
            {/* Says what the rate DOES, because the base is not obvious: it is charged on the
                food after any voucher, and never on the delivery fee. Also says what a BLANK (or
                zero) rate does, same reason as the East-Malaysia hint above: shopTax collapses
                a blank/0 rate to tax OFF, so the checkbox pops back unticked after save — this
                is what stops that from reading as an unexplained bug. */}
            <p className="text-[12px] text-rose-muted mt-1 leading-[1.5]">
              {t('Added on top of your item prices, after any voucher discount. Delivery fees are not taxed. Leave blank, or enter 0, to turn tax off.',
                 '在商品价格之上加收，扣除优惠券后计算。运费不征税。留空或填 0 即可关闭税费。')}
            </p>
          </div>
        </div>
      </div>
      <div className={CARD}>
        <h3 className={HEADING}>{t('Pickup address', '自取地址')}</h3>
        <div className="flex flex-col gap-[6px]">
          <Label htmlFor="shop-pickup">{t('Shown to customers who choose pickup', '选择自取的顾客可见')}</Label>
          <Textarea id="shop-pickup" value={fields.pickupAddress}
            onChange={e => setFields(f => ({ ...f, pickupAddress: e.target.value }))}
            rows={3} placeholder={t('e.g. 12 Jalan Example, 50000 Kuala Lumpur', '例如：吉隆坡某某路12号')}
            className="resize-y min-h-[72px] max-w-[420px]" />
        </div>
      </div>
      <SaveRow busy={busy} label={{ idle: t('Save', '保存'), busy: t('Saving…', '保存中…') }} />
    </form>
  )
}

function PaymentTab({ onDirtyChange }: TabProps) {
  const { t, merchant, refreshMerchant } = useSession()
  const [saved, setSaved] = useState<SettingsFields>(() => ({
    bank: merchant!.payment_bank ?? '',
    note: merchant!.payment_note ?? '',
  }))
  const [fields, setFields] = useState<SettingsFields>(saved)
  const [busy, setBusy] = useState(false)
  useTabDirty(saved, fields, onDirtyChange)

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true)
    try {
      await updateMerchantConfig(merchant!.id, { payment_bank: fields.bank, payment_note: fields.note })
      await refreshMerchant()
      setSaved(fields)
      toast.success(t('Payment saved', '付款已保存'))
    } catch (err: any) { toast.error(err.message || t('Save failed', '保存失败')) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={save}>
      <div className={CARD}>
        <h3 className={HEADING}>{t('Payment', '付款')}</h3>
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-bank">{t('Bank / payment details', '银行/付款信息')}</Label>
            <Input id="shop-bank" value={fields.bank}
              onChange={e => setFields(f => ({ ...f, bank: e.target.value }))} variant="compact" />
          </div>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-note">{t('Payment note (shown to customers)', '付款备注（顾客可见）')}</Label>
            <Input id="shop-note" value={fields.note}
              onChange={e => setFields(f => ({ ...f, note: e.target.value }))} variant="compact" />
          </div>
        </div>
      </div>
      <SaveRow busy={busy} label={{ idle: t('Save payment', '保存付款'), busy: t('Saving…', '保存中…') }} />
    </form>
  )
}

function NotificationsTab({ onDirtyChange }: TabProps) {
  const { t, merchant } = useSession()
  const [saved, setSaved] = useState<SettingsFields>({ tgToken: '', tgChat: '' })
  const [fields, setFields] = useState<SettingsFields>({ tgToken: '', tgChat: '' })
  const [busy, setBusy] = useState(false)
  const loaded = useRef(false)
  useTabDirty(saved, fields, onDirtyChange)

  useEffect(() => {
    fetchMerchantSecret(merchant!.id).then((s: any) => {
      const v = { tgToken: s?.tg_token ?? '', tgChat: s?.tg_chat_id ?? '' }
      setSaved(v)
      // Only overwrite in-flight edits if the user hasn't started typing yet.
      if (!loaded.current) setFields(v)
      loaded.current = true
    })
  }, [merchant!.id])

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true)
    try {
      await upsertMerchantSecret(merchant!.id, { tg_token: fields.tgToken, tg_chat_id: fields.tgChat })
      setSaved(fields)
      toast.success(t('Notifications saved', '通知已保存'))
    } catch (err: any) { toast.error(err.message || t('Save failed', '保存失败')) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={save}>
      <div className={CARD}>
        <h3 className={HEADING}>{t('Order notifications', '订单通知')}</h3>
        <p className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em] mb-3">Telegram</p>
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-tgtoken">{t('Bot token', '机器人令牌')}</Label>
            <Input id="shop-tgtoken" value={fields.tgToken}
              onChange={e => setFields(f => ({ ...f, tgToken: e.target.value }))} variant="compact" />
          </div>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-tgchat">{t('Chat ID', '聊天 ID')}</Label>
            <Input id="shop-tgchat" value={fields.tgChat}
              onChange={e => setFields(f => ({ ...f, tgChat: e.target.value }))} variant="compact" />
          </div>
        </div>
      </div>
      <SaveRow busy={busy} label={{ idle: t('Save notifications', '保存通知'), busy: t('Saving…', '保存中…') }} />
    </form>
  )
}
