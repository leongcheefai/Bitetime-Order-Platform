# Shop Settings Regroup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Currency and Tax out of the Shipping tab into the Payment tab, and reorder the Shipping tab method-first, so each settings tab does one job.

**Architecture:** Pure relocation of JSX cards + their form state between two sibling components in one file (`ShopSettings.tsx`). Currency + Tax state and save logic move from `ShippingTab` into `PaymentTab`. Shipping's rate-label currency symbol switches from the live `fields.currency` to the saved `merchant.currency`. No backend, schema, shared-package, or copy changes.

**Tech Stack:** React 19 + TypeScript, Vite, Tailwind, Vitest.

## Global Constraints

- Single file touched: `apps/frontend/src/merchant/ShopSettings.tsx`. No other file changes.
- No backend / SQL / `@bitetime/shared` changes. No `settingsDirty.ts` change.
- No copy changes — card headings, labels, hints, and toasts move verbatim.
- No change to which cards are conditional: Delivery rates stay gated on `deliveryEnabled`, Express rates on `expressEnabled`; Pickup address and Delivery origin stay always-rendered.
- Currency lock rule preserved: currency persists only when `!currencyLocked`; `currencyLocked` starts `true` and clears via `merchantHasOrders(merchant.id)`.
- Tax read/write-back must stay routed through `shopTax` so a blank/0 rate reads back as unticked.
- Dirty invariant: every boolean key (`taxEnabled`) must be present in BOTH `saved` and `fields` from init on whichever tab owns it, or `isDirty` false-fires.

**Task order:** Task 1 (add to Payment) before Task 2 (strip from Shipping). Between the two, Currency/Tax appear on BOTH tabs — a harmless, functional duplicate that Task 2 resolves. Doing Task 2 first would lose the cards entirely mid-flight.

---

### Task 1: Move Currency + Tax into PaymentTab

**Files:**
- Modify: `apps/frontend/src/merchant/ShopSettings.tsx` — replace the whole `PaymentTab` function (currently ~544–585).

**Interfaces:**
- Consumes (all already imported at file top, module-level — no new imports): `shopTax`, `updateMerchantConfig`, `merchantHasOrders`, `CURRENCIES`, `CURRENCY_CODES`, `DEFAULT_CURRENCY`, `currencyDef`, `useTabDirty`, `SaveRow`, `CARD`, `HEADING`, `Select`/`SelectContent`/`SelectItem`/`SelectTrigger`, `Input`, `Label`, `useSession`, `toast`.
- Produces: none consumed by other tasks (sibling component).

- [ ] **Step 1: Replace the `PaymentTab` function**

Replace the entire existing `PaymentTab` (from `function PaymentTab({ onDirtyChange }: TabProps) {` through its closing `}` before `NotificationsTab`) with:

```tsx
function PaymentTab({ onDirtyChange }: TabProps) {
  const { t, merchant, refreshMerchant } = useSession()
  const [saved, setSaved] = useState<SettingsFields>(() => {
    // shopTax, not a local `?? 0`: this form shows the merchant what their shop CHARGES, and the
    // charge is decided by that one function on both sides of the wire.
    const tax = shopTax(merchant!)
    return {
      currency: merchant!.currency ?? DEFAULT_CURRENCY,
      taxEnabled: tax.enabled,
      taxRate: tax.rate ? String(tax.rate) : '',
      bank: merchant!.payment_bank ?? '',
      note: merchant!.payment_note ?? '',
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

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true)
    try {
      await updateMerchantConfig(merchant!.id, {
        // Guard against a stale locked value slipping through: only persist the
        // currency when it is still editable.
        ...(currencyLocked ? {} : { currency: fields.currency }),
        payment_bank: fields.bank,
        payment_note: fields.note,
        // A blank rate box is 0, and 0 is "no tax" — the same collapse `shopTax` makes when it
        // reads the row back. The checkbox is stored as typed.
        tax_enabled: fields.taxEnabled,
        tax_rate: Number(fields.taxRate) || 0,
      })
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
      setSaved(applied)
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
          <Select
            value={fields.currency}
            onValueChange={(v) => setFields(f => ({ ...f, currency: v }))}
            disabled={currencyLocked}
          >
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
            <p className="text-[12px] text-rose-muted mt-1 leading-[1.5]">
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
        </div>
      </div>
      <SaveRow busy={busy} label={{ idle: t('Save payment', '保存付款'), busy: t('Saving…', '保存中…') }} />
    </form>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS, no errors. (`taxEnabled`/`taxRate`/`currency` are all in `SettingsFields`; `updateMerchantConfig`'s config arg already accepted these exact shapes from ShippingTab.)

- [ ] **Step 3: Frontend unit tests still green**

Run: `pnpm --filter @bitetime/frontend test`
Expected: PASS (no test targets this JSX; confirms nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/merchant/ShopSettings.tsx
git commit -m "feat(settings): add currency + tax to Payment tab"
```

