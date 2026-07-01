import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useMerchant } from '../MerchantContext'
import { useSession } from '../SessionContext'
import { usePageVariants } from '../motion'
import { toast } from 'sonner'
import { fetchProducts, placeOrder, fetchMerchantVouchers, redeemVoucher, voucherFullyUsed, notifyOrderPlacedRemote } from '../store'
import { priceOrder, voucherError } from '../pricing'
import { formatMoney } from '../currency'
import type { Product, Voucher } from '../types'
import LanguageSelect from '../components/LanguageSelect'
import { cn } from '@/lib/utils'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'

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
  const { lang, t, account } = useSession()
  const viewVariants = usePageVariants()

  const [products, setProducts] = useState<Product[]>([])
  const [cart, setCart] = useState<Record<string, number>>({})        // { [productId]: qty }
  const [mode, setMode] = useState<'pickup' | 'delivery'>('pickup')  // 'pickup' | 'delivery'
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [wa, setWa] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<SuccessState | null>(null)

  const [vouchers, setVouchers] = useState<Voucher[]>([])
  const [voucherInput, setVoucherInput] = useState('')
  const [appliedVoucher, setAppliedVoucher] = useState<Voucher | null>(null)
  const [voucherMsg, setVoucherMsg] = useState('')

  const merchantId = merchant?.id
  const currency = merchant?.currency

  useEffect(() => {
    if (!merchantId) return
    fetchProducts(merchantId).then(setProducts)
    fetchMerchantVouchers(merchantId).then(setVouchers)
  }, [merchantId])

  const activeProducts = products.filter(p => p.active)
  const deliveryFee = merchant?.shipping?.WM ?? 8
  const fee = mode === 'delivery' ? deliveryFee : 0
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
    rates: { WM: deliveryFee, EM: deliveryFee },
    resolvedShipping: fee,
    voucher: appliedVoucher,
  })
  const cartItems: CartLine[] = bd.lines.map(l => ({ id: l.id, name: l.name, qty: l.qty, price: l.unitPrice }))
  const subtotal = bd.subtotal
  const discount = bd.discount
  const total = bd.total
  const canSubmit = cartItems.length > 0 && name.trim() !== '' && wa.trim() !== '' && !busy

  const applyVoucher = () => {
    const code = voucherInput.trim().toUpperCase()
    if (!code) return
    const v = vouchers.find(x => x.code === code)
    const err = voucherError(v ?? null, {
      subtotal: bd.subtotal + bd.shipping,
      userEmail: voucherEntry,
      now: new Date(),
      fullyUsed: v ? voucherFullyUsed(v) : false,
    })
    if (err) {
      setAppliedVoucher(null)
      setVoucherMsg(voucherErrorText(err, v))
      return
    }
    setAppliedVoucher(v!)
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
      })
      if (appliedVoucher) {
        // Best-effort: failure to record usage must not fail a placed order.
        await redeemVoucher(merchant.id, appliedVoucher.code, voucherEntry).catch(() => {})
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

  const handleReset = () => {
    setSuccess(null)
    setCart({})
    setName('')
    setWa('')
    setAddress('')
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

            <button type="button" className="text-[13px] text-rose-muted cursor-pointer underline mt-5 inline-block" onClick={handleReset}>
              {t('Place another order', '再下一单')}
            </button>
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
            </div>
            <div className="flex justify-end flex-shrink-0 max-[480px]:justify-start">
              <LanguageSelect />
            </div>
          </div>

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
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-medium text-ink">{productName(p)}</div>
                      {productDescr(p) && (
                        <div className="text-[12px] text-rose-muted mt-0.5 leading-[1.4]">{productDescr(p)}</div>
                      )}
                      <div className="text-[13px] font-medium text-oxblood mt-[5px]">
                        {formatMoney(p.price, currency)} / {p.unit || t('unit', '个')}
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
                {t('Delivery', '送货')} (+{formatMoney(deliveryFee, currency)})
              </button>
            </div>
            {mode === 'delivery' && (
              <div className="flex flex-col gap-1.5 mt-3">
                <Label htmlFor="sf-address">{t('Delivery address', '送货地址')}</Label>
                <Textarea
                  id="sf-address"
                  value={address}
                  onChange={e => setAddress(e.target.value)}
                  rows={3}
                  placeholder={t('Enter your full address…', '请输入完整地址…')}
                  className="resize-y min-h-[72px]"
                />
              </div>
            )}
          </div>

          <hr className="border-0 border-t border-clay-border my-6" />

          {/* Customer details */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em] mb-3">{t('Your Details', '您的资料')}</div>
            <div className="flex flex-col gap-1.5 mb-3">
              <Label htmlFor="sf-name">{t('Name', '姓名')} *</Label>
              <Input
                id="sf-name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('Full name', '全名')}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sf-wa">{t('WhatsApp', 'WhatsApp')} *</Label>
              <Input
                id="sf-wa"
                type="tel"
                value={wa}
                onChange={e => setWa(e.target.value)}
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
              <div className="flex flex-col gap-2">
                <Input
                  type="text"
                  value={voucherInput}
                  onChange={e => setVoucherInput(e.target.value)}
                  placeholder={t('Enter voucher code', '输入优惠码')}
                  className="w-full"
                />
                <button
                  type="button"
                  className="w-full border border-clay-border rounded-md py-[10px] px-[14px] pointer-coarse:min-h-11 cursor-pointer text-[14px] font-sans text-ink text-center bg-surface-raised transition-all hover:border-oxblood focus-visible:outline-2 focus-visible:outline-oxblood focus-visible:outline-offset-2 whitespace-nowrap"
                  onClick={applyVoucher}
                >
                  {t('Apply', '应用')}
                </button>
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
        </motion.div>
      )}
    </AnimatePresence>
  )
}
