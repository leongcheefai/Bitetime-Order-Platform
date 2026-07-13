import { useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Link } from 'react-router-dom'
import { useMerchant } from '../MerchantContext'
import { useSession } from '../SessionContext'
import { usePageVariants } from '../motion'
import { toast } from 'sonner'
import { fetchProducts, placeOrder, fetchMerchantVoucher, redeemVoucher, voucherFullyUsed, notifyOrderPlacedRemote, productImageUrl, saveCustomerDetails } from '../store'
import { priceOrder, voucherError } from '../pricing'
import { prefillFromProfile, savedDetailsFromOrder } from '../savedDetails'
import { formatMoney } from '../currency'
import { formatUnit } from '../productUnit'
import { lookupPostcode } from '../postcodes'
import { MY_STATES } from '../states-my'
import type { Product, Voucher, AddressParts } from '../types'
import LanguageSelect from '../components/LanguageSelect'
import ImageLightbox from '../components/ImageLightbox'
import SignInDialog from './SignInDialog'
import CheckoutGate, { GuestStrip } from './CheckoutGate'
import { checkoutStep, readGuestChoice, rememberGuestChoice } from '../checkoutGate'
import { cn } from '@/lib/utils'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'

const EMPTY_ADDRESS: AddressParts = { line1: '', postcode: '', city: '', state: '' }

interface CartLine {
  id: string
  name: string
  qty: number
  price: number
}

interface SuccessState {
  orderNumber: string
  items: CartLine[]
  subtotal: number
  fee: number
  discount: number
  total: number
}