Note: at this point Currency/Tax also still show on Shipping (duplicate) — resolved in Task 2.

---

### Task 2: Strip Currency + Tax from ShippingTab and reorder method-first

**Files:**
- Modify: `apps/frontend/src/merchant/ShopSettings.tsx` — replace the whole `ShippingTab` function (currently ~117–542).

**Interfaces:**
- Consumes: `shopRates`, `shopDistance`, `shopMethods`, `currencyDef`, `DEFAULT_CURRENCY`, `updateMerchantConfig`, `refreshMerchant`, `AddressAutocomplete`, `useTabDirty`, `SaveRow`, `CARD`, `HEADING` — all already imported. Drops use of `shopTax`, `merchantHasOrders`, `CURRENCIES`, `CURRENCY_CODES`, `Select*` **within this function** (still imported at top for PaymentTab — do NOT remove imports).
- Produces: none.

- [ ] **Step 1: Replace the `ShippingTab` function**

Replace the entire existing `ShippingTab` (from `function ShippingTab({ onDirtyChange }: TabProps) {` through its closing `}` before `function PaymentTab`) with:

```tsx
function ShippingTab({ onDirtyChange }: TabProps) {
  const { t, merchant, refreshMerchant } = useSession()
  const [saved, setSaved] = useState<ShippingFields>(() => {
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
  const [fields, setFields] = useState<ShippingFields>(saved)
  const [busy, setBusy] = useState(false)
  useTabDirty(saved, fields, onDirtyChange)

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
          'Pick your delivery origin from the suggestions — a typed address on its own cannot be saved.',
          '请从建议列表中选择配送起点 — 仅输入文字无法保存。'
        ))
        setBusy(false)
        return
      }

      // Express requires an origin to route from. Backend CHECK is the backstop; this names the
      // rule in the merchant's language while they still see the form.
      if (fields.expressEnabled && !fields.originPlaceId) {
        toast.error(t(
          'Set your delivery origin before switching on express delivery.',
          '请先设置配送起点，才能开启快速配送。'
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

      // shopRates writes what it reads on both sides of the wire: a BLANK EM falls back to WM
      // (not free EM shipping); a typed 0 is an honest zero.
      const shipping = shopRates({ WM: fields.wm, EM: fields.em })
      await updateMerchantConfig(merchant!.id, {
        shipping,
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
      setSaved(applied)
      toast.success(t('Settings saved', '设置已保存'))
    } catch (err: any) { toast.error(err.message || t('Save failed', '保存失败')) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={save}>
      <div className={CARD}>
        <h3 className={HEADING}>{t('What customers can choose', '顾客可选的方式')}</h3>
        <div className="flex flex-col gap-2">
          <label className="flex items-start gap-2 text-[14px] text-ink">
            <input type="checkbox" className="mt-1"
              checked={fields.pickupEnabled}
              disabled={onlyMethod === 'pickup'}
              onChange={e => setFields(f => ({ ...f, pickupEnabled: e.target.checked }))} />
            <span>{t('Pickup — customers collect from you.', '自取 — 顾客自行前来领取。')}</span>
          </label>
          <label className="flex items-start gap-2 text-[14px] text-ink">
            <input type="checkbox" className="mt-1"
              checked={fields.deliveryEnabled}
              disabled={onlyMethod === 'delivery'}
              onChange={e => setFields(f => ({ ...f, deliveryEnabled: e.target.checked }))} />
            <span>
              {t('Delivery — one flat rate for West Malaysia, one for East Malaysia.',
                 '送货 — 西马一个统一运费，东马一个。')}
            </span>
          </label>
          <label className="flex items-start gap-2 text-[14px] text-ink">
            <input type="checkbox" className="mt-1"
              checked={fields.expressEnabled}
              disabled={onlyMethod === 'express'}
              onChange={e => setFields(f => ({ ...f, expressEnabled: e.target.checked }))} />
            <span>
              {t('Express delivery — a base fee plus a rate for every kilometre your rider drives.',
                 '快速配送 — 基本运费加上每公里费率。')}
            </span>
          </label>
          {fields.expressEnabled && !fields.originPlaceId && (
            <p className="text-[12px] text-oxblood leading-[1.5]">
              {t('Express delivery needs a delivery origin. Pick one below to save.',
                 '快速配送需要一个配送起点，请在下方选择后保存。')}
            </p>
          )}
          <p className="text-[12px] text-rose-muted leading-[1.5]">
            {t('You must offer at least one. A method you switch off keeps its settings.',
               '至少须提供一种。关闭的方式会保留其设置。')}
          </p>
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

      <div className={CARD}>
        <h3 className={HEADING}>{t('Delivery origin', '配送起点')}</h3>
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
          <p className="text-[12px] text-rose-muted mt-2 leading-[1.5]">
            {t('Routes are measured from: ', '距离从此地址起算：')}<strong>{fields.originAddress}</strong>
          </p>
        )}
        <p className="text-[12px] text-rose-muted mt-2 leading-[1.5]">
          {t('This is separate from your pickup address above, which is free text and is only shown to pickup customers.',
             '此地址与上方的自取地址不同 — 自取地址是纯文字，仅显示给自取顾客。')}
        </p>
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
              <p className="text-[12px] text-rose-muted mt-1 leading-[1.5]">
                {t('Blank East Malaysia charges the same as West Malaysia. Enter 0 for free East Malaysia delivery.',
                   '东马留空则按西马运费收取。填 0 表示东马免运费。')}
              </p>
            </div>
          </div>
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
              <p className="text-[12px] text-rose-muted leading-[1.5]">
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
              <p className="text-[12px] text-rose-muted leading-[1.5]">
                {t('Leave blank to deliver anywhere with a road. Customers past this distance are told you do not deliver to them.',
                   '留空表示只要有路就送。超过此距离的顾客会被告知不在配送范围。')}
              </p>
            </div>
            <p className="text-[12px] text-rose-muted leading-[1.5]">
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
```

