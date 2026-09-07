import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { updateMerchantConfig, fetchMerchantSecret, upsertMerchantSecret, deletePaymentQr } from '../store'
import { shopRates, shopTax, shopDistance, shopMethods } from '@bitetime/shared'
import { CURRENCIES, CURRENCY_CODES, DEFAULT_CURRENCY, currencyDef } from '../currency'
import { Button } from '../components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger } from '../components/ui/select'
import { Badge } from '../components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { trackEvent } from '../analytics/events'
import { useNavGuard } from './NavGuard'
import { isDirty, type SettingsFields } from './settingsDirty'
import { useSaved } from './useSaved'
import ReferralTab from './ReferralTab'
import FulfilmentTab from './FulfilmentTab'
import SubscriptionTab from './SubscriptionTab'
import BrandColourCard from './BrandColourCard'
import { useDashboardSubsection } from '../useDashboardSection'
import AddressAutocomplete from '../store/AddressAutocomplete'
import PaymentQrPicker from './PaymentQrPicker'
import SettingsMenu from './SettingsMenu'
import DevicesTab from './DevicesTab'

type TabKey = 'shipping' | 'fulfilment' | 'payment' | 'brand' | 'marketing' | 'notifications' | 'subscription' | 'referral' | 'devices'

// Shop Settings (issue #19). A container renders a submenu column and the active
// tab's form; each tab is its own form with its own Save. Only the active tab can
// be dirty — the unsaved guard blocks leaving a dirty tab — so the container tracks
// a single `dirty` flag and registers it with the NavGuard.
export default function ShopSettings() {
  const { t } = useSession()
  const { guard, registerBlocker } = useNavGuard()
  // WHICH tab is dirty, not merely whether one is. Only the active tab can be, so `dirty` falls
  // out of the comparison — and a tab switch clears it by construction rather than by an effect
  // that has to remember to. It used to be a bare boolean reset by ShopSettings being remounted;
  // now the hash is router-owned nothing remounts, and a stale `true` would block the next
  // navigation and warn on reload about edits that no longer exist.
  const [dirtyTab, setDirtyTab] = useState<TabKey | null>(null)

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'shipping', label: t('Shipping', '运费') },
    { key: 'fulfilment', label: t('Fulfilment', '取货') },
    { key: 'payment', label: t('Payment', '付款') },
    { key: 'brand', label: t('Brand', '品牌') },
    { key: 'marketing', label: t('Marketing', '营销') },
    { key: 'notifications', label: t('Notifications', '通知') },
    { key: 'subscription', label: t('Subscription', '订阅') },
    { key: 'referral', label: t('Referral', '推荐') },
    { key: 'devices', label: t('Devices', '设备') },
  ]

  // The sub-tab lives in the URL hash (`#settings/payment`), so it survives a refresh and a Pro
  // CTA can link straight at Subscription (#112). Keys come from TABS so a new tab is declared
  // once, not in a parallel list that can drift.
  // Default stays 'shipping', NOT the new first tab: every merchant who opens Settings or
  // follows an existing `#settings` link lands where they always have. A one-field page about
  // what the shop sells is not worth moving everyone's shipping form behind a click (#161).
  const [tab, setTab] = useDashboardSubsection('settings', TABS.map(x => x.key), 'shipping')

  const dirty = dirtyTab === tab
  // Handed to every tab as `onDirtyChange`, so a tab reports only about itself.
  const setDirty = useCallback((next: boolean) => setDirtyTab(next ? tab : null), [tab])

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


  const activeLabel = TABS.find(x => x.key === tab)!.label

  return (
    // Two columns on desktop, stacked on mobile. `items-start` keeps the submenu's hairline
    // the height of the menu rather than stretching it down the whole panel.
    <div className="w-full flex items-start gap-6 max-sm:flex-col max-sm:gap-0">
      <SettingsMenu
        heading={t('Settings', '设置')}
        items={TABS}
        active={tab}
        onSelect={changeTab}
      />

      {/* `min-w-0` so a wide child (the subscription table) shrinks rather than pushing the
          submenu column out of the row. */}
      <div className="flex-1 min-w-0 w-full">
        {/* The panel names itself. With the tab rail gone nothing else does, and a settings
            form that opens from a deep link (`#settings/subscription`, every Pro CTA) would
            otherwise arrive unlabelled.
            Hidden on mobile, where the collapsed submenu trigger already carries the same
            label a few pixels above it. */}
        <h2 className="font-heading text-[19px] font-medium text-primary mb-5 max-sm:hidden">
          {activeLabel}
        </h2>

        {tab === 'shipping' && <ShippingTab onDirtyChange={setDirty} />}
        {tab === 'fulfilment' && <FulfilmentTab onDirtyChange={setDirty} />}
        {tab === 'payment' && <PaymentTab onDirtyChange={setDirty} />}
        {tab === 'brand' && <BrandColourCard onDirtyChange={setDirty} />}
        {tab === 'marketing' && <MarketingTab onDirtyChange={setDirty} />}
        {tab === 'notifications' && <NotificationsTab onDirtyChange={setDirty} />}
        {tab === 'subscription' && <SubscriptionTab />}
        {tab === 'referral' && <ReferralTab />}
        {/* No Save and no dirty state, so unlike its neighbours it takes no onDirtyChange. */}
        {tab === 'devices' && <DevicesTab />}
      </div>
    </div>
  )
}