export default function Storefront() {
  const { merchant: merchantNullable } = useMerchant()
  const merchant = merchantNullable as NonNullable<typeof merchantNullable>
  const { lang, t, account, profile, refreshProfile } = useSession()
  const viewVariants = usePageVariants()

  const [products, setProducts] = useState<Product[]>([])
  const [cart, setCart] = useState<Record<string, number>>({})        // { [productId]: qty }
  const [mode, setMode] = useState<'pickup' | 'delivery'>('pickup')  // 'pickup' | 'delivery'

  // Prefill is DERIVED, never copied into state by an effect. `null` means "the customer hasn't
  // touched this field", so a profile that arrives a beat after the page fills the form — while a
  // profile that arrives after they started typing cannot overwrite them. Typing wins, always,
  // which is also what keeps a prefilled field editable.
  const prefill = useMemo(() => prefillFromProfile(profile), [profile])
  const [nameInput, setNameInput] = useState<string | null>(null)
  const [waInput, setWaInput] = useState<string | null>(null)
  // Only the fields actually TOUCHED, not a whole replacement address. The profile resolves a beat
  // after the session does, and the form is live in that beat: holding a full address here would
  // mean one keystroke in `line1` froze all four fields at blank, because the object would already
  // be non-null when the saved address finally landed. Per field, typing wins — not per object.
  const [addressInput, setAddressInput] = useState<Partial<AddressParts> | null>(null)
  const name = nameInput ?? prefill.name ?? ''
  const wa = waInput ?? prefill.wa ?? ''
  const address = useMemo<AddressParts>(
    () => ({ ...EMPTY_ADDRESS, ...prefill.address, ...addressInput }),
    [prefill.address, addressInput],
  )
  // A functional updater, so the async postcode lookup cannot clobber a keystroke that landed
  // while it was in flight.
  const patchAddress = (patch: Partial<AddressParts>) => setAddressInput(prev => ({ ...prev, ...patch }))

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<SuccessState | null>(null)

  const [gallery, setGallery] = useState<Product | null>(null)
  const [signInOpen, setSignInOpen] = useState(false)

  const [voucherInput, setVoucherInput] = useState('')
  const [appliedVoucher, setAppliedVoucher] = useState<Voucher | null>(null)
  const [voucherMsg, setVoucherMsg] = useState('')
  const [voucherBusy, setVoucherBusy] = useState(false)

  const merchantId = merchant?.id
  const currency = merchant?.currency
  const slug = merchant?.slug

  useEffect(() => {
    if (!merchantId) return
    fetchProducts(merchantId).then(setProducts)
  }, [merchantId])

  // The guest choice is remembered per shop, so the gate is met once here and never again —
  // and a choice made at another shop cannot silence it at this one. `chosenAt` carries the
  // slug rather than a bare flag: this component can be reused across shops, and a bare flag
  // would follow the customer to the next storefront and swallow its gate.
  const [chosenAt, setChosenAt] = useState<string | null>(null)
  const guestRemembered = useMemo(() => (slug ? readGuestChoice(slug) : false), [slug])
  const guestChosen = guestRemembered || (!!slug && chosenAt === slug)
  const chooseGuest = () => {
    if (!slug) return
    rememberGuestChoice(slug)
    setChosenAt(slug)
  }

  const onPostcodeChange = async (raw: string) => {
    const pc = raw.replace(/\D/g, '').slice(0, 5)
    patchAddress({ postcode: pc })
    if (pc.length === 5) {
      const hit = await lookupPostcode(pc)
      if (hit) patchAddress({ postcode: pc, city: hit.city, state: hit.state })
    }
  }

  const activeProducts = products.filter(p => p.active)
  const rateWM = merchant?.shipping?.WM ?? 8
  const rateEM = merchant?.shipping?.EM ?? rateWM
  const baseDeliveryFee = rateWM // shown on the Delivery toggle before a state is known
  // One-per-customer identity: account email when signed in, else the WhatsApp number.
  const voucherEntry = (account?.email || wa || '').trim().toLowerCase()

  const productName = (p: Product) =>
    (lang === 'zh' && p.name_zh) ? p.name_zh : p.name
  const productDescr = (p: Product) =>
    (lang === 'zh' && p.descr_zh) ? p.descr_zh : (p.descr || '')

  // One pricing breakdown drives the summary, the order, and the success view.
  const bd = priceOrder({
    products: activeProducts,
    cart,
    mode,
    state: mode === 'delivery' ? address.state : null,
    rates: { WM: rateWM, EM: rateEM },
    // Before a state is resolved, show the WM base estimate so the summary
    // matches the Delivery toggle instead of flashing RM 0.00; once the
    // postcode fills the state, region logic (WM/EM) takes over.
    resolvedShipping: mode === 'delivery' && !address.state ? baseDeliveryFee : undefined,
    voucher: appliedVoucher,
  })
  const cartItems: CartLine[] = bd.lines.map(l => ({ id: l.id, name: l.name, qty: l.qty, price: l.unitPrice }))
  const subtotal = bd.subtotal
  const discount = bd.discount
  const total = bd.total
  const fee = bd.shipping
  const deliveryReady =
    mode !== 'delivery' ||
    (address.line1.trim() !== '' &&
      address.postcode.length === 5 &&
      address.city.trim() !== '' &&
      address.state.trim() !== '')
  const canSubmit = cartItems.length > 0 && name.trim() !== '' && wa.trim() !== '' && !busy && deliveryReady

  // The one decision that says whether this customer is ever asked to sign in. `account` is
  // `undefined` until the session resolves — 'pending' holds the checkout back for that beat
  // so a signed-in customer never sees the gate flash.
  const step = checkoutStep({ sessionLoading: account === undefined, signedIn: !!account, guestChosen })

  const applyVoucher = async () => {
    const code = voucherInput.trim().toUpperCase()
    if (!code) return
    // A voucher is tracked one-per-customer by WhatsApp/email; without one the
    // redemption can't be attributed and the server rejects it. Ask up front.
    if (!voucherEntry) {
      setAppliedVoucher(null)
      setVoucherMsg(t('❌ Enter your WhatsApp number before applying a voucher.', '❌ 请先填写 WhatsApp 号码再使用优惠券。'))
      return
    }
    // Validate against fresh DB state, not a page-load snapshot — otherwise a
    // customer who already redeemed this code (even earlier in this session)
    // sees a false "applied" that only fails at Place Order. Catch reuse here.
    setVoucherBusy(true)
    setVoucherMsg(t('Checking voucher…', '验证优惠券…'))
    const v = await fetchMerchantVoucher(merchant.id, code)
    setVoucherBusy(false)
    const err = voucherError(v, {
      subtotal: bd.subtotal + bd.shipping,
      userEmail: voucherEntry,
      now: new Date(),
      fullyUsed: v ? voucherFullyUsed(v) : true,
    })
    if (err || !v) {
      setAppliedVoucher(null)
      setVoucherMsg(voucherErrorText(err ?? 'invalid', v))
      return
    }
    setAppliedVoucher(v)
    const label = (v as any).type === 'percent' ? `${(v as any).value}% off` : `${formatMoney((v as any).value, currency)} off`
    setVoucherMsg(t(`✓ Voucher applied: ${label}`, `✓ 优惠券已应用：${label}`))
  }

  const removeVoucher = () => {
    setAppliedVoucher(null)
    setVoucherInput('')
    setVoucherMsg('')
  }

  function voucherErrorText(code: string, v?: Voucher | null): string {
    switch (code) {
      case 'invalid': return t('❌ Invalid voucher code.', '❌ 无效的优惠码。')
      case 'fully_used': return t('❌ This voucher has been fully redeemed.', '❌ 此优惠券已用完。')
      case 'already_used': return t('❌ You have already used this voucher.', '❌ 您已使用过此优惠券。')
      case 'not_assigned': return t('❌ This voucher is not assigned to your account.', '❌ 此优惠券不属于您的账户。')
      case 'expired': return t('❌ This voucher has expired.', '❌ 此优惠券已过期。')
      case 'min_order': return t(`❌ Minimum order of ${formatMoney((v as any)?.minOrder, currency)} required.`, `❌ 需要最低消费 ${formatMoney((v as any)?.minOrder, currency)}。`)
      default: return ''
    }
  }

  const updateQty = (productId: string, delta: number) => {
    setCart(prev => {
      const next = Math.max(0, (prev[productId] || 0) + delta)
      if (next === 0) {
        const { [productId]: _removed, ...rest } = prev
        return rest
      }
      return { ...prev, [productId]: next }
    })
  }

  const handleSubmit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      // Re-validate the voucher against fresh DB state, not the page-load
      // snapshot — that snapshot never reflects this session's own redemption,
      // so a customer could otherwise re-apply and be granted the discount again
      // while used_by stayed at 1. On a fetch miss, fall through to the RPC guard.
      if (appliedVoucher) {
        const fresh = await fetchMerchantVoucher(merchant.id, appliedVoucher.code)
        if (fresh) {
          const verr = voucherError(fresh, {
            subtotal: bd.subtotal + bd.shipping,
            userEmail: voucherEntry,
            now: new Date(),
            fullyUsed: voucherFullyUsed(fresh),
          })
          if (verr) {
            setAppliedVoucher(null)
            setVoucherMsg(voucherErrorText(verr, fresh))
            setError(voucherErrorText(verr, fresh))
            return
          }
        }
      }
      // On a storefront every signed-in user is a customer, whatever role they hold elsewhere:
      // a shop owner buying lunch here is a customer, and a merchant ordering from their *own*
      // storefront gets the order attributed to themselves. That looks like a bug and isn't —
      // they can already read it as the owner.
      const result = await placeOrder({
        merchantId: merchant.id,
        customerName: name.trim(),
        customerWa: wa.trim(),
        mode,
        address: mode === 'delivery' ? address : '',
        shippingFee: fee,
        items: cartItems,
        total,
        currency,
        discount,
        voucherCode: appliedVoucher?.code ?? null,
      })
      if (appliedVoucher) {
        // Best-effort: failure to record usage must not fail a placed order.
        await redeemVoucher(merchant.id, appliedVoucher.code, voucherEntry).catch(() => {})
      }
      // Remember what they typed, silently, so they never type it again — at this shop or any
      // other. Best-effort and unawaited: the order is already placed, and a profile write that
      // fails must cost the customer a retype next time, never their order. A guest saves nothing
      // (`saveCustomerDetails` checks the session itself), which is what keeps the gate honest.
      if (account) {
        saveCustomerDetails(savedDetailsFromOrder({ mode, wa, address }))
          .then(refreshProfile) // so a second order in this same session prefills too
          .catch(() => {})
      }
      // Best-effort server-side Telegram notify; never blocks a placed order.
      await notifyOrderPlacedRemote(merchant.id, result.orderNumber).catch(() => {})
      setSuccess({ orderNumber: result.orderNumber, items: cartItems, subtotal, fee, discount, total })
      toast.success(t('Order placed!', '订单已提交！'))
    } catch (err: any) {
      setError(err.message || t('Failed to place order. Please try again.', '下单失败，请重试。'))
      toast.error(t('Failed to place order. Please try again.', '下单失败，请重试。'))
    } finally {
      setBusy(false)
    }
  }

  // "Place another order": clear the cart, and hand the fields back to the profile rather than to
  // blank — a signed-in customer's second order of the day should not make them retype either.
  const handleReset = () => {
    setSuccess(null)
    setCart({})
    setNameInput(null)
    setWaInput(null)
    setAddressInput(null)
    setError(null)
    removeVoucher()
  }

  return (
    <AnimatePresence mode="wait">
      {success ? (
        // ── Success view ──────────────────────────────────────────────────────
        <motion.div key="success" className="form-wrap" variants={viewVariants} initial="initial" animate="animate" exit="exit">
          {/* Header */}
          <div className="flex items-start justify-between gap-4 mb-8 max-[480px]:flex-col max-[480px]:gap-2">
            <div>
              <h1 className="font-heading text-[26px] font-medium text-oxblood tracking-[0.3px]">{merchant.name}</h1>
            </div>
            <div className="flex justify-end flex-shrink-0 max-[480px]:justify-start">
              <LanguageSelect />
            </div>
          </div>

          {/* Success content */}
          <div className="text-center py-12 px-6">
            <h2 className="font-heading text-[24px] font-medium text-oxblood mb-2">
              {t('Order Placed!', '订单已提交！')}
            </h2>
            <p className="text-[14px] text-rose-muted mb-6 leading-[1.6]">
              {t('Thank you for your order.', '感谢您的订单。')}
            </p>
            <p className="text-[15px] text-oxblood mb-3 tracking-[0.5px]">
              {t('Order number', '订单号')}:<br />
              <strong className="font-mono text-[16px]">{success.orderNumber}</strong>
            </p>

            <div className="max-w-[360px] mx-auto mb-5 text-left px-4 py-3 bg-surface-raised border-[1.5px] border-divider rounded-md">
              {success.items.map(item => (
                <div key={item.id} className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                  <span className="shrink-0">{item.name} × {item.qty}</span>
                  <span className="text-right">{formatMoney(item.price * item.qty, currency)}</span>
                </div>
              ))}
              {success.fee > 0 && (
                <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                  <span className="shrink-0">{t('Delivery fee', '送货费')}</span>
                  <span className="text-right">{formatMoney(success.fee, currency)}</span>
                </div>
              )}
              {success.discount > 0 && (
                <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                  <span className="shrink-0">{t('Voucher', '优惠券')}</span>
                  <span className="text-right">−{formatMoney(success.discount, currency)}</span>
                </div>
              )}
              <div className="flex justify-between items-start gap-2 text-[15px] font-medium text-ink border-t border-rose-border mt-2 pt-[10px]">
                <span className="shrink-0">{t('Total', '总计')}</span>
                <span className="text-right">{formatMoney(success.total, currency)}</span>
              </div>
            </div>

            {(merchant.payment_note || merchant.payment_bank) && (
              <div className="max-w-[360px] mx-auto mb-4 text-left px-[14px] py-[10px] bg-surface-raised border-[1.5px] border-divider rounded-md text-[13px] text-ink-faint leading-[1.5]">
                <div className="font-semibold text-oxblood mb-1">
                  {t('Payment Instructions', '付款说明')}
                </div>
                {merchant.payment_bank && <p>{merchant.payment_bank}</p>}
                {merchant.payment_note && (
                  <p className={cn("whitespace-pre-line", merchant.payment_bank && "mt-[6px]")}>
                    {merchant.payment_note}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-col items-center gap-2 mt-5">
              <Link to={`/s/${merchant.slug}/track`} className="text-[13px] text-oxblood font-medium underline">
                {t('Track your order', '追踪订单')}
              </Link>
              <button type="button" className="text-[13px] text-rose-muted cursor-pointer underline inline-block" onClick={handleReset}>
                {t('Place another order', '再下一单')}
              </button>
            </div>
          </div>
        </motion.div>
      ) : (
        // ── Order form ──────────────────────────────────────────────────────
        <motion.div key="form" className="form-wrap" variants={viewVariants} initial="initial" animate="animate" exit="exit">
          {/* Header with lang switch */}
          <div className="flex items-start justify-between gap-4 mb-8 max-[480px]:flex-col max-[480px]:gap-2">
            <div>
              <h1 className="font-heading text-[26px] font-medium text-oxblood tracking-[0.3px]">{merchant.name}</h1>
              <p className="font-heading text-[13px] italic text-rose-muted mt-[5px]">
                {t('Powered by BiteTime', 'BiteTime 提供技术支持')}
              </p>
              <div className="flex items-center gap-3 mt-1">
                {/* The guest's entry point, and it stays one: a signed-in customer gets history
                    instead, which carries the tracking inline. */}
                <Link to={`/s/${merchant.slug}/track`} className="text-[12px] text-oxblood underline inline-block">
                  {t('Track an order', '追踪订单')}
                </Link>
                {account && (
                  <Link to={`/s/${merchant.slug}/orders`} className="text-[12px] text-oxblood underline inline-block">
                    {t('Your orders', '你的订单')}
                  </Link>
                )}
                {!account && (
                  <button
                    type="button"
                    onClick={() => setSignInOpen(true)}
                    className="text-[12px] text-oxblood underline inline-block cursor-pointer"
                  >
                    {t('Sign in', '登录')}
                  </button>
                )}
              </div>
            </div>
            <div className="flex justify-end flex-shrink-0 max-[480px]:justify-start">
              <LanguageSelect />
            </div>
          </div>

          <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} />

          {/* Product list */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em] mb-3">{t('Menu', '菜单')}</div>
            {activeProducts.length === 0 ? (
              <p className="text-[14px] text-rose-muted italic py-6 text-center">
                {t('This shop has no products yet.', '此店暂无商品。')}
              </p>
            ) : (
              <div className="flex flex-col gap-[10px]">
                {activeProducts.map(p => (
                  <div
                    key={p.id}
                    className={cn(
                      "flex items-center gap-[14px] px-4 py-[14px] bg-surface-raised border-[1.5px] border-clay-border rounded-xl transition-colors",
                      (cart[p.id] || 0) > 0 && "border-oxblood bg-oxblood-tint"
                    )}
                  >
                    {p.image_urls?.length ? (
                      <button
                        type="button"
                        onClick={() => setGallery(p)}
                        aria-label={t('View photos', '查看图片')}
                        className="size-14 shrink-0 rounded-lg overflow-hidden border-[1.5px] border-clay-border cursor-pointer relative"
                      >
                        <img src={productImageUrl(p.image_urls[0])} alt="" className="size-full object-cover" />
                        {p.image_urls.length > 1 && (
                          <span className="absolute bottom-0.5 right-0.5 px-1 rounded-full bg-oxblood/85 text-white text-[10px] leading-[14px]">
                            {p.image_urls.length}
                          </span>
                        )}
                      </button>
                    ) : null}
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-medium text-ink">{productName(p)}</div>
                      {productDescr(p) && (
                        <div className="text-[12px] text-rose-muted mt-0.5 leading-[1.4]">{productDescr(p)}</div>
                      )}
                      <div className="text-[13px] font-medium text-oxblood mt-[5px]">
                        {formatMoney(p.price, currency)} / {formatUnit(p.unit_quantity, p.unit || t('unit', '个'))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="soft"
                        size="iconRound"
                        className="text-[16px] pointer-coarse:size-11 pointer-coarse:text-[18px]"
                        onClick={() => updateQty(p.id, -1)}
                        aria-label={t('Decrease quantity', '减少数量')}
                      >−</Button>
                      <span
                        className="text-[14px] font-medium min-w-[20px] pointer-coarse:min-w-[28px] text-center text-ink"
                        aria-live="polite"
                        aria-label={t('Quantity', '数量')}
                      >{cart[p.id] || 0}</span>
                      <Button
                        variant="soft"
                        size="iconRound"
                        className="text-[16px] pointer-coarse:size-11 pointer-coarse:text-[18px]"
                        onClick={() => updateQty(p.id, 1)}
                        aria-label={t('Increase quantity', '增加数量')}
                      >+</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <ImageLightbox
            key={gallery?.id}
            paths={gallery?.image_urls ?? []}
            open={!!gallery}
            onOpenChange={o => { if (!o) setGallery(null) }}
            title={gallery ? productName(gallery) : undefined}
            t={t}
          />

          <hr className="border-0 border-t border-clay-border my-6" />

          {/* Fulfilment */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em] mb-3">{t('Fulfilment', '配送方式')}</div>
            <div className="flex gap-[10px]" role="group" aria-label={t('Fulfilment method', '配送方式')}>
              <button
                type="button"
                className={cn(
                  "flex-1 border rounded-md py-[10px] px-[14px] pointer-coarse:min-h-11 cursor-pointer text-[14px] font-sans text-center transition-all hover:border-oxblood focus-visible:outline-2 focus-visible:outline-oxblood focus-visible:outline-offset-2",
                  mode === 'pickup'
                    ? "border-[1.5px] border-oxblood bg-oxblood-tint text-oxblood font-medium"
                    : "border-clay-border bg-surface-raised text-ink"
                )}
                aria-pressed={mode === 'pickup'}
                onClick={() => setMode('pickup')}
              >
                {t('Pickup', '自取')}
              </button>
              <button
                type="button"
                className={cn(
                  "flex-1 border rounded-md py-[10px] px-[14px] pointer-coarse:min-h-11 cursor-pointer text-[14px] font-sans text-center transition-all hover:border-oxblood focus-visible:outline-2 focus-visible:outline-oxblood focus-visible:outline-offset-2",
                  mode === 'delivery'
                    ? "border-[1.5px] border-oxblood bg-oxblood-tint text-oxblood font-medium"
                    : "border-clay-border bg-surface-raised text-ink"
                )}
                aria-pressed={mode === 'delivery'}
                onClick={() => setMode('delivery')}
              >
                {t('Delivery', '送货')} (+{formatMoney(baseDeliveryFee, currency)})
              </button>
            </div>
            {mode === 'pickup' && merchant?.pickup_address && (
              <div className="flex flex-col gap-1.5 mt-3">
                <div className="text-[13px] font-medium text-oxblood">{t('Pickup address', '自取地址')}</div>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(merchant.pickup_address)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[14px] text-oxblood whitespace-pre-line leading-[1.5] underline decoration-oxblood/30 underline-offset-2 hover:decoration-oxblood transition-colors"
                >
                  {merchant.pickup_address}
                </a>
              </div>
            )}
            {mode === 'delivery' && (
              <div className="flex flex-col gap-3 mt-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sf-line1">{t('Address line', '地址')}</Label>
                  <Input
                    id="sf-line1"
                    value={address.line1}
                    onChange={e => patchAddress({ line1: e.target.value })}
                    placeholder={t('Street, building, unit…', '街道、建筑、单位…')}
                  />
                </div>
                <div className="flex gap-3">
                  <div className="flex flex-col gap-1.5 w-1/3">
                    <Label htmlFor="sf-postcode">{t('Postcode', '邮编')}</Label>
                    <Input
                      id="sf-postcode"
                      value={address.postcode}
                      onChange={e => onPostcodeChange(e.target.value)}
                      inputMode="numeric"
                      maxLength={5}
                      placeholder="43000"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 flex-1">
                    <Label htmlFor="sf-city">{t('City', '城市')}</Label>
                    <Input
                      id="sf-city"
                      value={address.city}
                      onChange={e => patchAddress({ city: e.target.value })}
                      placeholder={t('City', '城市')}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sf-state">{t('State', '州属')}</Label>
                  <select
                    id="sf-state"
                    value={address.state}
                    onChange={e => patchAddress({ state: e.target.value })}
                    className="w-full min-w-0 rounded-md border border-clay-border bg-surface-raised px-[13px] py-2.5 text-[16px] text-ink transition-colors outline-none focus-visible:border-oxblood focus-visible:ring-3 focus-visible:ring-oxblood/10"
                  >
                    <option value="">{t('Select state…', '选择州属…')}</option>
                    {MY_STATES.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          <hr className="border-0 border-t border-clay-border my-6" />

          {/* The gate stands where the checkout form would be, and replaces it top to bottom:
              details, voucher, summary, Place Order. The cart above it is untouched, so it
              survives the gate — and survives signing in through it, since AuthPanel never
              leaves the page. 'pending' renders neither: it is one beat of a resolving session. */}
          {step === 'pending' ? null : step === 'gate' ? (
            <CheckoutGate onGuest={chooseGuest} />
          ) : (
          <>
          {/* Customer details */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em] mb-3">{t('Your Details', '您的资料')}</div>
            {step === 'guest' && <GuestStrip onSignIn={() => setSignInOpen(true)} />}
            <div className="flex flex-col gap-1.5 mb-3">
              <Label htmlFor="sf-name">{t('Name', '姓名')} *</Label>
              <Input
                id="sf-name"
                type="text"
                value={name}
                onChange={e => setNameInput(e.target.value)}
                placeholder={t('Full name', '全名')}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sf-wa">{t('WhatsApp', 'WhatsApp')} *</Label>
              <Input
                id="sf-wa"
                type="tel"
                value={wa}
                onChange={e => setWaInput(e.target.value)}
                placeholder={t('e.g. 601X-XXXXXXX', '例：601X-XXXXXXX')}
              />
            </div>
          </div>

          <hr className="border-0 border-t border-clay-border my-6" />

          {/* Voucher */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em] mb-3">{t('Voucher', '优惠券')}</div>
            {appliedVoucher ? (
              <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                <span className="shrink-0">{t('Applied', '已应用')}: <strong>{appliedVoucher.code}</strong></span>
                <button type="button" className="text-[13px] text-rose-muted cursor-pointer underline mt-5 inline-block" onClick={removeVoucher}>
                  {t('Remove', '移除')}
                </button>
              </div>
            ) : (
              <div className="flex items-stretch gap-2">
                <Input
                  type="text"
                  value={voucherInput}
                  onChange={e => setVoucherInput(e.target.value)}
                  placeholder={t('Enter voucher code', '输入优惠码')}
                  className="flex-1 min-w-0"
                />
                <Button
                  size="sm"
                  disabled={voucherBusy}
                  className="pointer-coarse:min-h-11"
                  onClick={applyVoucher}
                >
                  {voucherBusy ? t('Checking…', '验证中…') : t('Apply', '应用')}
                </Button>
              </div>
            )}
            {voucherMsg && (
              <p className="mt-2 text-[13px]">{voucherMsg}</p>
            )}
          </div>

          <hr className="border-0 border-t border-clay-border my-6" />

          {/* Live order summary */}
          <div className="bg-oxblood-tint border border-rose-border rounded-xl py-4 px-5 mb-6">
            <div className="font-heading text-[14px] font-medium text-oxblood mb-[10px]">
              {t('Order Summary', '订单摘要')}
            </div>
            {cartItems.length === 0 ? (
              <p className="text-[13px] text-text-tertiary italic">
                {t('No items selected yet.', '尚未选择任何商品。')}
              </p>
            ) : (
              <>
                {cartItems.map(item => {
                  const prod = activeProducts.find(p => p.id === item.id)
                  const displayName = (lang === 'zh' && prod?.name_zh) ? prod.name_zh : item.name
                  return (
                    <div key={item.id} className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                      <span className="shrink-0">{displayName} × {item.qty}</span>
                      <span className="text-right">{formatMoney(item.price * item.qty, currency)}</span>
                    </div>
                  )
                })}
                <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                  <span className="shrink-0">{t('Subtotal', '小计')}</span>
                  <span className="text-right">{formatMoney(subtotal, currency)}</span>
                </div>
                {mode === 'delivery' && (
                  <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                    <span className="shrink-0">{t('Delivery fee', '送货费')}</span>
                    <span className="text-right">{formatMoney(fee, currency)}</span>
                  </div>
                )}
                {discount > 0 && (
                  <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                    <span className="shrink-0">{t('Voucher', '优惠券')} ({appliedVoucher?.code})</span>
                    <span className="text-right">−{formatMoney(discount, currency)}</span>
                  </div>
                )}
                <div className="flex justify-between items-start gap-2 text-[15px] font-medium text-ink border-t border-rose-border mt-2 pt-[10px]">
                  <span className="shrink-0">{t('Total', '总计')}</span>
                  <span className="text-right">{formatMoney(total, currency)}</span>
                </div>
              </>
            )}
          </div>

          {error && (
            <div className="text-[13px] text-danger bg-rose-pale border border-danger-border rounded-md px-[13px] py-[10px] mb-[10px] leading-[1.5]">
              {error}
            </div>
          )}

          <Button
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="disabled:opacity-60 active:scale-[0.99]"
          >
            {busy ? t('Placing order…', '提交中…') : t('Place Order', '提交订单')}
          </Button>
          </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