Note the one copy change forced by the reorder: the Delivery-origin footnote now says "your pickup address **above**" (was "below"), because Pickup address now renders before Delivery origin. This is a directional-reference fix, not a wording change.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. `ShippingFields` still declares `currency`/`taxEnabled`/`taxRate` as optional (inherited from `SettingsFields`) — leaving them unpopulated is valid; no type edit needed.

- [ ] **Step 3: Confirm imports still all used (no unused-import lint error)**

Run: `pnpm lint`
Expected: PASS. `shopTax`, `merchantHasOrders`, `CURRENCIES`, `CURRENCY_CODES`, `Select*` are still used by `PaymentTab`, so the shared imports at the top of the file stay live.

- [ ] **Step 4: Frontend unit tests still green**

Run: `pnpm --filter @bitetime/frontend test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/ShopSettings.tsx
git commit -m "feat(settings): make Shipping tab method-first, drop currency + tax"
```

---

### Task 3: Run-and-verify the reorganised settings

**Files:** none (verification only).

- [ ] **Step 1: Run the app end-to-end**

Use the `verify` skill (per CLAUDE.md, UI is verified by running the app). Sign in as a merchant, open Shop Settings, and confirm:

1. **Shipping tab** card order top→bottom: *What customers can choose* → *Pickup address* → *Delivery origin* → (*Delivery rates* if delivery on) → (*Express delivery rates* if express on). No Currency card, no Tax card.
2. **Payment tab** card order: *Currency* → *Tax* → *Payment* (bank/note).
3. Currency select is **disabled** when the shop has orders, enabled otherwise.
4. Payment tab: tick Tax, enter a rate, Save → reload → rate persists, checkbox stays ticked. Then blank the rate, Save → reload → checkbox reads **unticked** (shopTax collapse).
5. Payment tab (shop with no orders): change currency, Save → reload → new currency shown; Shipping tab rate labels show the **new** currency symbol.
6. Shipping tab: change a delivery rate / toggle a method / edit origin, Save → reload → persists.
7. Dirty guard: dirty a field on Shipping, click Payment tab → blocked with the unsaved warning. Same the other way.

- [ ] **Step 2: Final full checks**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @bitetime/frontend test`
Expected: all PASS.

---

## Self-Review

**Spec coverage:**
- Shipping → pure fulfilment, method-first, drops currency/tax → Task 2. ✓
- Payment → Currency + Tax + Bank/note → Task 1. ✓
- Symbol reads saved `merchant.currency` → Task 2, `symbol` line. ✓
- Currency lock logic preserved → Task 1, `currencyLocked` + effect. ✓
- Tax via `shopTax` write-back → Task 1, `save`. ✓
- No `settingsDirty.ts` change; boolean-key-present invariant → Task 1 inits `taxEnabled` in both snapshots. ✓
- Conditional visibility unchanged (rates gated, origin/pickup always shown) → Task 2 JSX. ✓
- No tab rename → Task 1 keeps "Payment"/"付款". ✓
- Verification via run-app → Task 3. ✓

**Placeholder scan:** none — every step has full code or an exact command.

**Type consistency:** `currency`/`taxEnabled`/`taxRate`/`bank`/`note` all in `SettingsFields`. `ShippingFields = SettingsFields & {...distance keys}`. `shopTax`/`shopRates`/`shopDistance`/`shopMethods` signatures match existing usage (copied verbatim from the current working code). No new symbols introduced.

**One deliberate copy edit:** Delivery-origin footnote "below" → "above" (Task 2), because Pickup address now precedes Delivery origin. Flagged in-task.