interface TabProps { onDirtyChange: (dirty: boolean) => void }

const CARD = 'bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border max-sm:p-4 max-sm:mb-6'
const HEADING = 'font-heading text-[15px] font-medium text-primary mb-4 flex items-center gap-2'

// `SettingsFields`' index signature is `string | boolean | undefined`, wide enough to cover
// every tab in this file, but a key with no EXPLICIT declaration there resolves to that whole
// union — too wide for `Input`/`AddressAutocomplete`'s strictly-`string` `value` props. This
// local intersection narrows just the distance-policy keys this tab owns to `string` (matching
// every other numeric field this form already carries as text), without widening the shared
// type every other tab in this file also uses.
type ShippingFields = SettingsFields & {
  baseFee?: string
  ratePerKm?: string
  maxKm?: string
  originPlaceId?: string
  originAddress?: string
  originLat?: string
  originLng?: string
}

// `eq` for `useSaved` on this file's flat-map tabs: the negation of the shared `isDirty`.
const settingsEq = (a: SettingsFields, b: SettingsFields) => !isDirty(a, b)

function SaveRow({ busy, label }: { busy: boolean; label: { idle: string; busy: string } }) {
  return (
    <Button type="submit" size="md" className="mt-1" disabled={busy}>
      {busy ? label.busy : label.idle}
    </Button>
  )
}

