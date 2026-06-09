import { useState } from 'react';
import { DEFAULTS, saveSettingsToDB } from '../store';

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
  const [saveMsg, setSaveMsg] = useState('');

  function updateProduct(i, field, value) {
    const updated = [...products];
    updated[i] = { ...updated[i], [field]: value };
    setProducts(updated);
  }

  function addProduct() {
    setProducts([...products, { id: 'item_' + Date.now(), name: '', desc: '', price: 0, unit: 'pc' }]);
  }

  function deleteProduct(i) {
    if (products.length <= 1) { alert(t('You need at least one product!', '至少需要一个产品！')); return; }
    setProducts(products.filter((_, idx) => idx !== i));
  }

  function handleSave() {
    console.log('[AdminPanel] handleSave clicked, products:', JSON.stringify(products));
    try {
      for (const p of products) {
        if (!p.name || !p.name.trim()) {
          console.log('[AdminPanel] Validation failed - empty name for product:', p);
          setSaveMsg(t('⚠ Please fill in all product names.', '⚠ 请填写所有产品名称。'));
          return;
        }
      }
      const newSettings = {
        products,
        shipping: { WM: parseFloat(wmFee) || 0, EM: parseFloat(emFee) || 0 },
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
        {{ menu: t('Menu', '菜单'), delivery: t('Delivery', '送货费'), bot: t('Bot Settings', '机器人设置'), email: t('Email Settings', '邮件设置') }[tab]}
      </div>

      <div className="admin-tab-content">

      {tab === 'menu' && (
        <div className="admin-section">
          <div className="admin-section-label">{t('Products', '产品')}</div>
          <div className="product-row-header">
            <span>{t('Name', '名称')}</span>
            <span className="desc-head">{t('Description', '描述')}</span>
            <span>{t('Unit', '单位')}</span>
            <span>{t('Price (RM)', '价格 (RM)')}</span>
            <span></span>
          </div>
          <div className="product-list">
            {products.map((p, i) => (
              <div className="product-row" key={p.id}>
                <input type="text" value={p.name} placeholder="Product name" onChange={e => updateProduct(i, 'name', e.target.value)} />
                <input type="text" className="desc-input" value={p.desc} placeholder="Description" onChange={e => updateProduct(i, 'desc', e.target.value)} />
                <input type="text" className="unit-input" value={p.unit} placeholder="pc" onChange={e => updateProduct(i, 'unit', e.target.value)} />
                <input type="number" className="price-input" value={p.price} min="0" step="0.50" onChange={e => updateProduct(i, 'price', parseFloat(e.target.value) || 0)} />
                <button className="del-btn" onClick={() => deleteProduct(i)} title="Remove">×</button>
              </div>
            ))}
          </div>
          <button className="add-btn" onClick={addProduct}>{t('+ Add product', '+ 添加产品')}</button>
        </div>
      )}

      {tab === 'delivery' && (
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

      {tab === 'delivery' && (
        <div className="admin-section" style={{ marginTop: '18px' }}>
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

      {tab === 'delivery' && (
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

      {tab === 'delivery' && (
        <div className="admin-section" style={{ marginTop: '18px' }}>
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

      <button className="save-btn" onClick={handleSave}>{t('💾 Save changes', '💾 保存更改')}</button>
      <p className="save-msg">{saveMsg}</p>
    </div>
  );
}
