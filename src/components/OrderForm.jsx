import { useState } from 'react';

export default function OrderForm({ settings, lang, onSuccess }) {
  const t = (en, zh) => lang === 'zh' ? zh : en;

  const [selected, setSelected] = useState({});
  const [qty, setQty] = useState({});
  const [mode, setMode] = useState('pickup');
  const [region, setRegion] = useState('');
  const [address, setAddress] = useState('');
  const [custName, setCustName] = useState('');
  const [custWa, setCustWa] = useState('');
  const [custDate, setCustDate] = useState('');

  function toggleCookie(id) {
    setSelected(prev => {
      const next = { ...prev };
      if (next[id]) delete next[id]; else next[id] = true;
      return next;
    });
    setQty(prev => ({ ...prev, [id]: prev[id] || 1 }));
  }

  function changeQty(e, id, delta) {
    e.stopPropagation();
    setQty(prev => ({ ...prev, [id]: Math.max(1, (prev[id] || 1) + delta) }));
  }

  function getProduct(id) { return settings.products.find(p => p.id === id); }

  function computeTotal() {
    let total = 0;
    Object.keys(selected).forEach(id => {
      const p = getProduct(id); if (!p) return;
      total += p.price * (qty[id] || 1);
    });
    if (mode === 'delivery' && region) total += settings.shipping[region] || 0;
    return total;
  }

  async function submitOrder() {
    if (!Object.keys(selected).length) { alert(t('Please select at least one item!', '请至少选择一种产品！')); return; }
    if (!custName.trim() || !custWa.trim()) { alert(t('Please fill in your name and WhatsApp number.', '请填写您的姓名和 WhatsApp 号码。')); return; }
    if (mode === 'delivery' && (!region || !address.trim())) { alert(t('Please fill in your delivery region and address.', '请填写送货地区和地址。')); return; }

    let msg = `🍪 *New Order from Bitetime & Co.*\n\n`;
    msg += `*Name:* ${custName}\n*WhatsApp:* ${custWa}\n`;
    if (custDate) msg += `*Preferred date:* ${custDate}\n`;
    msg += `\n*Items:*\n`;

    let total = 0;
    Object.keys(selected).forEach(id => {
      const p = getProduct(id); if (!p) return;
      const q = qty[id] || 1, sub = p.price * q;
      total += sub;
      msg += `• ${p.name} × ${q} — RM ${sub}\n`;
    });

    if (mode === 'delivery') {
      const fee = settings.shipping[region] || 0;
      total += fee;
      msg += `\n*Delivery (${region}):* RM ${fee}\n*Address:* ${address}\n`;
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
      if (data.ok) { onSuccess(); }
      else { alert(t('Failed to send order. Please try again.', '发送订单失败，请重试。')); }
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
          <div className="how-to-step"><span className="step-num">2</span><span dangerouslySetInnerHTML={{ __html: t('Choose <strong>Self-pickup</strong> or <strong>Delivery</strong> — if delivery, select your region and enter your address.', '选择<strong>自取</strong>或<strong>送货</strong> — 若选送货，请选择地区并填写地址。') }} /></div>
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
              <div className="cookie-name">{p.name}</div>
              <div className="cookie-desc">{p.desc}</div>
              <div className="cookie-price">RM {p.price} / {p.unit}</div>
              <div className="qty-row">
                <label>{t('Qty', '数量')} ({p.unit}s)</label>
                <div className="qty-ctrl">
                  <button className="qty-btn" onClick={e => changeQty(e, p.id, -1)}>−</button>
                  <span className="qty-val">{qty[p.id] || 1}</span>
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
              <label>{t('Region', '地区')}</label>
              <select value={region} onChange={e => setRegion(e.target.value)}>
                <option value="">{t('— Select region —', '— 选择地区 —')}</option>
                <option value="WM">{t(`West Malaysia (WM) — RM ${settings.shipping.WM}`, `西马来西亚 (WM) — RM ${settings.shipping.WM}`)}</option>
                <option value="EM">{t(`East Malaysia / Sabah / Sarawak (EM) — RM ${settings.shipping.EM}`, `东马 / 沙巴 / 砂拉越 (EM) — RM ${settings.shipping.EM}`)}</option>
              </select>
            </div>
            <div className="field">
              <label>{t('Delivery address', '送货地址')}</label>
              <input type="text" placeholder={t('Full address including postcode', '完整地址（含邮政编码）')} value={address} onChange={e => setAddress(e.target.value)} />
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
              const q = qty[id] || 1;
              return <div key={id} className="summary-row"><span>{p.name} × {q} {p.unit}</span><span>RM {p.price * q}</span></div>;
            })}
            {mode === 'delivery' && region && (
              <div className="summary-row"><span>{t('Delivery', '送货')} ({region})</span><span>RM {settings.shipping[region] || 0}</span></div>
            )}
            <div className="summary-row total"><span>{t('Total', '总计')}</span><span>RM {computeTotal()}</span></div>
          </>
        )}
      </div>

      <button className="submit-btn" onClick={submitOrder}>{t('Submit order →', '提交订单 →')}</button>
      <p className="form-note">{t("Your order will be sent to us instantly. We'll confirm with you shortly! 🍪", '您的订单将立即发送给我们，我们会尽快与您确认！🍪')}</p>
    </>
  );
}