function ShippingTab({ onDirtyChange }: TabProps) {
  const { t, merchant, refreshMerchant } = useSession()
  const [initial] = useState<ShippingFields>(() => {
    // shopRates/shopDistance/shopMethods, not local fallbacks: this form shows the merchant what
    // a row with a missing key CHARGES/OFFERS, and that is decided by these functions on both
    // sides of the wire — a third fallback rule here would show a price nobody bills.
    const rates = shopRates(merchant!.shipping)
    const distance = shopDistance(merchant!)
    const methods = shopMethods(merchant!)
    return {
      wm: String(rates.WM),
      em: String(rates.EM),
      pickupAddress: merchant!.pickup_address ?? '',
      pickupEnabled: methods.pickup,
      deliveryEnabled: methods.delivery,
      expressEnabled: methods.express,
      baseFee: String(distance.base),
      ratePerKm: String(distance.ratePerKm),
      maxKm: distance.maxKm === null ? '' : String(distance.maxKm),
      originPlaceId: merchant!.origin_place_id ?? '',
      originAddress: merchant!.origin_address ?? '',
      originLat: merchant!.origin_lat != null ? String(merchant!.origin_lat) : '',
      originLng: merchant!.origin_lng != null ? String(merchant!.origin_lng) : '',
    }
  })
  const [fields, setFields] = useState<ShippingFields>(initial)
  const [busy, setBusy] = useState(false)
  const { commit } = useSaved(initial, fields, settingsEq, onDirtyChange)

  // Rate-input labels show the shop's saved currency symbol. Currency is edited on the Payment
  // tab now, so this reads the persisted value, not a live field. (Currency locks after the
  // first order anyway, so this is stable in practice.)
  const symbol = currencyDef(merchant!.currency ?? DEFAULT_CURRENCY).symbol

  // The one method still on, if exactly one is — the checkbox that must not be untickable.
  const enabledMethods = (['pickup', 'delivery', 'express'] as const)
    .filter(m => fields[`${m}Enabled` as const])
  const onlyMethod = enabledMethods.length === 1 ? enabledMethods[0] : null

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true)
    try {
      // A typed origin never confirmed against the map has no place id. Refuse rather than drop it
      // silently under a success toast — the origin is the routing origin AND the cache key.
      if ((fields.originAddress ?? '').trim() !== '' && !fields.originPlaceId) {
        toast.error(t(
          'Pick your express delivery from address from the suggestions — a typed address on its own cannot be saved.',
          '请从建议列表中选择快速配送出发地 — 仅输入文字无法保存。'
        ))
        setBusy(false)
        return
      }

      // Express requires an origin to route from. Backend CHECK is the backstop; this names the
      // rule in the merchant's language while they still see the form.
      if (fields.expressEnabled && !fields.originPlaceId) {
        toast.error(t(
          'Set where express delivery starts before switching it on.',
          '请先设置快速配送出发地，才能开启快速配送。'
        ))
        setBusy(false)
        return
      }

      // Blank maxKm = "deliver anywhere with a road"; 0 = "deliver nowhere". Trimmed so this
      // agrees with the blank test the save makes below.
      if ((fields.maxKm ?? '').trim() !== '' && Number(fields.maxKm) <= 0) {
        toast.error(t(
          'Maximum distance must be greater than zero, or leave blank to deliver anywhere.',
          '最远配送距离必须大于零，或留空表示只要有路就送。'
        ))
        setBusy(false)
        return
      }

      // Read BEFORE the save, because the save is what makes it true. Unlike the link step's
      // flag, this one is written on every Shipping save, so the flag alone cannot say whether
      // this save was the first — only its value beforehand can.
      const completesShippingStep = merchant!.onboarding_shipping_set !== true

      // shopRates writes what it reads on both sides of the wire: a BLANK EM falls back to WM
      // (not free EM shipping); a typed 0 is an honest zero.
      const shipping = shopRates({ WM: fields.wm, EM: fields.em })
      const saved = await updateMerchantConfig(merchant!.id, {
        shipping,
        // Saving the Shipping tab completes the onboarding "set pickup / delivery"
        // step (#102). Idempotent — already true after the first save.
        onboarding_shipping_set: true,
        pickup_address: (fields.pickupAddress ?? '').trim() || null,
        // A disabled method keeps its configuration so switching it back does not mean retyping it.
        pickup_enabled: fields.pickupEnabled,
        delivery_enabled: fields.deliveryEnabled,
        express_enabled: fields.expressEnabled,
        delivery_base_fee: Number(fields.baseFee) || 0,
        delivery_rate_per_km: Number(fields.ratePerKm) || 0,
        // BLANK maximum is "anywhere with a road" — null, not 0.
        delivery_max_km: (fields.maxKm ?? '').trim() === '' ? null : Number(fields.maxKm),
        origin_place_id: fields.originPlaceId || null,
        // An unmatched string is not an origin: store coords/address only when place_id is confirmed.
        origin_lat: fields.originPlaceId && (fields.originLat ?? '').trim() !== '' ? Number(fields.originLat) : null,
        origin_lng: fields.originPlaceId && (fields.originLng ?? '').trim() !== '' ? Number(fields.originLng) : null,
        origin_address: fields.originPlaceId ? (fields.originAddress || null) : null,
      })
      if (!saved.ok) { toast.error(saved.error.message || t('Save failed', '保存失败')); return }
      // After the save succeeded: a step the shop does not actually have is not a step completed.
      if (completesShippingStep) trackEvent('onboarding_step', { step: 'shipping' })
      await refreshMerchant()
      // Show back what was actually SAVED, read through the one function that also reads it on
      // reload, not the raw strings that were typed.
      const distance = shopDistance({
        express_enabled: fields.expressEnabled,
        delivery_base_fee: Number(fields.baseFee) || 0,
        delivery_rate_per_km: Number(fields.ratePerKm) || 0,
        delivery_max_km: (fields.maxKm ?? '').trim() === '' ? null : Number(fields.maxKm),
        origin_place_id: fields.originPlaceId || null,
      })
      const applied = {
        ...fields,
        wm: String(shipping.WM),
        em: String(shipping.EM),
        baseFee: String(distance.base),
        ratePerKm: String(distance.ratePerKm),
        maxKm: distance.maxKm === null ? '' : String(distance.maxKm),
        originPlaceId: merchant!.origin_place_id ?? '',
        originAddress: merchant!.origin_address ?? '',
        originLat: merchant!.origin_lat != null ? String(merchant!.origin_lat) : '',
        originLng: merchant!.origin_lng != null ? String(merchant!.origin_lng) : '',
      }
      setFields(applied)
      commit(applied)
      toast.success(t('Settings saved', '设置已保存'))
    } catch (err: any) { toast.error(err.message || t('Save failed', '保存失败')) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={save}>
      <div className={CARD} data-tour="set-shipping">
        <h3 className={HEADING}>{t('What customers can choose', '顾客可选的方式')}</h3>
        <div className="flex flex-col gap-2">
          <label className="flex items-start gap-2 text-[14px] text-foreground">
            <Checkbox className="mt-1" checked={fields.pickupEnabled} disabled={onlyMethod === 'pickup'} onCheckedChange={v => setFields(f => ({ ...f, pickupEnabled: v === true }))} />
            <span>{t('Pickup — customers collect from you.', '自取 — 顾客自行前来领取。')}</span>
          </label>
          <label className="flex items-start gap-2 text-[14px] text-foreground">
            <Checkbox className="mt-1" checked={fields.deliveryEnabled} disabled={onlyMethod === 'delivery'} onCheckedChange={v => setFields(f => ({ ...f, deliveryEnabled: v === true }))} />
            <span>
              {t('Delivery — one flat rate for West Malaysia, one for East Malaysia.',
                 '送货 — 西马一个统一运费，东马一个。')}
            </span>
          </label>
          <label className="flex items-start gap-2 text-[14px] text-foreground">
            <Checkbox className="mt-1" checked={fields.expressEnabled} disabled={onlyMethod === 'express'} onCheckedChange={v => setFields(f => ({ ...f, expressEnabled: v === true }))} />
            <span>
              {t('Express delivery — a base fee plus a rate for every kilometre your rider drives.',
                 '快速配送 — 基本运费加上每公里费率。')}
            </span>
          </label>
          {fields.expressEnabled && !fields.originPlaceId && (
            <p className="text-[12px] text-primary leading-[1.5]">
              {t('Express delivery needs a delivery from address. Pick one below to save.',
                 '快速配送需要一个出发地址，请在下方选择后保存。')}
            </p>
          )}
          <p className="text-[12px] text-muted-foreground leading-[1.5]">
            {t('You must offer at least one. A method you switch off keeps its settings.',
               '至少须提供一种。关闭的方式会保留其设置。')}
          </p>
        </div>
      </div>

      <div className={CARD}>
        <h3 className={HEADING}>{t('Pickup address', '自取地址')}</h3>
        {/* Free text still lands in the same column — pickup is never routed, so there is no place
            id to store — this only gives the merchant Google's suggestions instead of a blank box. */}
        <AddressAutocomplete
          id="shop-pickup"
          t={t}
          label={t('Shown to customers who choose pickup', '选择自取的顾客可见')}
          value={fields.pickupAddress ?? ''}
          placeholder={t('Start typing your shop address…', '输入店铺地址…')}
          onTextChange={text => setFields(f => ({ ...f, pickupAddress: text }))}
          onPick={d => setFields(f => ({ ...f, pickupAddress: d.formatted }))}
        />
      </div>

      {/* Both rate cards can be on screen at once — a shop may post parcels at a flat rate AND run
          a rider by the kilometre. Each names the method whose fee it sets. */}
      {fields.deliveryEnabled && (
        <div className={CARD}>
          <h3 className={HEADING}>{t('Delivery rates', '送货费')}</h3>
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
              <p className="text-[12px] text-muted-foreground mt-1 leading-[1.5]">
                {t('Blank East Malaysia charges the same as West Malaysia. Enter 0 for free East Malaysia delivery.',
                   '东马留空则按西马运费收取。填 0 表示东马免运费。')}
              </p>
            </div>
          </div>
        </div>
      )}

      {fields.expressEnabled && (
      <div className={CARD}>
        <h3 className={HEADING}>{t('Express delivery from', '快速配送出发地')}</h3>
        <AddressAutocomplete
          id="shop-origin"
          t={t}
          label={t('Where your rider starts from', '骑手出发的地址')}
          value={fields.originAddress ?? ''}
          placeholder={t('Start typing your shop address…', '输入店铺地址…')}
          onTextChange={text => setFields(f => (
            // Typing invalidates any prior pick: a place id must never survive its own text
            // changing. It does NOT untick expressEnabled — the checkbox goes disabled the moment
            // the origin id is gone, and the backend/DB CHECK refuse a save of express with no origin.
            { ...f, originAddress: text, originPlaceId: '', originLat: '', originLng: '' }
          ))}
          onPick={d => setFields(f => ({
            ...f,
            originPlaceId: d.placeId,
            originAddress: d.formatted,
            originLat: String(d.lat),
            originLng: String(d.lng),
          }))}
        />
        {fields.originPlaceId && (
          <p className="text-[12px] text-muted-foreground mt-2 leading-[1.5]">
            {t('Routes are measured from: ', '距离从此地址起算：')}<strong>{fields.originAddress}</strong>
          </p>
        )}
        <p className="text-[12px] text-muted-foreground mt-2 leading-[1.5]">
          {t('This is separate from your pickup address above, which is free text and is only shown to pickup customers.',
             '此地址与上方的自取地址不同 — 自取地址是纯文字，仅显示给自取顾客。')}
        </p>
      </div>
      )}

      {fields.expressEnabled && (
        <div className={CARD}>
          <h3 className={HEADING}>{t('Express delivery rates', '快速配送费率')}</h3>
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="shop-base-fee">{t(`Base fee (${symbol})`, `基本运费 (${symbol})`)}</Label>
              <Input id="shop-base-fee" type="number" step="0.01" min="0" value={fields.baseFee}
                onChange={e => setFields(f => ({ ...f, baseFee: e.target.value }))} variant="compact" />
              <p className="text-[12px] text-muted-foreground leading-[1.5]">
                {t('Charged on every delivery, before distance. Enter 0 to charge purely per kilometre.',
                   '每单固定收取，与距离无关。填 0 则纯按公里收费。')}
              </p>
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="shop-rate-km">{t(`Per kilometre (${symbol})`, `每公里 (${symbol})`)}</Label>
              <Input id="shop-rate-km" type="number" step="0.01" min="0" value={fields.ratePerKm}
                onChange={e => setFields(f => ({ ...f, ratePerKm: e.target.value }))} variant="compact" />
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="shop-max-km">{t('Maximum distance (km)', '最远配送距离 (公里)')}</Label>
              <Input id="shop-max-km" type="number" step="0.1" min="0.1" value={fields.maxKm}
                onChange={e => setFields(f => ({ ...f, maxKm: e.target.value }))} variant="compact" />
              <p className="text-[12px] text-muted-foreground leading-[1.5]">
                {t('Leave blank to deliver anywhere with a road. Customers past this distance are told you do not deliver to them.',
                   '留空表示只要有路就送。超过此距离的顾客会被告知不在配送范围。')}
              </p>
            </div>
            <p className="text-[12px] text-muted-foreground leading-[1.5]">
              {t(`Example: ${symbol}${fields.baseFee || 0} + ${symbol}${fields.ratePerKm || 0}/km means a 10 km delivery costs ${symbol}${(Number(fields.baseFee || 0) + Number(fields.ratePerKm || 0) * 10).toFixed(2)}.`,
                 `例如：${symbol}${fields.baseFee || 0} + ${symbol}${fields.ratePerKm || 0}/公里，10 公里配送为 ${symbol}${(Number(fields.baseFee || 0) + Number(fields.ratePerKm || 0) * 10).toFixed(2)}。`)}
            </p>
          </div>
        </div>
      )}
      <SaveRow busy={busy} label={{ idle: t('Save', '保存'), busy: t('Saving…', '保存中…') }} />
    </form>
  )
}

