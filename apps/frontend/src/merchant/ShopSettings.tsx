import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { updateMerchantConfig, fetchMerchantSecret, upsertMerchantSecret, merchantHasOrders } from '../store'
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

type TabKey = 'shipping' | 'payment' | 'notifications' | 'referral'

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
  const [saved, setSaved] = useState<SettingsFields>(() => ({
    currency: merchant!.currency ?? DEFAULT_CURRENCY,
    wm: String(merchant!.shipping?.WM ?? 8),
    em: String(merchant!.shipping?.EM ?? 18),
    pickupAddress: merchant!.pickup_address ?? '',
  }))
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
      await updateMerchantConfig(merchant!.id, {
        // Guard against a stale locked value slipping through: only persist the
        // currency when it is still editable.
        ...(currencyLocked ? {} : { currency: fields.currency }),
        shipping: { WM: Number(fields.wm) || 0, EM: Number(fields.em) || 0 },
        pickup_address: fields.pickupAddress.trim() || null,
      })
      await refreshMerchant()
      setSaved(fields)
      toast.success(t('Shipping saved', '运费已保存'))
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
      <SaveRow busy={busy} label={{ idle: t('Save shipping', '保存运费'), busy: t('Saving…', '保存中…') }} />
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
