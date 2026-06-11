import { useState } from 'react';
import { DEFAULTS, saveSettingsToDB } from '../store';
import { geocodeAddress } from '../geo';

export default function AdminPanel({ settings, onSave, lang, tab = 'menu' }) {
  const t = (en, zh) => lang === 'zh' ? zh : en;
  const [products, setProducts] = useState(() => JSON.parse(JSON.stringify(settings.products)));
  const [wmFee, setWmFee] = useState(settings.shipping.WM);
  const [emFee, setEmFee] = useState(settings.shipping.EM);
  const [tgToken, setTgToken] = useState(settings.tgToken);
  const [tgChatId, setTgChatId] = useState(settings.tgChatId);
  const [ejsServiceId, setEjsServiceId] = useState(settings.ejsServiceId || '');
  const [ejsTemplateId, setEjsTemplateId] = useState(settings.ejsTemplateId || '');
  const [ejsShippingTemplateId, setEjsShippingTemplateId] = useState(settings.ejsShippingTemplateId || '');
  const [ejsPublicKey, setEjsPublicKey] = useState(settings.ejsPublicKey || '');
  const [availableDays, setAvailableDays] = useState(settings.availableDays ?? [1,2,3,4,5,6]);
  const [leadDays, setLeadDays] = useState(settings.leadDays ?? 3);
  const [blockedDates, setBlockedDates] = useState(settings.blockedDates ?? []);
  const [blockedDateInput, setBlockedDateInput] = useState('');
  const sd = settings.sameday ?? DEFAULTS.sameday;
  const [sdEnabled, setSdEnabled] = useState(sd.enabled ?? false);
  const [sdOrigin, setSdOrigin] = useState(sd.origin ?? '');
  const [sdOriginLat, setSdOriginLat] = useState(sd.originLat ?? null);
  const [sdOriginLng, setSdOriginLng] = useState(sd.originLng ?? null);
  const [sdBase, setSdBase] = useState(sd.base ?? 7);
  const [sdPerKm, setSdPerKm] = useState(sd.perKm ?? 1.5);
  const [sdMaxKm, setSdMaxKm] = useState(sd.maxKm ?? 20);
  const [sdSlots, setSdSlots] = useState(() => (sd.slots?.length ? sd.slots : DEFAULTS.sameday.slots).map(s => ({ ...s })));
  function updateSlot(i, field, value) {
    setSdSlots(prev => prev.map((s, idx) => idx === i ? { ...s, [field]: value } : s));
  }
  const [pickupAddress, setPickupAddress] = useState(settings.pickup?.address ?? '');
  const [pickupHours, setPickupHours] = useState(settings.pickup?.hours ?? '');
  const [paymentNote, setPaymentNote] = useState(settings.paymentNote ?? '');
  // address the current coords were geocoded from — re-geocode on save if it changed
  const [sdGeocodedFor, setSdGeocodedFor] = useState(sd.origin ?? '');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  function updateProduct(i, field, value) {
    const updated = [...products];
    updated[i] = { ...updated[i], [field]: value };
    setProducts(updated);
  }

  function addProduct() {
    setProducts([...products, { id: 'item_' + Date.now(), name: '', desc: '', price: 0, unit: 'pc', sameday: true, promoLabel: '', promoPrice: 0, promoLimit: 0, promoStart: new Date().toISOString().slice(0, 10), promoEnd: '' }]);
  }

  function deleteProduct(i) {
    if (products.length <= 1) { alert(t('You need at least one product!', '至少需要一个产品！')); return; }
    setProducts(products.filter((_, idx) => idx !== i));
  }

  async function handleSave() {
    console.log('[AdminPanel] handleSave clicked, products:', JSON.stringify(products));
    try {
      for (const p of products) {
        if (!p.name || !p.name.trim()) {
          console.log('[AdminPanel] Validation failed - empty name for product:', p);
          setSaveMsg(t('⚠ Please fill in all product names.', '⚠ 请填写所有产品名称。'));
          return;
        }
      }
      // Same-day delivery: geocode the store address automatically when needed
      let lat = sdOriginLat, lng = sdOriginLng;
      const origin = sdOrigin.trim();
      if (sdEnabled) {
        if (!origin) {
          setSaveMsg(t('⚠ Same-day delivery: please fill in your store address.', '⚠ 当天配送：请填写您的店铺地址。'));
          return;
        }
        if (lat == null || lng == null || origin !== sdGeocodedFor) {
          setSaving(true);
          setSaveMsg(t('📍 Locating your store address… (takes a few seconds)', '📍 正在定位店铺地址…（需要几秒钟）'));
          const coords = await geocodeAddress(origin);
          setSaving(false);
          if (!coords) {
            setSdOriginLat(null);
            setSdOriginLng(null);
            setSaveMsg(t('⚠ Address not found. Try a simpler address or just your postcode + city.', '⚠ 找不到地址。请尝试更简单的地址或只填邮编 + 城市。'));
            return;
          }
          lat = coords.lat; lng = coords.lng;
          setSdOriginLat(lat);
          setSdOriginLng(lng);
          setSdGeocodedFor(origin);
        }
      }
      const newSettings = {
        products,
        shipping: { WM: parseFloat(wmFee) || 0, EM: parseFloat(emFee) || 0 },
        sameday: {
          enabled: sdEnabled,
          origin,
          originLat: lat,
          originLng: lng,
          base: parseFloat(sdBase) || 0,
          perKm: parseFloat(sdPerKm) || 0,
          maxKm: parseFloat(sdMaxKm) || 0,
          slots: sdSlots
            .map(s => ({ label: (s.label || '').trim(), cutoff: Math.min(23, Math.max(0, parseInt(s.cutoff) || 0)) }))
            .filter(s => s.label),
        },
        pickup: { address: pickupAddress.trim(), hours: pickupHours.trim() },
        paymentNote: paymentNote.trim(),
        tgToken: tgToken.trim() || DEFAULTS.tgToken,
        tgChatId: tgChatId.trim() || DEFAULTS.tgChatId,
        ejsServiceId: ejsServiceId.trim(),
        ejsTemplateId: ejsTemplateId.trim(),
        ejsShippingTemplateId: ejsShippingTemplateId.trim(),
        ejsPublicKey: ejsPublicKey.trim(),
        availableDays,
        leadDays: parseInt(leadDays) || 1,
        blockedDates,
      };
      console.log('[AdminPanel] Saving settings:', JSON.stringify(newSettings));
      saveSettingsToDB(newSettings);
      onSave(newSettings);
      setSaveMsg(t('✓ Saved!', '✓ 已保存！'));
      setTimeout(() => setSaveMsg(''), 2500);
    } catch (err) {
      console.error('[AdminPanel] Save error:', err);
      setSaveMsg('⚠ Error: ' + err.message);
    }
  }

  return (
    <div className="admin-panel">
      <div className="admin-title">
        <span>✏️</span>{' '}
        {{ menu: t('Menu', '菜单'), shipping: t('Delivery & Shipping', '送货费用'), pickup: t('Pickup & Payment', '自取与付款'), schedule: t('Order Schedule', '下单日期'), bot: t('Bot Settings', '机器人设置'), email: t('Email Settings', '邮件设置') }[tab]}
      </div>

      <div className="admin-tab-content">

      {tab === 'menu' && (
        <div className="admin-section">
          <div className="admin-section-label">{t('Products', '产品')}</div>
          <p style={{ fontSize: '12px', color: '#888', marginBottom: '8px' }}>
            {t('⚡ = available for same-day delivery. Untick products that need more lead time.', '⚡ = 可当天配送。需要更长准备时间的产品请取消勾选。')}
          </p>
          <div className="product-row-header">
            <span>{t('Name', '名称')}</span>
            <span className="desc-head">{t('Description', '描述')}</span>
            <span>{t('Unit', '单位')}</span>
            <span>{t('Price (RM)', '价格 (RM)')}</span>
            <span title={t('Available for same-day delivery', '可当天配送')}>⚡</span>
            <span></span>
          </div>
          <div className="product-list">
            {products.map((p, i) => (
              <div className="product-row" key={p.id}>
                <input type="text" value={p.name} placeholder="Product name" onChange={e => updateProduct(i, 'name', e.target.value)} />
                <input type="text" className="desc-input" value={p.desc} placeholder="Description" onChange={e => updateProduct(i, 'desc', e.target.value)} />
                <input type="text" className="unit-input" value={p.unit} placeholder="pc" onChange={e => updateProduct(i, 'unit', e.target.value)} />
                <input type="number" className="price-input" value={p.price} min="0" step="0.50" onChange={e => updateProduct(i, 'price', parseFloat(e.target.value) || 0)} />
                <span className="sameday-toggle" title={t('Available for same-day delivery', '可当天配送')}>
                  <input type="checkbox" checked={p.sameday !== false} onChange={e => updateProduct(i, 'sameday', e.target.checked)} />
                </span>
                <button className="del-btn" onClick={() => deleteProduct(i)} title="Remove">×</button>
                <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px', color: '#A07070', paddingTop: '4px' }}>
                  <span>🎉 {t('Promo', '优惠')}:</span>
                  <input type="text" style={{ width: '120px' }} placeholder={t('name e.g. Launch', '名称 如 开张优惠')} value={p.promoLabel || ''} onChange={e => updateProduct(i, 'promoLabel', e.target.value)} />
                  <span>{t('price RM', '优惠价 RM')}</span>
                  <input type="number" min="0" step="0.50" style={{ width: '80px' }} value={p.promoPrice ?? 0} onChange={e => updateProduct(i, 'promoPrice', parseFloat(e.target.value) || 0)} />
                  <span>{t('from', '从')}</span>
                  <input type="date" style={{ width: '140px' }} value={p.promoStart || ''} onChange={e => updateProduct(i, 'promoStart', e.target.value)} />
                  <span>{t('for first', '限量前')}</span>
                  <input type="number" min="0" step="1" style={{ width: '70px' }} value={p.promoLimit ?? 0} onChange={e => updateProduct(i, 'promoLimit', parseInt(e.target.value) || 0)} />
                  <span>{t('pcs', '个')}</span>
                  <span>{t('or until', '或截止')}</span>
                  <input type="date" style={{ width: '140px' }} value={p.promoEnd || ''} onChange={e => updateProduct(i, 'promoEnd', e.target.value)} />
                  <span>{t('(limit 0 & no date = off)', '(限量 0 且无日期 = 关闭)')}</span>
                </div>
              </div>
            ))}
          </div>
          <button className="add-btn" onClick={addProduct}>{t('+ Add product', '+ 添加产品')}</button>
        </div>
      )}

      {tab === 'shipping' && (
        <div className="admin-section">
          <div className="admin-section-label">{t('Delivery fees', '送货费')}</div>
          <div className="admin-fields">
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>{t('West Malaysia (WM) — RM', '西马来西亚 (WM) — RM')}</label>
              <input type="number" min="0" value={wmFee} onChange={e => setWmFee(e.target.value)} />
            </div>
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>{t('East Malaysia / Sabah / Sarawak (EM) — RM', '东马来西亚 / 沙巴 / 砂拉越 (EM) — RM')}</label>
              <input type="number" min="0" value={emFee} onChange={e => setEmFee(e.target.value)} />
            </div>
          </div>
        </div>
      )}

      {tab === 'shipping' && (
        <div className="admin-section" style={{ marginTop: '18px' }}>
          <div className="admin-section-label">{t('Same-day delivery (Lalamove / Grab Express)', '当天配送（Lalamove / Grab Express）')}</div>
          <p style={{ fontSize: '12px', color: '#888', marginBottom: '10px' }}>
            {t(
              'Customers within range get a same-day option. Fee is estimated by driving distance: base fee + rate × km.',
              '范围内的顾客可选择当天配送。运费按行车距离估算：基础费 + 每公里费率 × 公里。'
            )}
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 600, color: '#7a2828', marginBottom: '12px', cursor: 'pointer' }}>
            <input type="checkbox" checked={sdEnabled} onChange={e => setSdEnabled(e.target.checked)} />
            {t('Enable same-day delivery', '启用当天配送')}
          </label>
          <div className="admin-fields">
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>{t('Store / pickup address (where the rider collects)', '店铺 / 取货地址（骑手取货地点）')}</label>
              <input type="text" placeholder={t('e.g. 12 Jalan Example, 47301 Petaling Jaya, Selangor', '例如：12 Jalan Example, 47301 Petaling Jaya, Selangor')} value={sdOrigin} onChange={e => setSdOrigin(e.target.value)} />
              <p style={{ fontSize: '11px', color: '#aaa', marginTop: '4px' }}>
                {t('Located automatically when you save.', '保存时会自动定位。')}
                {sdOriginLat != null && sdOrigin.trim() === sdGeocodedFor && <span style={{ color: '#2e7d32' }}> ✓ {sdOriginLat.toFixed(5)}, {sdOriginLng.toFixed(5)}</span>}
              </p>
            </div>
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>{t('Base fee — RM', '基础费 — RM')}</label>
              <input type="number" min="0" step="0.5" value={sdBase} onChange={e => setSdBase(e.target.value)} />
            </div>
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>{t('Rate per km — RM', '每公里费率 — RM')}</label>
              <input type="number" min="0" step="0.1" value={sdPerKm} onChange={e => setSdPerKm(e.target.value)} />
            </div>
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>{t('Max distance — km (0 = no limit)', '最远距离 — 公里（0 = 无限制）')}</label>
              <input type="number" min="0" step="1" value={sdMaxKm} onChange={e => setSdMaxKm(e.target.value)} />
            </div>
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>{t('Delivery time slots — customer picks one', '送达时段 — 顾客选择其一')}</label>
              {sdSlots.map((s, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <input type="text" placeholder={t('e.g. 10:00 AM – 12:00 PM', '例如 10:00 AM – 12:00 PM')} value={s.label} onChange={e => updateSlot(i, 'label', e.target.value)} style={{ flex: 1 }} />
                  <span style={{ fontSize: '12px', color: '#888', whiteSpace: 'nowrap' }}>{t('cutoff', '截单')}</span>
                  <input type="number" min="0" max="23" step="1" value={s.cutoff} onChange={e => updateSlot(i, 'cutoff', e.target.value)} style={{ width: '70px' }} />
                </div>
              ))}
              <p style={{ fontSize: '11px', color: '#aaa', marginTop: '4px' }}>
                {t('Each slot disappears after its cutoff hour (24h). e.g. cutoff 10 = slot no longer selectable from 10:00 AM. Customers can order any time before that — even early morning.', '每个时段过了截单时间（24小时制）就不可选。例如截单 10 = 早上 10 点起该时段不可选。顾客可以在截单前任何时间下单，包括清晨。')}
              </p>
            </div>
          </div>
        </div>
      )}

      {tab === 'pickup' && (
        <div className="admin-section">
          <div className="admin-section-label">{t('Self-pickup info', '自取信息')}</div>
          <p style={{ fontSize: '12px', color: '#888', marginBottom: '10px' }}>
            {t('Shown to customers who choose self-pickup, and on the order success page.', '选择自取的顾客会看到这些信息，下单成功页也会显示。')}
          </p>
          <div className="admin-fields">
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>{t('Pickup address', '取货地址')}</label>
              <input type="text" placeholder={t('e.g. 12 Jalan Example, 47301 Petaling Jaya', '例如：12 Jalan Example, 47301 Petaling Jaya')} value={pickupAddress} onChange={e => setPickupAddress(e.target.value)} />
            </div>
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>{t('Pickup hours', '取货时间')}</label>
              <input type="text" placeholder={t('e.g. Mon–Sat 10am–6pm', '例如：周一至周六 10am–6pm')} value={pickupHours} onChange={e => setPickupHours(e.target.value)} />
            </div>
          </div>
        </div>
      )}

      {tab === 'pickup' && (
        <div className="admin-section" style={{ marginTop: '18px' }}>
          <div className="admin-section-label">{t('Payment instructions', '付款说明')}</div>
          <p style={{ fontSize: '12px', color: '#888', marginBottom: '10px' }}>
            {t('Shown on the order success page, e.g. bank transfer / TNG details. Leave empty to hide.', '显示在下单成功页，例如银行转账 / TNG 资料。留空则不显示。')}
          </p>
          <textarea
            rows={3}
            placeholder={t('e.g. Please transfer to Maybank 1234567890 (Bitetime & Co.) and send the receipt via WhatsApp.', '例如：请转账至 Maybank 1234567890 (Bitetime & Co.)，并通过 WhatsApp 发送收据。')}
            value={paymentNote}
            onChange={e => setPaymentNote(e.target.value)}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '13px', padding: '8px 10px', borderRadius: '8px', border: '1.5px solid #ddd' }}
          />
        </div>
      )}

      {tab === 'schedule' && (
        <div className="admin-section">
          <div className="admin-section-label">{t('Available order days', '可下单日期')}</div>
          <p style={{ fontSize: '12px', color: '#888', marginBottom: '10px' }}>
            {t('Customers can only pick dates on the selected days.', '顾客只能选择已勾选的日期。')}
          </p>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {[
              { day: 0, en: 'Sun', zh: '日' },
              { day: 1, en: 'Mon', zh: '一' },
              { day: 2, en: 'Tue', zh: '二' },
              { day: 3, en: 'Wed', zh: '三' },
              { day: 4, en: 'Thu', zh: '四' },
              { day: 5, en: 'Fri', zh: '五' },
              { day: 6, en: 'Sat', zh: '六' },
            ].map(({ day, en, zh }) => {
              const active = availableDays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => setAvailableDays(active ? availableDays.filter(d => d !== day) : [...availableDays, day].sort())}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '20px',
                    border: '1.5px solid',
                    borderColor: active ? '#7a2828' : '#ccc',
                    background: active ? '#7a2828' : '#fff',
                    color: active ? '#fff' : '#888',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {t(en, zh)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'schedule' && (
        <div className="admin-section" style={{ marginTop: '18px' }}>
          <div className="admin-section-label">{t('Minimum lead time (days)', '最少提前天数')}</div>
          <p style={{ fontSize: '12px', color: '#888', marginBottom: '10px' }}>
            {t('Customers must order at least this many days in advance.', '顾客必须提前此天数下单。')}
          </p>
          <input
            type="number"
            min="1"
            max="30"
            value={leadDays}
            onChange={e => setLeadDays(e.target.value)}
            style={{ width: '80px' }}
          />
        </div>
      )}

      {tab === 'schedule' && (
        <div className="admin-section">
          <div className="admin-section-label">{t('Blocked dates', '封锁日期')}</div>
          <p style={{ fontSize: '12px', color: '#888', marginBottom: '10px' }}>
            {t('These specific dates will be unavailable (e.g. public holidays).', '这些日期将无法选择（例如公共假日）。')}
          </p>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
            <input
              type="date"
              value={blockedDateInput}
              onChange={e => setBlockedDateInput(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="add-btn"
              style={{ margin: 0, whiteSpace: 'nowrap' }}
              onClick={() => {
                if (!blockedDateInput || blockedDates.includes(blockedDateInput)) return;
                setBlockedDates([...blockedDates, blockedDateInput].sort());
                setBlockedDateInput('');
              }}
            >
              {t('+ Add', '+ 添加')}
            </button>
          </div>
          {blockedDates.length === 0 && (
            <p style={{ fontSize: '12px', color: '#bbb' }}>{t('No blocked dates.', '无封锁日期。')}</p>
          )}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {blockedDates.map(d => (
              <span key={d} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 10px', borderRadius: '20px', background: '#f5e8e8', border: '1.5px solid #d9a0a0', fontSize: '13px', color: '#7a2828' }}>
                {d}
                <button
                  type="button"
                  onClick={() => setBlockedDates(blockedDates.filter(x => x !== d))}
                  style={{ background: 'none', border: 'none', color: '#7a2828', cursor: 'pointer', padding: '0', lineHeight: 1, fontSize: '14px' }}
                >×</button>
              </span>
            ))}
          </div>
        </div>
      )}

      {tab === 'bot' && (
        <div className="admin-section">
          <div className="admin-section-label">Telegram Bot Settings</div>
          <div className="admin-fields">
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>Bot Token (from @BotFather)</label>
              <input type="text" placeholder="123456789:AAFxxxxxxxxxxxxxxx" value={tgToken} onChange={e => setTgToken(e.target.value)} />
            </div>
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>Your Chat ID (from @userinfobot)</label>
              <input type="text" placeholder="123456789" value={tgChatId} onChange={e => setTgChatId(e.target.value)} />
            </div>
          </div>
        </div>
      )}

      {tab === 'email' && (
        <div className="admin-section">
          <div className="admin-section-label">EmailJS — Order Confirmation Email</div>
          <p style={{ fontSize: '12px', color: '#888', marginBottom: '10px' }}>
            {t(
              'Logged-in customers will receive a confirmation email after placing an order. Set up at emailjs.com — create a service, then a template using these variables: {{to_name}}, {{to_email}}, {{order_summary}}, {{order_total}}, {{order_type}}.',
              '登录客户下单后将收到确认邮件。在 emailjs.com 设置 — 创建服务，然后使用以下变量创建模板：{{to_name}}、{{to_email}}、{{order_summary}}、{{order_total}}、{{order_type}}。'
            )}
          </p>
          <div className="admin-fields">
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>Service ID</label>
              <input type="text" placeholder="service_xxxxxxx" value={ejsServiceId} onChange={e => setEjsServiceId(e.target.value)} />
            </div>
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>Order Confirmation Template ID</label>
              <input type="text" placeholder="template_xxxxxxx" value={ejsTemplateId} onChange={e => setEjsTemplateId(e.target.value)} />
            </div>
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>Shipping Notification Template ID</label>
              <p style={{ fontSize: '11px', color: '#aaa', margin: '2px 0 4px' }}>
                {t(
                  'Sent once when order status changes to "Out for Delivery". Template variables: {{to_name}}, {{to_email}}, {{order_number}}, {{tracking_number}}.',
                  '订单状态改为"派送中"时发送一次。模板变量：{{to_name}}、{{to_email}}、{{order_number}}、{{tracking_number}}。'
                )}
              </p>
              <input type="text" placeholder="template_xxxxxxx" value={ejsShippingTemplateId} onChange={e => setEjsShippingTemplateId(e.target.value)} />
            </div>
            <div className="admin-field full">
              <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>Public Key</label>
              <input type="text" placeholder="xxxxxxxxxxxxxxxx" value={ejsPublicKey} onChange={e => setEjsPublicKey(e.target.value)} />
            </div>
          </div>
        </div>
      )}

      </div>{/* admin-tab-content */}

      <button className="save-btn" onClick={handleSave} disabled={saving}>{saving ? t('📍 Locating…', '📍 定位中…') : t('💾 Save changes', '💾 保存更改')}</button>
      <p className="save-msg">{saveMsg}</p>
    </div>
  );
}