function PaymentTab({ onDirtyChange }: TabProps) {
  const { t, merchant, refreshMerchant } = useSession()
  const [initial] = useState<SettingsFields>(() => {
    // shopTax, not a local `?? 0`: this form shows the merchant what their shop CHARGES, and the
    // charge is decided by that one function on both sides of the wire.
    const tax = shopTax(merchant!)
    return {
      currency: merchant!.currency ?? DEFAULT_CURRENCY,
      taxEnabled: tax.enabled,
      taxRate: tax.rate ? String(tax.rate) : '',
      bank: merchant!.payment_bank ?? '',
      note: merchant!.payment_note ?? '',
      qr: merchant!.payment_qr ?? '',
    }
  })
  const [fields, setFields] = useState<SettingsFields>(initial)
  const [busy, setBusy] = useState(false)
  // The QR path the shop's row currently holds — updated on every save, not read from `initial`,
  // which is the value at mount. The replaced object is deleted only AFTER the row that pointed
  // at it saved, so a failed save leaves a live QR live.
  const savedQr = useRef(initial.qr ?? '')
  const { commit } = useSaved(initial, fields, settingsEq, onDirtyChange)

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true)
    try {
      const saved = await updateMerchantConfig(merchant!.id, {
        // Currency is chosen at signup and never editable here — omitted from the payload.
        payment_bank: fields.bank,
        payment_note: fields.note,
        // '' is how this form says "no QR"; the backend reads it as null (writes.ts).
        payment_qr: fields.qr ?? '',
        // A blank rate box is 0, and 0 is "no tax" — the same collapse `shopTax` makes when it
        // reads the row back. The checkbox is stored as typed.
        tax_enabled: fields.taxEnabled,
        tax_rate: Number(fields.taxRate) || 0,
      })
      if (!saved.ok) { toast.error(saved.error.message || t('Save failed', '保存失败')); return }
      await refreshMerchant()
      // Tax goes through shopTax so a ticked-but-blank rate (`{tax_enabled: true, tax_rate: 0}`)
      // reads back as OFF — carrying `fields.taxEnabled` verbatim would show CHECKED here and
      // UNCHECKED after a refresh.
      const tax = shopTax({ tax_enabled: fields.taxEnabled, tax_rate: Number(fields.taxRate) || 0 })
      const applied = {
        ...fields,
        taxEnabled: tax.enabled,
        taxRate: tax.rate ? String(tax.rate) : '',
      }
      setFields(applied)
      commit(applied)
      // Best-effort cleanup of the object the row no longer points at, now that the row has
      // actually been written. Unawaited and swallowed: an orphaned image in Storage costs a few
      // kilobytes; a failed delete must never look like a failed save.
      const previous = savedQr.current
      savedQr.current = applied.qr ?? ''
      if (previous && previous !== savedQr.current) deletePaymentQr(previous).catch(() => {})
      toast.success(t('Payment saved', '付款已保存'))
    } catch (err: any) { toast.error(err.message || t('Save failed', '保存失败')) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={save}>
      <div className={CARD}>
        <h3 className={HEADING}>{t('Currency', '货币')}</h3>
        <div className="flex flex-col gap-[6px]">
          <Label htmlFor="shop-currency">{t('Base currency', '基础货币')}</Label>
          <Select value={fields.currency} onValueChange={() => {}} disabled>
            <SelectTrigger id="shop-currency" className="w-full max-w-[280px]" aria-label={t('Base currency', '基础货币')}>
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
          <p className="text-[12px] text-muted-foreground mt-1 leading-[1.5]">
            {t('The unit for your prices and what customers see. Chosen when you signed up.',
                '您的价格和顾客看到的金额单位。注册时选定。')}
          </p>
        </div>
      </div>
      <div className={CARD}>
        <h3 className={HEADING}>{t('Tax', '税')}</h3>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-[14px] text-foreground">
            <Checkbox checked={fields.taxEnabled} onCheckedChange={v => setFields(f => ({ ...f, taxEnabled: v === true }))} />
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
            <p className="text-[12px] text-muted-foreground mt-1 leading-[1.5]">
              {t('Added on top of your item prices, after any voucher discount. Delivery fees are not taxed. Leave blank, or enter 0, to turn tax off.',
                 '在商品价格之上加收，扣除优惠券后计算。运费不征税。留空或填 0 即可关闭税费。')}
            </p>
          </div>
        </div>
      </div>
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
          {/* #156. The image sits with the bank details it belongs to, not in its own tab: a
              customer reading the success screen sees one payment block, and the merchant
              should fill it in as one. */}
          <div className="flex flex-col gap-[6px]">
            <Label>{t('Payment QR (DuitNow, shown after checkout)', '付款二维码（DuitNow，下单后显示）')}</Label>
            <PaymentQrPicker
              merchantId={merchant!.id}
              value={fields.qr ?? ''}
              onChange={path => setFields(f => ({ ...f, qr: path }))}
              t={t}
            />
            <p className="text-[12px] text-muted-foreground leading-[1.5]">
              {t('A photo or screenshot of your DuitNow QR. Customers see it on the order-placed screen, so they can pay you straight away. PNG, JPG or WebP, up to 2MB. Remember to save.',
                 '您的 DuitNow 二维码照片或截图。顾客下单后会在确认页看到，可立即付款。支持 PNG、JPG、WebP，最大 2MB。请记得保存。')}
            </p>
          </div>
        </div>
      </div>
      <SaveRow busy={busy} label={{ idle: t('Save payment', '保存付款'), busy: t('Saving…', '保存中…') }} />
    </form>
  )
}

