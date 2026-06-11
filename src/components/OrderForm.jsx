import { useState, useRef, useEffect } from 'react';
import { DayPicker } from 'react-day-picker';
import { format } from 'date-fns';
import emailjs from '@emailjs/browser';
import 'react-day-picker/dist/style.css';
import { lookupPostcode } from '../postcodes';
import { saveOrder, loadVouchers, markVoucherUsed, getNextOrderNumber } from '../store';
import { quoteSameday } from '../geo';

export default function OrderForm({ settings, lang, user, onSuccess, savedAddress }) {
  const t = (en, zh) => lang === 'zh' ? zh : en;

  const [selected, setSelected] = useState({});
  const [qty, setQty] = useState({});
  const [mode, setMode] = useState('pickup');
  const [addrLine1, setAddrLine1] = useState(savedAddress?.line1 || '');
  const [addrLine2, setAddrLine2] = useState(savedAddress?.line2 || '');
  const [city, setCity] = useState(savedAddress?.city || '');
  const [postcode, setPostcode] = useState(savedAddress?.postcode || '');
  const [state, setState] = useState(savedAddress?.state || '');
  const [custName, setCustName] = useState(savedAddress?.name || '');
  const [custWa, setCustWa] = useState(savedAddress?.wa || '');
  const [custDate, setCustDate] = useState('');
  const [custDateObj, setCustDateObj] = useState(null);
  const [showCal, setShowCal] = useState(false);
  const calRef = useRef(null);
  useEffect(() => {
    const handler = (e) => { if (calRef.current && !calRef.current.contains(e.target)) setShowCal(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  const sameday = settings.sameday;
  const samedayAvailable = !!(sameday?.enabled && sameday.originLat != null && sameday.originLng != null);
  const [sdQuote, setSdQuote] = useState({ status: 'idle' });
  useEffect(() => {
    if (mode !== 'sameday' || postcode.length !== 5) { setSdQuote({ status: 'idle' }); return; }
    let cancelled = false;
    setSdQuote({ status: 'loading' });
    const timer = setTimeout(async () => {
      const q = await quoteSameday(postcode, sameday);
      if (cancelled) return;
      if (q.error) setSdQuote({ status: q.error === 'range' ? 'range' : 'failed', km: q.km });
      else setSdQuote({ status: 'ok', km: q.km, fee: q.fee });
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [mode, postcode, sameday]);

  const [voucherInput, setVoucherInput] = useState('');
  const [appliedVoucher, setAppliedVoucher] = useState(null);
  const [voucherMsg, setVoucherMsg] = useState('');
  const [voucherApplying, setVoucherApplying] = useState(false);

  function toggleCookie(id) {
    setSelected(prev => {
      const next = { ...prev };
      if (next[id]) {
        delete next[id];
        setQty(q => ({ ...q, [id]: 0 }));
      } else {
        next[id] = true;
        setQty(q => ({ ...q, [id]: Math.max(1, q[id] || 0) }));
      }
      return next;
    });
  }

  function changeQty(e, id, delta) {
    e.stopPropagation();
    setQty(prev => {
      const newQty = Math.max(0, (prev[id] || 0) + delta);
      if (newQty > 0) setSelected(s => ({ ...s, [id]: true }));
      else setSelected(s => { const n = { ...s }; delete n[id]; return n; });
      return { ...prev, [id]: newQty };
    });
  }

  function getProduct(id) { return settings.products.find(p => p.id === id); }

  const EM_STATES = ['Sabah', 'Sarawak', 'W.P. Labuan'];
  const needsAddress = mode === 'delivery' || mode === 'sameday';
  function currentShippingFee() {
    if (mode === 'delivery' && state) return settings.shipping[EM_STATES.includes(state) ? 'EM' : 'WM'] || 0;
    if (mode === 'sameday' && sdQuote.status === 'ok') return sdQuote.fee;
    return 0;
  }

  async function applyVoucher() {
    const code = voucherInput.trim().toUpperCase();
    if (!code) return;
    setVoucherApplying(true);
    setVoucherMsg('');
    const vouchers = await loadVouchers();
    const v = vouchers.find(v => v.code === code);
    let errMsg = '';
    if (!v) {
      errMsg = t('❌ Invalid voucher code.', '❌ 无效的优惠码。');
    } else if (v.used) {
      errMsg = t('❌ This voucher has already been used.', '❌ 此优惠券已被使用。');
    } else if (v.email && v.email !== (user?.email ?? '').toLowerCase()) {
      errMsg = t('❌ This voucher is not assigned to your account.', '❌ 此优惠券不属于您的账户。');
    } else if (v.expiresAt && new Date(v.expiresAt) < new Date()) {
      errMsg = t('❌ This voucher has expired.', '❌ 此优惠券已过期。');
    } else if (v.minOrder) {
      let subtotal = 0;
      Object.keys(selected).forEach(id => { const p = getProduct(id); if (p) subtotal += p.price * (qty[id] || 0); });
      subtotal += currentShippingFee();
      if (subtotal < v.minOrder) {
        errMsg = t(`❌ Minimum order of RM ${v.minOrder} required.`, `❌ 需要最低消费 RM ${v.minOrder}。`);
      }
    }
    if (errMsg) {
      setVoucherMsg(errMsg);
    } else {
      setAppliedVoucher(v);
      const label = v.type === 'percent' ? `${v.value}% off` : `RM ${v.value} off`;
      setVoucherMsg(t(`✓ Voucher applied: ${label}`, `✓ 优惠券已应用：${label}`));
    }
    setVoucherApplying(false);
  }

  function removeVoucher() {
    setAppliedVoucher(null);
    setVoucherInput('');
    setVoucherMsg('');
  }

  function computeDiscount(subtotalBeforeDiscount) {
    if (!appliedVoucher) return 0;
    if (appliedVoucher.type === 'percent') {
      return parseFloat(((subtotalBeforeDiscount * appliedVoucher.value) / 100).toFixed(2));
    }
    return Math.min(appliedVoucher.value, subtotalBeforeDiscount);
  }

  function computeTotal() {
    let total = 0;
    Object.keys(selected).forEach(id => {
      const p = getProduct(id); if (!p) return;
      total += p.price * (qty[id] || 0);
    });
    total += currentShippingFee();
    const discount = computeDiscount(total);
    return parseFloat((total - discount).toFixed(2));
  }

  async function submitOrder() {
    if (!Object.keys(selected).length) { alert(t('Please select at least one item!', '请至少选择一种产品！')); return; }
    if (!custName.trim() || !custWa.trim()) { alert(t('Please fill in your name and WhatsApp number.', '请填写您的姓名和 WhatsApp 号码。')); return; }
    if (needsAddress && (!addrLine1.trim() || !city.trim() || !postcode.trim() || !state)) { alert(t('Please fill in all required delivery fields.', '请填写所有必填的送货资料。')); return; }
    if (mode === 'sameday' && sdQuote.status !== 'ok') {
      alert(sdQuote.status === 'range'
        ? t('Sorry, your address is outside our same-day delivery range. Please choose regular delivery.', '抱歉，您的地址超出当天配送范围，请选择普通送货。')
        : t('Same-day delivery fee is still being calculated. Please wait a moment or check your postcode.', '当天配送费仍在计算中，请稍候或检查邮政编码。'));
      return;
    }

    const effectiveDate = mode === 'sameday' ? format(new Date(), 'yyyy-MM-dd') : custDate;
    const orderNumber = await getNextOrderNumber();
    let msg = `🍪 *New Order from Bitetime & Co.*\n\n*Order No.:* ${orderNumber}\n`;
    msg += `*Name:* ${custName}\n*WhatsApp:* ${custWa}\n`;
    if (effectiveDate) msg += `*Preferred date:* ${effectiveDate}\n`;
    msg += `\n*Items:*\n`;

    let total = 0;
    Object.keys(selected).forEach(id => {
      const p = getProduct(id); if (!p) return;
      const q = qty[id] || 0, sub = p.price * q;
      total += sub;
      msg += `• ${p.name} × ${q} — RM ${sub}\n`;
    });

    if (mode === 'delivery') {
      const region = EM_STATES.includes(state) ? 'EM' : 'WM';
      const fee = settings.shipping[region] || 0;
      total += fee;
      const fullAddress = [addrLine1, addrLine2, city, postcode, state].filter(Boolean).join(', ');
      msg += `\n*Delivery (${region}):* RM ${fee}\n*Address:* ${fullAddress}\n`;
    } else if (mode === 'sameday') {
      const fee = sdQuote.fee;
      total += fee;
      const fullAddress = [addrLine1, addrLine2, city, postcode, state].filter(Boolean).join(', ');
      msg += `\n*Same-day delivery (Lalamove/Grab, ~${sdQuote.km} km):* RM ${fee}\n*Address:* ${fullAddress}\n`;
    } else {
      msg += `\n*Order type:* Self-pickup\n`;
    }
    if (appliedVoucher) {
      const discountAmt = appliedVoucher.type === 'percent'
        ? parseFloat(((total * appliedVoucher.value) / 100).toFixed(2))
        : Math.min(appliedVoucher.value, total);
      msg += `\n*Voucher (${appliedVoucher.code}):* −RM ${discountAmt}`;
      total = parseFloat((total - discountAmt).toFixed(2));
    }
    msg += `\n*Total: RM ${total}*`;

    try {
      const items = Object.keys(selected).map(id => {
        const p = getProduct(id);
        return { id, name: p.name, qty: qty[id] || 0, price: p.price };
      });
      const region = mode === 'delivery' ? (EM_STATES.includes(state) ? 'EM' : 'WM') : null;
      if (appliedVoucher) await markVoucherUsed(appliedVoucher.code);
      await saveOrder({
        order_number: orderNumber,
        user_id: user?.id ?? null,
        customer_name: custName,
        customer_wa: custWa,
        preferred_date: effectiveDate || null,
        mode,
        address: needsAddress ? [addrLine1, addrLine2, city, postcode, state].filter(Boolean).join(', ') : null,
        region,
        shipping_fee: currentShippingFee(),
        items,
        total: computeTotal(),
      });

      if (user?.email && settings.ejsServiceId && settings.ejsTemplateId && settings.ejsPublicKey) {
        const orderSummary = items.map(i => `${i.name} x ${i.qty} — RM ${i.price * i.qty}`).join('\n');
        const fullAddress = needsAddress
          ? [addrLine1, addrLine2, city, postcode, state].filter(Boolean).join(', ')
          : null;
        const orderDetails = needsAddress
          ? `${orderSummary}\n\nDelivery address: ${fullAddress}`
          : orderSummary;
        emailjs.send(
          settings.ejsServiceId,
          settings.ejsTemplateId,
          {
            to_name: custName,
            to_email: user.email,
            order_number: orderNumber,
            order_summary: orderDetails,
            order_total: `RM ${computeTotal()}`,
            order_type: mode === 'delivery' ? 'Delivery' : mode === 'sameday' ? 'Same-day delivery' : 'Self-pickup',
          },
          settings.ejsPublicKey,
        ).catch(() => {});
      }

      // Telegram notify — best-effort, failure does not block order
      fetch(`https://api.telegram.org/bot${settings.tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: settings.tgChatId, text: msg, parse_mode: 'Markdown' }),
      }).catch(() => {});

      onSuccess(orderNumber);
    } catch {
      alert(t('Failed to send order. Please try again.', '发送订单失败，请重试。'));
    }
  }

  const selectedIds = Object.keys(selected);
  const hasItems = selectedIds.length > 0;

  return (
    <>
      {/* HOW TO ORDER */}
      <div className="how-to">
        <div className="how-to-title">{t('How to place your order 🍪', '如何下单 🍪')}</div>
        <div className="how-to-steps">
          <div className="how-to-step"><span className="step-num">1</span><span>{t('Pick the cookies you want and set the quantity for each item.', '选择您想要的饼干，并设置每种产品的数量。')}</span></div>
          <div className="how-to-step"><span className="step-num">2</span><span dangerouslySetInnerHTML={{ __html: t('Choose <strong>Self-pickup</strong> or <strong>Delivery</strong> — if delivery, fill in your delivery address.', '选择<strong>自取</strong>或<strong>送货</strong> — 若选送货，请填写您的送货地址。') }} /></div>
          <div className="how-to-step"><span className="step-num">3</span><span>{t('Fill in your name, WhatsApp number, and preferred date.', '填写您的姓名、WhatsApp 号码和预计日期。')}</span></div>
          <div className="how-to-step"><span className="step-num">4</span><span dangerouslySetInnerHTML={{ __html: t('Tap <strong>Submit order</strong> — your order is sent to us instantly and we\'ll confirm shortly!', '点击<strong>提交订单</strong> — 您的订单将立即发送给我们，我们会尽快确认！') }} /></div>
        </div>
      </div>

      {/* COOKIE GRID */}
      <div className="section">
        <div className="section-label">{t('Choose your cookies', '选择您的饼干')}</div>
        <div className="cookie-grid">
          {settings.products.map(p => (
            <div key={p.id} className={'cookie-card' + (selected[p.id] ? ' selected' : '')} onClick={() => toggleCookie(p.id)}>
              <div className="cookie-check-badge">{selected[p.id] ? '✓' : ''}</div>
              <div className="cookie-name">{p.name}</div>
              <div className="cookie-desc">{p.desc}</div>
              <div className="cookie-price">RM {p.price} / {p.unit}</div>
              <div className="qty-row">
                <label>{t('Qty', '数量')} ({p.unit}s)</label>
                <div className="qty-ctrl">
                  <button className="qty-btn" onClick={e => changeQty(e, p.id, -1)}>−</button>
                  <span className="qty-val">{qty[p.id] || 0}</span>
                  <button className="qty-btn" onClick={e => changeQty(e, p.id, 1)}>+</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* DELIVERY MODE */}
      <div className="section">
        <div className="section-label">{t('Delivery or self-pickup?', '送货或自取？')}</div>
        <div className="radio-row">
          <div className={'radio-opt' + (mode === 'pickup' ? ' active' : '')} onClick={() => setMode('pickup')}>{t('Self-pickup', '自取')}</div>
          <div className={'radio-opt' + (mode === 'delivery' ? ' active' : '')} onClick={() => setMode('delivery')}>{t('Delivery', '送货')}</div>
          {samedayAvailable && (
            <div className={'radio-opt' + (mode === 'sameday' ? ' active' : '')} onClick={() => setMode('sameday')}>{t('Same-day delivery ⚡', '当天配送 ⚡')}</div>
          )}
        </div>
        {mode === 'sameday' && (
          <p style={{ fontSize: '12px', color: '#888', marginTop: '8px' }}>
            {t('Delivered today via Lalamove / Grab Express. Fee is estimated by distance from our kitchen to your address.', '今天通过 Lalamove / Grab Express 配送。运费按从我们厨房到您地址的距离估算。')}
          </p>
        )}
      </div>

      {/* DELIVERY FIELDS */}
      {needsAddress && (
        <div className="section">
          <div className="section-label">{t('Delivery details', '送货详情')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="field">
              <label>{t('Address Line 1', '地址第一行')} *</label>
              <input type="text" placeholder={t('Unit no. / Street name', '单位号码 / 街道名称')} value={addrLine1} onChange={e => setAddrLine1(e.target.value)} />
            </div>
            <div className="field">
              <label>{t('Address Line 2', '地址第二行')} <span style={{ fontSize: '11px', color: '#aaa', fontStyle: 'italic' }}>{t('optional', '选填')}</span></label>
              <input type="text" placeholder={t('Apartment, building, floor, etc.', '公寓、楼栋、楼层等')} value={addrLine2} onChange={e => setAddrLine2(e.target.value)} />
            </div>
            <div className="field-row">
              <div className="field">
                <label>{t('Postcode', '邮政编码')} *</label>
                <input type="text" placeholder="e.g. 50480" maxLength={5} value={postcode} onChange={e => {
                  const val = e.target.value.replace(/\D/g, '');
                  setPostcode(val);
                  if (val.length === 5) {
                    const result = lookupPostcode(val);
                    if (result) {
                      setCity(result.city);
                      setState(result.state);
                    }
                  }
                }} />
              </div>
              <div className="field">
                <label>{t('City', '城市')} *</label>
                <input type="text" placeholder={t('e.g. Kuala Lumpur', '例如：吉隆坡')} value={city} onChange={e => setCity(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label>{t('State', '州属')} *</label>
              <select value={state} onChange={e => setState(e.target.value)}>
                <option value="">{t('— Select state —', '— 选择州属 —')}</option>
                {['Johor','Kedah','Kelantan','Melaka','Negeri Sembilan','Pahang','Perak','Perlis','Pulau Pinang','Sabah','Sarawak','Selangor','Terengganu','W.P. Kuala Lumpur','W.P. Labuan','W.P. Putrajaya'].map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            {mode === 'sameday' && postcode.length === 5 && (
              <p style={{ fontSize: '13px', margin: 0, color: sdQuote.status === 'ok' ? '#2e7d32' : sdQuote.status === 'loading' ? '#888' : '#b00020' }}>
                {sdQuote.status === 'loading' && t('Calculating delivery fee…', '正在计算运费…')}
                {sdQuote.status === 'ok' && t(`Estimated same-day delivery: RM ${sdQuote.fee} (~${sdQuote.km} km)`, `当天配送估价：RM ${sdQuote.fee}（约 ${sdQuote.km} 公里）`)}
                {sdQuote.status === 'range' && t(`Sorry, your address (~${sdQuote.km} km) is outside our same-day range. Please choose regular delivery.`, `抱歉，您的地址（约 ${sdQuote.km} 公里）超出当天配送范围，请选择普通送货。`)}
                {sdQuote.status === 'failed' && t('Could not locate this postcode. Please double-check it.', '无法定位此邮政编码，请再检查一次。')}
              </p>
            )}
          </div>
        </div>
      )}

      {/* YOUR DETAILS */}
      <div className="section">
        <div className="section-label">{t('Your details', '您的资料')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div className="field-row">
            <div className="field">
              <label>{t('Your name', '您的姓名')}</label>
              <input type="text" placeholder={t('Your name', '您的名字')} value={custName} onChange={e => setCustName(e.target.value)} />
            </div>
            <div className="field">
              <label>{t('WhatsApp number', 'WhatsApp 号码')}</label>
              <input type="tel" placeholder="e.g. 011-2345678" value={custWa} onChange={e => setCustWa(e.target.value)} />
            </div>
          </div>
          {mode === 'sameday' ? (
            <div className="field">
              <label>{t('Delivery date', '配送日期')}</label>
              <p style={{ fontSize: '13px', margin: '4px 0 0', color: '#7a2828', fontWeight: 600 }}>
                ⚡ {t(`Today — ${format(new Date(), 'dd MMM yyyy')}`, `今天 — ${format(new Date(), 'dd MMM yyyy')}`)}
              </p>
            </div>
          ) : (
          <div className="field" ref={calRef} style={{position:'relative'}}>
            <label>{t('Preferred date', '预计日期')}</label>
            <button type="button" className="date-picker-btn" onClick={() => setShowCal(v => !v)}>
              <span>{custDateObj ? format(custDateObj, 'dd MMM yyyy') : t('Select a date', '选择日期')}</span>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="13" rx="2" stroke="currentColor" strokeWidth="1.4"/><path d="M1 6h14" stroke="currentColor" strokeWidth="1.4"/><path d="M5 1v2M11 1v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
            </button>
            {showCal && (
              <div className="date-picker-popup">
                <DayPicker
                  mode="single"
                  selected={custDateObj}
                  onSelect={(d) => { setCustDateObj(d); setCustDate(d ? format(d, 'yyyy-MM-dd') : ''); setShowCal(false); }}
                  disabled={(d) => { const min = new Date(); min.setHours(0,0,0,0); min.setDate(min.getDate() + (settings.leadDays ?? 3)); const allowed = settings.availableDays ?? [1,2,3,4,5,6]; const blocked = settings.blockedDates ?? []; return d < min || !allowed.includes(d.getDay()) || blocked.includes(format(d, 'yyyy-MM-dd')); }}
                />
              </div>
            )}
          </div>
          )}
        </div>
      </div>

      {/* VOUCHER */}
      <div className="section">
        <div className="section-label">{t('Have a voucher?', '有优惠码？')}</div>
        {appliedVoucher ? (
          <div className="voucher-applied-row">
            <span className="voucher-applied-badge">{appliedVoucher.code}</span>
            <span className="voucher-applied-desc">
              {appliedVoucher.type === 'percent' ? `${appliedVoucher.value}% off` : `RM ${appliedVoucher.value} off`}
            </span>
            <button className="voucher-remove-btn" onClick={removeVoucher}>{t('Remove', '移除')}</button>
          </div>
        ) : (
          <div className="voucher-input-row">
            <input
              type="text"
              className="voucher-text-input"
              placeholder={t('Enter voucher code', '输入优惠码')}
              value={voucherInput}
              onChange={e => { setVoucherInput(e.target.value.toUpperCase()); setVoucherMsg(''); }}
              onKeyDown={e => e.key === 'Enter' && applyVoucher()}
            />
            <button className="voucher-apply-btn" onClick={applyVoucher} disabled={voucherApplying || !voucherInput.trim()}>
              {voucherApplying ? '…' : t('Apply', '应用')}
            </button>
          </div>
        )}
        {voucherMsg && (
          <p className={'voucher-feedback' + (appliedVoucher ? ' ok' : ' err')}>{voucherMsg}</p>
        )}
      </div>

      <hr className="divider" />

      {/* SUMMARY */}
      <div className="summary-card">
        <div className="summary-title">{t('Order summary', '订单摘要')}</div>

        {/* Section 1: Customer details */}
        <div className="summary-section-label">{t('Your details', '您的资料')}</div>
        <div className="summary-section">
          <div className="summary-detail-grid">
            {custName && <div className="summary-detail-cell"><span className="detail-label">{t('Name', '姓名')}</span><span className="detail-value">{custName}</span></div>}
            {custWa && <div className="summary-detail-cell"><span className="detail-label">{t('Phone', '电话')}</span><span className="detail-value">{custWa}</span></div>}
            <div className="summary-detail-cell"><span className="detail-label">{t('Order type', '订单类型')}</span><span className="detail-value">{mode === 'delivery' ? t('Delivery', '送货') : mode === 'sameday' ? t('Same-day delivery ⚡', '当天配送 ⚡') : t('Self-pickup', '自取')}</span></div>
            {mode === 'sameday'
              ? <div className="summary-detail-cell"><span className="detail-label">{t('Delivery date', '配送日期')}</span><span className="detail-value">{t('Today', '今天')} ({format(new Date(), 'dd MMM')})</span></div>
              : custDate && <div className="summary-detail-cell"><span className="detail-label">{t('Preferred date', '预计日期')}</span><span className="detail-value">{custDate}</span></div>}
            {needsAddress && (addrLine1 || city || postcode || state) && (
              <div className="summary-detail-cell" style={{ gridColumn: '1 / -1' }}>
                <span className="detail-label">{t('Delivery address', '送货地址')}</span>
                <span className="detail-value">{[addrLine1, addrLine2, city, postcode, state].filter(Boolean).join(', ')}</span>
              </div>
            )}
          </div>
        </div>

        {/* Section 2: Items, delivery, voucher */}
        <div className="summary-section-label" style={{ marginTop: '12px' }}>{t('Your order', '您的订单')}</div>
        {!hasItems ? (
          <p className="empty-msg">{t('No items selected yet.', '尚未选择任何产品。')}</p>
        ) : (
          <div className="summary-section">
            {selectedIds.map(id => {
              const p = getProduct(id); if (!p) return null;
              const q = qty[id] || 0;
              return <div key={id} className="summary-row"><span>{p.name} × {q} {p.unit}</span><span>RM {p.price * q}</span></div>;
            })}
            {mode === 'delivery' && state && (() => {
              const region = EM_STATES.includes(state) ? 'EM' : 'WM';
              return <div className="summary-row"><span>{t('Delivery', '送货')} ({region})</span><span>RM {settings.shipping[region] || 0}</span></div>;
            })()}
            {mode === 'sameday' && (
              <div className="summary-row">
                <span>{t('Same-day delivery', '当天配送')}{sdQuote.status === 'ok' ? ` (~${sdQuote.km} km)` : ''}</span>
                <span>{sdQuote.status === 'ok' ? `RM ${sdQuote.fee}` : sdQuote.status === 'loading' ? '…' : t('TBD', '待定')}</span>
              </div>
            )}
            {appliedVoucher && (() => {
              let sub = 0;
              Object.keys(selected).forEach(id => { const p = getProduct(id); if (p) sub += p.price * (qty[id] || 0); });
              sub += currentShippingFee();
              const disc = computeDiscount(sub);
              return (
                <div className="summary-row discount">
                  <span>{appliedVoucher.code}</span>
                  <span>− RM {disc}</span>
                </div>
              );
            })()}
            <div className="summary-row total"><span>{t('Total', '总计')}</span><span>RM {computeTotal()}</span></div>
          </div>
        )}
      </div>

      <button className="submit-btn" onClick={submitOrder}>{t('Submit order →', '提交订单 →')}</button>
      <p className="form-note">{t("Your order will be sent to us instantly. We'll confirm with you shortly! 🍪", '您的订单将立即发送给我们，我们会尽快与您确认！🍪')}</p>

      <div className="order-disclaimer">
        <ul>
          <li>{t('All goods sold are not refundable or exchangeable.', '所有售出商品均不退款或换货。')}</li>
          <li>{t('Best consumed within 14 days of receiving your order.', '请在收到订单后 14 天内食用。')}</li>
          <li>{t('Handmade with no preservatives — enjoy fresh for best taste.', '手工制作，不含防腐剂，请趁新鲜享用。')}</li>
          <li>{t('May contain nuts, dairy, and gluten. Please contact us if you have any allergies before ordering.', '可能含有坚果、乳制品及麸质。如有过敏，请在下单前联系我们。')}</li>
        </ul>
      </div>
    </>
  );
}
