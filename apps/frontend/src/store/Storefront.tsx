import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useMerchant } from '../MerchantContext'
import { useSession } from '../SessionContext'
import { usePageVariants } from '../motion'
import { useToast } from '../ToastContext'
import { fetchProducts, placeOrder, fetchMerchantVouchers, redeemVoucher, voucherFullyUsed, notifyOrderPlacedRemote } from '../store'
import { priceOrder, voucherError } from '../pricing'
import type { Product, Voucher } from '../types'

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
  const { lang, setLang, t, account } = useSession()
  const viewVariants = usePageVariants()
  const toast = useToast()

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
    const label = (v as any).type === 'percent' ? `${(v as any).value}% off` : `RM ${(v as any).value} off`
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
      case 'min_order': return t(`❌ Minimum order of RM ${(v as any)?.minOrder} required.`, `❌ 需要最低消费 RM ${(v as any)?.minOrder}。`)
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
        <div className="mm-sf-header">
          <div className="brand mm-sf-brand-left">
            <h1>{merchant.name}</h1>
          </div>
          <div className="lang-switcher" style={{ marginBottom: 0 }}>
            <button className={`lang-btn${lang === 'en' ? ' active' : ''}`} aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
            <button className={`lang-btn${lang === 'zh' ? ' active' : ''}`} aria-pressed={lang === 'zh'} onClick={() => setLang('zh')}>中文</button>
          </div>
        </div>

        <div className="success-box">
          <h2>{t('Order Placed!', '订单已提交！')}</h2>
          <p>{t('Thank you for your order.', '感谢您的订单。')}</p>
          <p className="order-number-display">
            {t('Order number', '订单号')}:<br />
            <strong>{success.orderNumber}</strong>
          </p>

          <div className="success-summary">
            {success.items.map(item => (
              <div key={item.id} className="summary-row">
                <span>{item.name} × {item.qty}</span>
                <span>RM {(item.price * item.qty).toFixed(2)}</span>
              </div>
            ))}
            {success.fee > 0 && (
              <div className="summary-row">
                <span>{t('Delivery fee', '送货费')}</span>
                <span>RM {success.fee.toFixed(2)}</span>
              </div>
            )}
            {success.discount > 0 && (
              <div className="summary-row">
                <span>{t('Voucher', '优惠券')}</span>
                <span>−RM {success.discount.toFixed(2)}</span>
              </div>
            )}
            <div className="summary-row total">
              <span>{t('Total', '总计')}</span>
              <span>RM {success.total.toFixed(2)}</span>
            </div>
          </div>

          {(merchant.payment_note || merchant.payment_bank) && (
            <div className="success-info-box">
              <div className="success-info-title">
                {t('Payment Instructions', '付款说明')}
              </div>
              {merchant.payment_bank && <p>{merchant.payment_bank}</p>}
              {merchant.payment_note && (
                <p style={{ whiteSpace: 'pre-line', marginTop: merchant.payment_bank ? '6px' : 0 }}>
                  {merchant.payment_note}
                </p>
              )}
            </div>
          )}

          <button type="button" className="reset-link" onClick={handleReset}>
            {t('Place another order', '再下一单')}
          </button>
        </div>
        </motion.div>
      ) : (
        // ── Order form ──────────────────────────────────────────────────────
        <motion.div key="form" className="form-wrap" variants={viewVariants} initial="initial" animate="animate" exit="exit">
      {/* Header with lang switch */}
      <div className="mm-sf-header">
        <div className="brand mm-sf-brand-left">
          <h1>{merchant.name}</h1>
          <p className="tagline">{t('Powered by BiteTime', 'BiteTime 提供技术支持')}</p>
        </div>
        <div className="lang-switcher" style={{ marginBottom: 0 }}>
          <button className={`lang-btn${lang === 'en' ? ' active' : ''}`} aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
          <button className={`lang-btn${lang === 'zh' ? ' active' : ''}`} aria-pressed={lang === 'zh'} onClick={() => setLang('zh')}>中文</button>
        </div>
      </div>

      {/* Product list */}
      <div className="section">
        <div className="section-label">{t('Menu', '菜单')}</div>
        {activeProducts.length === 0 ? (
          <p className="mm-sf-empty">
            {t('This shop has no products yet.', '此店暂无商品。')}
          </p>
        ) : (
          <div className="mm-sf-product-list">
            {activeProducts.map(p => (
              <div
                key={p.id}
                className={`mm-sf-product-card${(cart[p.id] || 0) > 0 ? ' mm-sf-product-card--selected' : ''}`}
              >
                <div className="mm-sf-product-info">
                  <div className="mm-sf-product-name">{productName(p)}</div>
                  {productDescr(p) && (
                    <div className="mm-sf-product-descr">{productDescr(p)}</div>
                  )}
                  <div className="mm-sf-product-price">
                    RM {Number(p.price).toFixed(2)} / {p.unit || t('unit', '个')}
                  </div>
                </div>
                <div className="qty-ctrl">
                  <button
                    className="qty-btn"
                    onClick={() => updateQty(p.id, -1)}
                    aria-label={t('Decrease quantity', '减少数量')}
                  >−</button>
                  <span className="qty-val" aria-live="polite" aria-label={t('Quantity', '数量')}>{cart[p.id] || 0}</span>
                  <button
                    className="qty-btn"
                    onClick={() => updateQty(p.id, 1)}
                    aria-label={t('Increase quantity', '增加数量')}
                  >+</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <hr className="divider" />

      {/* Fulfilment */}
      <div className="section">
        <div className="section-label">{t('Fulfilment', '配送方式')}</div>
        <div className="radio-row" role="group" aria-label={t('Fulfilment method', '配送方式')}>
          <button
            type="button"
            className="radio-opt"
            aria-pressed={mode === 'pickup'}
            onClick={() => setMode('pickup')}
          >
            {t('Pickup', '自取')}
          </button>
          <button
            type="button"
            className="radio-opt"
            aria-pressed={mode === 'delivery'}
            onClick={() => setMode('delivery')}
          >
            {t('Delivery', '送货')} (+RM {Number(deliveryFee).toFixed(2)})
          </button>
        </div>
        {mode === 'delivery' && (
          <div className="field" style={{ marginTop: '0.75rem' }}>
            <label htmlFor="sf-address">{t('Delivery address', '送货地址')}</label>
            <textarea
              id="sf-address"
              className="mm-sf-textarea"
              value={address}
              onChange={e => setAddress(e.target.value)}
              rows={3}
              placeholder={t('Enter your full address…', '请输入完整地址…')}
            />
          </div>
        )}
      </div>

      <hr className="divider" />

      {/* Customer details */}
      <div className="section">
        <div className="section-label">{t('Your Details', '您的资料')}</div>
        <div className="field" style={{ marginBottom: '0.75rem' }}>
          <label htmlFor="sf-name">{t('Name', '姓名')} *</label>
          <input
            id="sf-name"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('Full name', '全名')}
          />
        </div>
        <div className="field">
          <label htmlFor="sf-wa">{t('WhatsApp', 'WhatsApp')} *</label>
          <input
            id="sf-wa"
            type="tel"
            value={wa}
            onChange={e => setWa(e.target.value)}
            placeholder={t('e.g. 601X-XXXXXXX', '例：601X-XXXXXXX')}
          />
        </div>
      </div>

      <hr className="divider" />

      {/* Voucher */}
      <div className="section">
        <div className="section-label">{t('Voucher', '优惠券')}</div>
        {appliedVoucher ? (
          <div className="summary-row">
            <span>{t('Applied', '已应用')}: <strong>{appliedVoucher.code}</strong></span>
            <button type="button" className="reset-link" onClick={removeVoucher}>
              {t('Remove', '移除')}
            </button>
          </div>
        ) : (
          <div className="field" style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="text"
              value={voucherInput}
              onChange={e => setVoucherInput(e.target.value)}
              placeholder={t('Enter voucher code', '输入优惠码')}
              style={{ flex: 1 }}
            />
            <button type="button" className="radio-opt" onClick={applyVoucher}>
              {t('Apply', '应用')}
            </button>
          </div>
        )}
        {voucherMsg && (
          <p className="mm-sf-voucher-msg" style={{ marginTop: '0.5rem' }}>{voucherMsg}</p>
        )}
      </div>

      <hr className="divider" />

      {/* Live order summary */}
      <div className="summary-card">
        <div className="summary-title">{t('Order Summary', '订单摘要')}</div>
        {cartItems.length === 0 ? (
          <p className="empty-msg">{t('No items selected yet.', '尚未选择任何商品。')}</p>
        ) : (
          <>
            {cartItems.map(item => {
              const prod = activeProducts.find(p => p.id === item.id)
              const displayName = (lang === 'zh' && prod?.name_zh) ? prod.name_zh : item.name
              return (
                <div key={item.id} className="summary-row">
                  <span>{displayName} × {item.qty}</span>
                  <span>RM {(item.price * item.qty).toFixed(2)}</span>
                </div>
              )
            })}
            <div className="summary-row">
              <span>{t('Subtotal', '小计')}</span>
              <span>RM {subtotal.toFixed(2)}</span>
            </div>
            {mode === 'delivery' && (
              <div className="summary-row">
                <span>{t('Delivery fee', '送货费')}</span>
                <span>RM {fee.toFixed(2)}</span>
              </div>
            )}
            {discount > 0 && (
              <div className="summary-row">
                <span>{t('Voucher', '优惠券')} ({appliedVoucher?.code})</span>
                <span>−RM {discount.toFixed(2)}</span>
              </div>
            )}
            <div className="summary-row total">
              <span>{t('Total', '总计')}</span>
              <span>RM {total.toFixed(2)}</span>
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="mm-sf-error">{error}</div>
      )}

      <button
        className="submit-btn"
        disabled={!canSubmit}
        onClick={handleSubmit}
      >
        {busy ? t('Placing order…', '提交中…') : t('Place Order', '提交订单')}
      </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