// Only ever rendered for a Pro shop — the gate is in ShopSettings above, alongside every other
// tab's mount, rather than hidden in a wrapper here.
// The shop's OWN advertising pixels (#220). The merchant is the data controller for this
// tracking, not TinyOrder — which is why the help text below reads as an obligation rather than a
// feature description, and why the Terms carry a clause about it.
//
// The two ids go through `updateMerchantConfig` like every other shop-config field. What makes
// them Pro is `pixelIdsChanged` at the route, not this form: a merchant whose plan moved under a
// long-open tab still meets a 403, which is the toast at the bottom of `save`.
function MarketingTab({ onDirtyChange }: TabProps) {
  const { t, merchant, refreshMerchant } = useSession()
  const [initial] = useState<SettingsFields>(() => ({
    metaPixel: merchant!.meta_pixel_id ?? '',
    tiktokPixel: merchant!.tiktok_pixel_id ?? '',
  }))
  const [fields, setFields] = useState<SettingsFields>(initial)
  const [busy, setBusy] = useState(false)
  const { commit } = useSaved(initial, fields, settingsEq, onDirtyChange)

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true)
    try {
      // Sent as typed, blanks included: '' is how this form says "take the pixel down", and the
      // backend reads it as null (writes.ts). Trimming and shape-checking happen there, once,
      // rather than in two places that can disagree.
      const saved = await updateMerchantConfig(merchant!.id, {
        meta_pixel_id: String(fields.metaPixel ?? ''),
        tiktok_pixel_id: String(fields.tiktokPixel ?? ''),
      })
      if (!saved.ok) {
        toast.error(saved.error.message || t('Save failed', '保存失败'))
        return
      }
      await refreshMerchant()
      commit(fields)
      toast.success(t('Marketing saved', '营销设置已保存'))
    } catch (err: any) { toast.error(err.message || t('Save failed', '保存失败')) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={save}>
      <div className={CARD}>
        <h3 className={HEADING}>{t('Your own ad pixel', '你自己的广告像素')}</h3>
        <p className="text-[12px] text-muted-foreground mb-4 leading-[1.5]">
          {t('Add your pixel and your shop page reports its own visits and orders straight to your ad account, so Facebook and TikTok can tell you which ads earned their money. Leave a box empty if you do not run ads there.',
             '填入像素后，你的店铺页面会把访问与订单直接汇报给你自己的广告账户，让 Facebook 与 TikTok 告诉你哪些广告真的赚钱。没有投放的平台留空即可。')}
        </p>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-meta-pixel">{t('Meta (Facebook) pixel ID', 'Meta（Facebook）像素 ID')}</Label>
            <Input
              id="shop-meta-pixel"
              value={String(fields.metaPixel ?? '')}
              onChange={e => setFields(f => ({ ...f, metaPixel: e.target.value }))}
              placeholder="123456789012345"
              inputMode="numeric"
              variant="compact"
            />
            <p className="text-[12px] text-muted-foreground mt-1 leading-[1.5]">
              {t('A 15- or 16-digit number from Events Manager → Data sources. Not your ad account number.',
                 '来自事件管理工具 → 数据源的 15 或 16 位数字。不是广告账户号码。')}
            </p>
          </div>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-tiktok-pixel">{t('TikTok pixel ID', 'TikTok 像素 ID')}</Label>
            <Input
              id="shop-tiktok-pixel"
              value={String(fields.tiktokPixel ?? '')}
              onChange={e => setFields(f => ({ ...f, tiktokPixel: e.target.value }))}
              placeholder="CQ1234567890ABCDEFGH"
              variant="compact"
            />
            <p className="text-[12px] text-muted-foreground mt-1 leading-[1.5]">
              {t('20 letters and digits from TikTok Ads Manager → Assets → Events.',
                 '来自 TikTok 广告管理工具 → 资产 → 事件的 20 位字母数字。')}
            </p>
          </div>
        </div>
      </div>
      {/* Said BEFORE the merchant saves, and said plainly. Both costs are real, both are theirs,
          and a merchant who meets the cookie banner for the first time as a complaint from a
          customer was not told. The wording is the Terms clause in the merchant's own language —
          see src/legal/documents.ts. */}
      <div className={CARD}>
        <h3 className={HEADING}>{t('Before you switch this on', '开启前请注意')}</h3>
        <ul className="flex flex-col gap-2 text-[13px] text-muted-foreground leading-[1.6] list-disc pl-4">
          <li>
            {t('Your customers get a cookie question on your shop page, and nothing is tracked unless they agree. That is a step in front of your own checkout.',
               '你的顾客会在店铺页面看到 Cookie 询问，只有同意后才会跟踪。这会在你的结账流程前多出一步。')}
          </li>
          <li>
            {t('The tracking is yours, not TinyOrder’s. You are responsible for telling your customers about it and for the ad platform’s own rules.',
               '这项跟踪属于你，不属于 TinyOrder。你需要自行告知顾客，并遵守广告平台的规则。')}
          </li>
          <li>
            {t('We cannot tell a wrong ID from a right one. Place a test order and check it arrives in Events Manager.',
               '我们无法分辨 ID 是否正确。请下一笔测试订单，并到事件管理工具确认已收到。')}
          </li>
        </ul>
      </div>
      <SaveRow busy={busy} label={{ idle: t('Save marketing', '保存营销设置'), busy: t('Saving…', '保存中…') }} />
    </form>
  )
}

