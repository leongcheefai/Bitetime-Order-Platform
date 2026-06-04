import { useState, useEffect } from 'react';
import { fetchUserOrders, saveDeliveryAddress, loadDeliveryAddress } from '../store';
import { lookupPostcode } from '../postcodes';

export default function CustomerSettings({ user, lang, onAddressSaved }) {
  const t = (en, zh) => lang === 'zh' ? zh : en;

  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(true);

  const [addrLine1, setAddrLine1] = useState('');
  const [addrLine2, setAddrLine2] = useState('');
  const [city, setCity] = useState('');
  const [postcode, setPostcode] = useState('');
  const [state, setState] = useState('');
  const [addrName, setAddrName] = useState('');
  const [addrWa, setAddrWa] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  useEffect(() => {
    fetchUserOrders(user.id).then(data => { setOrders(data); setOrdersLoading(false); });
    loadDeliveryAddress(user.id).then(addr => {
      if (addr) {
        setAddrLine1(addr.line1 || '');
        setAddrLine2(addr.line2 || '');
        setCity(addr.city || '');
        setPostcode(addr.postcode || '');
        setState(addr.state || '');
        setAddrName(addr.name || '');
        setAddrWa(addr.wa || '');
      }
    });
  }, [user.id]);

  async function handleSave() {
    setSaving(true);
    const address = { line1: addrLine1, line2: addrLine2, city, postcode, state, name: addrName, wa: addrWa };
    await saveDeliveryAddress(user.id, address);
    setSaving(false);
    setSaveMsg(t('Saved!', '已保存！'));
    setTimeout(() => setSaveMsg(''), 2500);
    if (onAddressSaved) onAddressSaved(address);
  }

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(lang === 'zh' ? 'zh-MY' : 'en-MY', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  return (
    <div className="cust-settings">
      {/* ── Saved delivery address ── */}
      <div className="settings-section">
        <div className="settings-section-title">{t('Saved delivery address', '已保存的送货地址')}</div>
        <p className="settings-hint">{t('Save your details once — we\'ll pre-fill them next time you order.', '保存一次，下次下单自动填入。')}</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '1rem' }}>
          <div className="field-row">
            <div className="field">
              <label>{t('Your name', '您的姓名')}</label>
              <input type="text" placeholder={t('e.g. Sarah', '例如：小明')} value={addrName} onChange={e => setAddrName(e.target.value)} />
            </div>
            <div className="field">
              <label>{t('WhatsApp number', 'WhatsApp 号码')}</label>
              <input type="tel" placeholder="e.g. 011-2345678" value={addrWa} onChange={e => setAddrWa(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>{t('Address Line 1', '地址第一行')}</label>
            <input type="text" placeholder={t('Unit no. / Street name', '单位号码 / 街道名称')} value={addrLine1} onChange={e => setAddrLine1(e.target.value)} />
          </div>
          <div className="field">
            <label>{t('Address Line 2', '地址第二行')} <span style={{ fontSize: '11px', color: '#aaa', fontStyle: 'italic' }}>{t('optional', '选填')}</span></label>
            <input type="text" placeholder={t('Apartment, building, floor, etc.', '公寓、楼栋、楼层等')} value={addrLine2} onChange={e => setAddrLine2(e.target.value)} />
          </div>
          <div className="field-row">
            <div className="field">
              <label>{t('Postcode', '邮政编码')}</label>
              <input type="text" placeholder="e.g. 50480" maxLength={5} value={postcode} onChange={e => {
                const val = e.target.value.replace(/\D/g, '');
                setPostcode(val);
                if (val.length === 5) {
                  const result = lookupPostcode(val);
                  if (result) { setCity(result.city); setState(result.state); }
                }
              }} />
            </div>
            <div className="field">
              <label>{t('City', '城市')}</label>
              <input type="text" placeholder={t('e.g. Kuala Lumpur', '例如：吉隆坡')} value={city} onChange={e => setCity(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>{t('State', '州属')}</label>
            <select value={state} onChange={e => setState(e.target.value)}>
              <option value="">{t('— Select state —', '— 选择州属 —')}</option>
              {['Johor','Kedah','Kelantan','Melaka','Negeri Sembilan','Pahang','Perak','Perlis','Pulau Pinang','Sabah','Sarawak','Selangor','Terengganu','W.P. Kuala Lumpur','W.P. Labuan','W.P. Putrajaya'].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>

        <button className="save-btn" style={{ marginTop: '1rem' }} onClick={handleSave} disabled={saving}>
          {saving ? t('Saving…', '保存中…') : t('Save address', '保存地址')}
        </button>
        {saveMsg && <div className="save-msg">{saveMsg}</div>}
      </div>

      {/* ── Order history ── */}
      <div className="settings-section">
        <div className="settings-section-title">{t('Order history', '历史订单')}</div>
        {ordersLoading ? (
          <p className="settings-hint">{t('Loading…', '加载中…')}</p>
        ) : orders.length === 0 ? (
          <p className="settings-hint">{t('No orders yet. Place your first order!', '暂无订单，快来下第一单吧！')}</p>
        ) : (
          <div className="order-history-list">
            {orders.map((order, i) => (
              <div key={order.id ?? i} className="order-history-card">
                <div className="order-history-header">
                  <div className="order-history-date">{formatDate(order.created_at)}</div>
                  <div className="order-history-total">RM {order.total}</div>
                </div>
                <div className="order-history-meta">
                  <span className={'order-mode-badge' + (order.mode === 'delivery' ? ' delivery' : '')}>
                    {order.mode === 'delivery' ? t('Delivery', '送货') : t('Self-pickup', '自取')}
                  </span>
                  {order.preferred_date && <span className="order-history-pref">{t('Pref. date:', '预计日期：')} {order.preferred_date}</span>}
                </div>
                {order.items && order.items.length > 0 && (
                  <div className="order-history-items">
                    {order.items.map((item, j) => (
                      <div key={j} className="order-history-item">
                        <span>{item.name} × {item.qty}</span>
                        <span>RM {item.price * item.qty}</span>
                      </div>
                    ))}
                  </div>
                )}
                {order.address && (
                  <div className="order-history-addr">{order.address}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
