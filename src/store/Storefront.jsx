import { useState, useEffect } from 'react'
import { useMerchant } from '../MerchantContext'
import { useSession } from '../SessionContext'
import { fetchProducts, placeOrder } from '../store'

export default function Storefront() {
  const { merchant } = useMerchant()
  const { lang, setLang, t } = useSession()

  const [products, setProducts] = useState([])
  const [cart, setCart] = useState({})        // { [productId]: qty }
  const [mode, setMode] = useState('pickup')  // 'pickup' | 'delivery'
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [wa, setWa] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)

  const merchantId = merchant?.id

  useEffect(() => {
    if (!merchantId) return
    fetchProducts(merchantId).then(setProducts)
  }, [merchantId])

  const activeProducts = products.filter(p => p.active)
  const deliveryFee = merchant?.shipping?.WM ?? 8
  const fee = mode === 'delivery' ? deliveryFee : 0

  const productName = (p) =>
    (lang === 'zh' && p.name_zh) ? p.name_zh : p.name
  const productDescr = (p) =>
    (lang === 'zh' && p.descr_zh) ? p.descr_zh : (p.descr || '')

  const cartItems = activeProducts
    .filter(p => (cart[p.id] || 0) > 0)
    .map(p => ({ id: p.id, name: p.name, qty: cart[p.id], price: p.price }))

  const subtotal = cartItems.reduce((s, i) => s + i.price * i.qty, 0)
  const total = subtotal + fee
  const canSubmit = cartItems.length > 0 && name.trim() !== '' && wa.trim() !== '' && !busy

  const updateQty = (productId, delta) => {
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
      setSuccess({ orderNumber: result.orderNumber, items: cartItems, subtotal, fee, total })
    } catch (err) {
      setError(err.message || t('Failed to place order. Please try again.', '下单失败，请重试。'))
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
  }

  // ── Success view ──────────────────────────────────────────────────────────
  if (success) {
    return (
      <div className="form-wrap">
        <div className="mm-sf-header">
          <div className="brand mm-sf-brand-left">
            <h1>{merchant.name}</h1>
          </div>
          <div className="lang-switcher" style={{ marginBottom: 0 }}>
            <button className={`lang-btn${lang === 'en' ? ' active' : ''}`} onClick={() => setLang('en')}>EN</button>
            <button className={`lang-btn${lang === 'zh' ? ' active' : ''}`} onClick={() => setLang('zh')}>中文</button>
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

          <span className="reset-link" onClick={handleReset}>
            {t('Place another order', '再下一单')}
          </span>
        </div>
      </div>
    )
  }

  // ── Order form ────────────────────────────────────────────────────────────
  return (
    <div className="form-wrap">
      {/* Header with lang switch */}
      <div className="mm-sf-header">
        <div className="brand mm-sf-brand-left">
          <h1>{merchant.name}</h1>
          <p className="tagline">{t('Powered by BiteTime', 'BiteTime 提供技术支持')}</p>
        </div>
        <div className="lang-switcher" style={{ marginBottom: 0 }}>
          <button className={`lang-btn${lang === 'en' ? ' active' : ''}`} onClick={() => setLang('en')}>EN</button>
          <button className={`lang-btn${lang === 'zh' ? ' active' : ''}`} onClick={() => setLang('zh')}>中文</button>
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
                  <span className="qty-val">{cart[p.id] || 0}</span>
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
        <div className="radio-row">
          <div
            className={`radio-opt${mode === 'pickup' ? ' active' : ''}`}
            onClick={() => setMode('pickup')}
          >
            {t('Pickup', '自取')}
          </div>
          <div
            className={`radio-opt${mode === 'delivery' ? ' active' : ''}`}
            onClick={() => setMode('delivery')}
          >
            {t('Delivery', '送货')} (+RM {Number(deliveryFee).toFixed(2)})
          </div>
        </div>
        {mode === 'delivery' && (
          <div className="field" style={{ marginTop: '0.75rem' }}>
            <label>{t('Delivery address', '送货地址')}</label>
            <textarea
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
          <label>{t('Name', '姓名')} *</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('Full name', '全名')}
          />
        </div>
        <div className="field">
          <label>{t('WhatsApp', 'WhatsApp')} *</label>
          <input
            type="tel"
            value={wa}
            onChange={e => setWa(e.target.value)}
            placeholder={t('e.g. 601X-XXXXXXX', '例：601X-XXXXXXX')}
          />
        </div>
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
    </div>
  )
}