function NotificationsTab({ onDirtyChange }: TabProps) {
  const { t, merchant } = useSession()
  const initial: SettingsFields = { tgToken: '', tgChat: '' }
  const [fields, setFields] = useState<SettingsFields>(initial)
  const [busy, setBusy] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const loaded = useRef(false)
  const { commit } = useSaved(initial, fields, settingsEq, onDirtyChange)

  useEffect(() => {
    fetchMerchantSecret(merchant!.id).then((r) => {
      const s = r.ok ? r.data : null
      const v = { tgToken: s?.tg_token ?? '', tgChat: s?.tg_chat_id ?? '' }
      commit(v)
      // Only overwrite in-flight edits if the user hasn't started typing yet.
      if (!loaded.current) setFields(v)
      loaded.current = true
    })
    // `commit` is a stable useState setter; listed only to satisfy exhaustive-deps.
  }, [merchant!.id, commit])

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true)
    const r = await upsertMerchantSecret(merchant!.id, { tg_token: fields.tgToken, tg_chat_id: fields.tgChat })
    if (r.ok) {
      commit(fields)
      toast.success(t('Notifications saved', '通知已保存'))
    } else {
      toast.error(r.error.message || t('Save failed', '保存失败'))
    }
    setBusy(false)
  }

  return (
    <form onSubmit={save}>
      <div className={CARD}>
        <h3 className={HEADING}>{t('Order notifications', '订单通知')}</h3>
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] font-medium text-primary uppercase tracking-[0.09em]">Telegram</p>
          <Button
            type="button"
            variant="link"
            size="none"
            onClick={() => setGuideOpen(true)}
            className="text-[12px] font-medium hover:text-foreground"
          >
            {t('How to set this up', '如何设置')}
          </Button>
        </div>
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
      <TelegramSetupGuide open={guideOpen} onOpenChange={setGuideOpen} />
    </form>
  )
}

