import { useState } from 'react';
import { lookupPostcode } from '../postcodes';
import { saveOrder } from '../store';

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

  function toggleCookie(id) {
    setSelected(prev => {
      const next = { ...prev };
      if (next[id]) delete next[id]; else next[id] = true;
      return next;
    });
    setQty(prev => ({ ...prev, [id]: prev[id] || 0 }));
  }

  function changeQty(e, id, delta) {
    e.stopPropagation();
    setQty(prev => ({ ...prev, [id]: Math.max(0, (prev[id] || 0) + delta) }));
  }

  function getProduct(id) { return settings.products.find(p => p.id === id); }

  function computeTotal() {
    let total = 0;
    Object.keys(selected).forEach(id => {
      const p = getProduct(id); if (!p) return;
      total += p.price * (qty[id] || 0);
    });
    const EM_STATES = ['Sabah', 'Sarawak', 'W.P. Labuan'];
    if (mode === 'delivery' && state) total += settings.shipping[EM_STATES.includes(state) ? 'EM' : 'WM'] || 0;
    return total;
  }

  async function submitOrder() {
    if (!Object.keys(selected).length) { alert(t('Please select at least one item!', '请至少选择一种产品！')); return; }
    if (!custName.trim() || !custWa.trim()) { alert(t('Please fill in your name and WhatsApp number.', '请填写您的姓名和 WhatsApp 号码。')); return; }
    if (mode === 'delivery' && (!addrLine1.trim() || !city.trim() || !postcode.trim() || !state)) { alert(t('Please fill in all required delivery fields.', '请填写所有必填的送货资料。')); return; }

    let msg = `🍪 *New Order from Bitetime & Co.*\n\n`;
    msg += `*Name:* ${custName}\n*WhatsApp:* ${custWa}\n`;
    if (custDate) msg += `*Preferred date:* ${custDate}\n`;
    msg += `\n*Items:*\n`;

    let total = 0;
    Object.keys(selected).forEach(id => {
      const p = getProduct(id); if (!p) return;
      const q = qty[id] || 0, sub = p.price * q;
      total += sub;
      msg += `• ${p.name} × ${q} — RM ${sub}\n`;
    });

    if (mode === 'delivery') {
      const EM_STATES = ['Sabah', 'Sarawak', 'W.P. Labuan'];
      const region = EM_STATES.includes(state) ? 'EM' : 'WM';
      const fee = settings.shipping[region] || 0;
      total += fee;
      const fullAddress = [addrLine1, addrLine2, city, postcode, state].filter(Boolean).join(', ');
      msg += `\n*Delivery (${region}):* RM ${fee}\n*Address:* ${fullAddress}\n`;
    } else {
      msg += `\n*Order type:* Self-pickup\n`;
    }
    msg += `\n*Total: RM ${total}*`;

    try {
      const res = await fetch(`https://api.telegram.org/bot${settings.tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: settings.tgChatId, text: msg, parse_mode: 'Markdown' }),
      });
      const data = await res.json();
      if (data.ok) {
        const items = Object.keys(selected).map(id => {
          const p = getProduct(id);
          return { id, name: p.name, qty: qty[id] || 0, price: p.price };
        });
        const EM_STATES = ['Sabah', 'Sarawak', 'W.P. Labuan'];
        const region = mode === 'delivery' ? (EM_STATES.includes(state) ? 'EM' : 'WM') : null;
        await saveOrder({
          user_id: user?.id ?? null,
          customer_name: custName,
          customer_wa: custWa,
          preferred_date: custDate || null,
          mode,
          address: mode === 'delivery' ? [addrLine1, addrLine2, city, postcode, state].filter(Boolean).join(', ') : null,
          region,
          shipping_fee: region ? (settings.shipping[region] || 0) : 0,
          items,
          total: computeTotal(),
        });
        onSuccess();
      } else { alert(t('Failed to send order. Please try again.', '发送订单失败，请重试。')); }
    } catch {
      alert(t('Network error. Please check your connection.', '网络错误，请检查您的连接。'));
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
          <div className={'radio-opt' + (mode === 'pickup' ? ' active' : '')} onClick={() => setMode('pickup')}>{t('🚶 Self-pickup', '🚶 自取')}</div>
          <div className={'radio-opt' + (mode === 'delivery' ? ' active' : '')} onClick={() => setMode('delivery')}>{t('🛵 Delivery', '🛵 送货')}</div>
        </div>
      </div>

      {/* DELIVERY FIELDS */}
      {mode === 'delivery' && (
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
              <input type="text" placeholder={t('e.g. Sarah', '例如：小明')} value={custName} onChange={e => setCustName(e.target.value)} />
            </div>
            <div className="field">
              <label>{t('WhatsApp number', 'WhatsApp 号码')}</label>
              <input type="tel" placeholder="e.g. 011-2345678" value={custWa} onChange={e => setCustWa(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>{t('Preferred date', '预计日期')}</label>
            <input type="date" value={custDate} onChange={e => setCustDate(e.target.value)} />
          </div>
        </div>
      </div>

      <hr className="divider" />

      {/* SUMMARY */}
      <div className="summary-card">
        <div className="summary-title">{t('Order summary', '订单摘要')}</div>
        {!hasItems ? (
          <p className="empty-msg">{t('No items selected yet.', '尚未选择任何产品。')}</p>
        ) : (
          <>
            {selectedIds.map(id => {
              const p = getProduct(id); if (!p) return null;
              const q = qty[id] || 0;
              return <div key={id} className="summary-row"><span>{p.name} × {q} {p.unit}</span><span>RM {p.price * q}</span></div>;
            })}
            {mode === 'delivery' && state && (() => {
              const region = ['Sabah','Sarawak','W.P. Labuan'].includes(state) ? 'EM' : 'WM';
              return <div className="summary-row"><span>{t('Delivery', '送货')} ({region})</span><span>RM {settings.shipping[region] || 0}</span></div>;
            })()}
            <div className="summary-row total"><span>{t('Total', '总计')}</span><span>RM {computeTotal()}</span></div>
          </>
        )}
      </div>

      <button className="submit-btn" onClick={submitOrder}>{t('Submit order →', '提交订单 →')}</button>
      <p className="form-note">{t("Your order will be sent to us instantly. We'll confirm with you shortly! 🍪", '您的订单将立即发送给我们，我们会尽快与您确认！🍪')}</p>
    </>
  );
}