// Stylized mockup of the BotFather reply, so a merchant recognizes the real chat by shape
// rather than reading step 2's instruction cold. Placeholder token — not a real leaked one.
function BotFatherMockup() {
  return (
    <svg viewBox="0 0 400 92" className="w-full h-auto" role="img" aria-hidden="true">
      <rect x="0" y="0" width="400" height="92" rx="10" className="fill-muted" />
      <circle cx="24" cy="24" r="12" className="fill-primary/20" />
      <text x="44" y="21" className="fill-primary text-[11px] font-medium" style={{ fontFamily: 'inherit' }}>BotFather</text>
      <rect x="44" y="30" width="330" height="46" rx="10" className="fill-card stroke-border" strokeWidth="1.5" />
      <text x="56" y="48" className="fill-foreground text-[10px]" style={{ fontFamily: 'inherit' }}>Done! Use this token to access the HTTP API:</text>
      <rect x="56" y="55" width="228" height="15" rx="4" className="fill-primary/10" />
      <text x="62" y="65.5" className="fill-primary text-[10px] font-mono font-medium">123456789:AAHexampleToken_9x2K</text>
    </svg>
  )
}

// Stylized mockup of the `getUpdates` JSON, highlighting the one field ("chat":{"id":…})
// that matters — a merchant scanning raw JSON for the first time won't know to look for it.
function GetUpdatesMockup() {
  return (
    <svg viewBox="0 0 400 108" className="w-full h-auto" role="img" aria-hidden="true">
      <rect x="0" y="0" width="400" height="108" rx="10" className="fill-foreground" />
      <circle cx="16" cy="16" r="4" className="fill-background/30" />
      <circle cx="30" cy="16" r="4" className="fill-background/30" />
      <circle cx="44" cy="16" r="4" className="fill-background/30" />
      <text x="16" y="38" className="fill-background/70 text-[10px] font-mono">{'{"result":[{"message":{'}</text>
      <text x="16" y="54" className="fill-background/70 text-[10px] font-mono">{'  "text":"hi","'}</text>
      <rect x="16" y="60" width="176" height="17" rx="4" className="fill-muted-foreground/40" />
      <text x="22" y="72.5" className="fill-background text-[10px] font-mono font-medium">{'"chat":{"id":987654321,…}'}</text>
      <text x="16" y="94" className="fill-background/70 text-[10px] font-mono">{'}}]}'}</text>
    </svg>
  )
}

// Static how-to: creating a Telegram bot and finding the token/chat id it takes to fill in
// the two fields above. No backend call — Telegram's own APIs are what surface both values,
// and `getUpdates` is the simplest route to a chat id without a second bot in the loop.
// The two mockups are illustrative, not screenshots (Telegram's actual UI isn't ours to
// ship pixel-for-pixel) — they exist so a merchant recognizes the real chat/response by
// shape, not because the exact rendering matters.
function TelegramSetupGuide({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useSession()
  const stepClass = 'flex gap-3'
  const numClass = 'shrink-0 w-5 h-5 rounded-pill bg-primary text-primary-foreground text-[11px] font-medium flex items-center justify-center'
  const textClass = 'text-[13px] text-foreground leading-[1.5]'
  const mockupWrapClass = 'ml-8 rounded-lg overflow-hidden border-[0.5px] border-border -mt-1'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('Set up Telegram notifications', '设置 Telegram 通知')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className={stepClass}>
            <span className={numClass}>1</span>
            <p className={textClass}>
              {t('In Telegram, open a chat with ', '在 Telegram 中，打开与 ')}
              <a href="https://t.me/BotFather" target="_blank" rel="noopener" className="underline underline-offset-2 font-medium text-primary">@BotFather</a>
              {t(' and send /newbot. Follow the prompts to name your bot.',
                ' 的对话并发送 /newbot，按提示为机器人命名。')}
            </p>
          </div>
          <div className={stepClass}>
            <span className={numClass}>2</span>
            <p className={textClass}>
              {t('BotFather replies with a token — copy it into "Bot token" below.',
                'BotFather 会回复一个令牌 — 复制到下方"机器人令牌"字段。')}
            </p>
          </div>
          <div className={mockupWrapClass}><BotFatherMockup /></div>
          <div className={stepClass}>
            <span className={numClass}>3</span>
            <p className={textClass}>
              {t('Add your new bot to the Telegram group or DM where you want order alerts, and send it any message there.',
                '把新机器人加入您想接收订单通知的 Telegram 群组或私聊，并在那里发送任意一条消息。')}
            </p>
          </div>
          <div className={stepClass}>
            <span className={numClass}>4</span>
            <p className={textClass}>
              {t('Then open this URL in a browser, with your token in place of <TOKEN>:',
                '然后在浏览器打开以下链接，把 <TOKEN> 换成您的令牌：')}
            </p>
          </div>
          <p className="font-mono text-[12px] break-all rounded-lg border-[0.5px] border-border bg-muted px-3 py-2 text-foreground -mt-2 ml-8">
            https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates
          </p>
          <div className={stepClass}>
            <span className={numClass}>5</span>
            <p className={textClass}>
              {t('Find "chat":{"id": ...} in the reply and copy that number into "Chat ID" below.',
                '在返回内容中找到 "chat":{"id": ...}，把该数字复制到下方"聊天 ID"字段。')}
            </p>
          </div>
          <div className={mockupWrapClass}><GetUpdatesMockup /></div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
