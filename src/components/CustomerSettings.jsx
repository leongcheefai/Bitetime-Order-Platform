import { useState, useEffect } from 'react';
import { fetchUserOrders, saveDeliveryAddress, loadDeliveryAddress, loadVouchers, loadOrderStatuses, loadOrderAWBs } from '../store';
import { lookupPostcode } from '../postcodes';

const CUST_STATUS = {
  pending:   { en: 'Order Received',   zh: '已收到订单',   cls: 'cust-status-received'  },
  confirmed: { en: 'Order Confirmed',  zh: '订单已确认',   cls: 'cust-status-confirmed' },
  preparing: { en: 'Ready to Deliver', zh: '准备送货',      cls: 'cust-status-preparing' },
  ready:     { en: 'Out for Delivery', zh: '派送中',       cls: 'cust-status-ready'     },
  completed: { en: 'Completed',        zh: '已完成',       cls: 'cust-status-completed' },
  cancelled: { en: 'Cancelled',        zh: '已取消',       cls: 'cust-status-cancelled' },
};

export default function CustomerSettings({ user, lang, onAddressSaved, refreshKey, section = 'details' }) {
  const t = (en, zh) => lang === 'zh' ? zh : en;

  const [orders, setOrders] = useState([]);
  const [orderStatuses, setOrderStatuses] = useState({});
  const [orderAWBs, setOrderAWBs] = useState({});
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [expandedOrders, setExpandedOrders] = useState({});
  const toggleOrder = (key) => setExpandedOrders(prev => ({ ...prev, [key]: !prev[key] }));
  const [myVouchers, setMyVouchers] = useState([]);
  const [vouchersLoading, setVouchersLoading] = useState(true);

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
    Promise.all([fetchUserOrders(user.id), loadOrderStatuses(), loadOrderAWBs()]).then(([data, statuses, awbs]) => {
      setOrders(data);
      setOrderStatuses(statuses);
      setOrderAWBs(awbs);
      setOrdersLoading(false);
      if (data.length > 0) {
        const latestKey = data[0].id ?? 0;
        setExpandedOrders({ [latestKey]: true });
      }
    });
    loadVouchers().then(all => {
      const email = user.email?.toLowerCase() ?? '';
      setMyVouchers(all.filter(v => !v.email || v.email === email));
      setVouchersLoading(false);
    });
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
  }, [user.id, refreshKey]);

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

      {/* ── Personal Details ── */}
      {section === 'details' && (
        <div className="settings-section">
          <div className="settings-section-title">{t('Saved delivery address', '已保存的送货地址')}</div>
          <p className="settings-hint">{t('Save your details once — we\'ll pre-fill them next time you order.', '保存一次，下次下单自动填入。')}</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '1rem' }}>
            <div className="field-row">
              <div className="field">
                <label>{t('Your name', '您的姓名')}</label>
                <input type="text" placeholder={t('Your name', '您的名字')} value={addrName} onChange={e => setAddrName(e.target.value)} />
              </div>
              <div className="field">
                <label>{t('WhatsApp number', 'WhatsApp 号码')}</label>
                <input type="tel" placeholder="e.g. 011-2345678" value={addrWa} onChange={e => setAddrWa(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label>{t('Email address', '电子邮件')}</label>
              <input type="email" value={user.email || ''} readOnly style={{ background: '#f5f5f5', cursor: 'default', color: '#888' }} />
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
      )}

      {/* ── Vouchers ── */}
      {section === 'vouchers' && (
        <div className="settings-section">
          <div className="settings-section-title">{t('My Vouchers', '我的优惠券')}</div>
          {vouchersLoading ? (
            <p className="settings-hint">{t('Loading…', '加载中…')}</p>
          ) : myVouchers.length === 0 ? (
            <p className="settings-hint">{t('No vouchers yet. Stay tuned for promotions!', '暂无优惠券，敬请期待！')}</p>
          ) : (
            <div className="voucher-list">
              {myVouchers.map((v, i) => {
                const expired = !v.used && v.expiresAt && new Date(v.expiresAt) < new Date();
                const statusClass = v.used ? ' used' : expired ? ' used' : ' active';
                const statusLabel = v.used
                  ? t('Used', '已使用')
                  : expired
                  ? t('Expired', '已过期')
                  : t('Active', '有效');
                return (
                  <div key={i} className={'voucher-row' + (v.used || expired ? ' used' : '')}>
                    <div className="voucher-code">{v.code}</div>
                    <div className="voucher-meta">
                      <span className="voucher-discount">
                        {v.type === 'percent' ? `${v.value}% off` : `RM ${v.value} off`}
                      </span>
                      {v.minOrder && (
                        <span className="voucher-minorder">
                          {t(`Min. spend RM ${v.minOrder}`, `最低消费 RM ${v.minOrder}`)}
                        </span>
                      )}
                      {v.expiresAt && (
                        <span className={'voucher-expiry' + (expired ? ' expired' : '')}>
                          {expired
                            ? t(`Expired ${new Date(v.expiresAt).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })}`, `已于 ${new Date(v.expiresAt).toLocaleDateString('zh-MY', { day: 'numeric', month: 'short', year: 'numeric' })} 过期`)
                            : t(`Expires ${new Date(v.expiresAt).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })}`, `有效期至 ${new Date(v.expiresAt).toLocaleDateString('zh-MY', { day: 'numeric', month: 'short', year: 'numeric' })}`)}
                        </span>
                      )}
                    </div>
                    <div className={'voucher-status' + statusClass}>
                      {statusLabel}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Order History ── */}
      {section === 'history' && (
        <div className="settings-section settings-section--history">
          <div className="settings-section-title">{t('Order history', '历史订单')}</div>
          {ordersLoading ? (
            <p className="settings-hint">{t('Loading…', '加载中…')}</p>
          ) : orders.length === 0 ? (
            <p className="settings-hint">{t('No orders yet. Place your first order!', '暂无订单，快来下第一单吧！')}</p>
          ) : (
            <div className="order-history-list">
              {orders.map((order, i) => {
                const key = order.id ?? i;
                const expanded = !!expandedOrders[key];
                const label = order.order_number || formatDate(order.created_at);
                return (
                  <div key={key} className="order-accordion">
                    {/* Collapsed header — always visible */}
                    <button className="order-accordion-header" onClick={() => toggleOrder(key)}>
                      <div className="order-accordion-left">
                        <span className="order-accordion-num">{label}</span>
                        {!expanded && order.items && order.items.length > 0 && (
                          <span className="order-accordion-preview">
                            {order.items.map(it => `${it.name} ×${it.qty}`).join(', ')}
                          </span>
                        )}
                      </div>
                      <div className="order-accordion-right">
                        {(() => {
                          const s = orderStatuses[order.order_number] || 'pending';
                          const info = CUST_STATUS[s] || CUST_STATUS.pending;
                          return <span className={'cust-status-badge ' + info.cls}>{t(info.en, info.zh)}</span>;
                        })()}
                        <span className="order-accordion-total">RM {order.total}</span>
                        <span className="order-accordion-chevron">{expanded ? '▲' : '▼'}</span>
                      </div>
                    </button>

                    {/* Expanded detail — same layout as order summary */}
                    {expanded && (
                      <div className="order-accordion-body">
                        <div style={{ fontSize: '12px', color: '#A07070', marginBottom: '10px' }}>{formatDate(order.created_at)}</div>

                        {orderAWBs[order.order_number] && (
                          <div className="cust-awb-box">
                            <div className="cust-awb-label">{t('Tracking / AWB Number', '追踪号码')}</div>
                            <div className="cust-awb-num">{orderAWBs[order.order_number]}</div>
                          </div>
                        )}

                        <div className="summary-section-label">{t('Your details', '您的资料')}</div>
                        <div className="summary-section">
                          <div className="summary-detail-grid">
                            {order.customer_name && <div className="summary-detail-cell"><span className="detail-label">{t('Name', '姓名')}</span><span className="detail-value">{order.customer_name}</span></div>}
                            {order.customer_wa && <div className="summary-detail-cell"><span className="detail-label">{t('Phone', '电话')}</span><span className="detail-value">{order.customer_wa}</span></div>}
                            <div className="summary-detail-cell"><span className="detail-label">{t('Order type', '订单类型')}</span><span className="detail-value">{order.mode === 'delivery' ? t('Delivery', '送货') : order.mode === 'sameday' ? t('Same-day delivery ⚡', '当天配送 ⚡') : t('Self-pickup', '自取')}</span></div>
                            {order.preferred_date && <div className="summary-detail-cell"><span className="detail-label">{t('Preferred date', '预计日期')}</span><span className="detail-value">{order.preferred_date}</span></div>}
                            {order.address && (
                              <div className="summary-detail-cell" style={{ gridColumn: '1 / -1' }}>
                                <span className="detail-label">{t('Delivery address', '送货地址')}</span>
                                <span className="detail-value">{order.address}</span>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="summary-section-label" style={{ marginTop: '12px' }}>{t('Your order', '您的订单')}</div>
                        {order.items && order.items.length > 0 && (
                          <div className="summary-section">
                            {order.items.map((item, j) => (
                              <div key={j} className="summary-row">
                                <span>{item.name} × {item.qty}</span>
                                <span>RM {item.price * item.qty}</span>
                              </div>
                            ))}
                            {(order.mode === 'delivery' || order.mode === 'sameday') && order.shipping_fee > 0 && (
                              <div className="summary-row">
                                <span>{order.mode === 'sameday' ? t('Same-day delivery', '当天配送') : <>{t('Delivery', '送货')} {order.region ? `(${order.region})` : ''}</>}</span>
                                <span>RM {order.shipping_fee}</span>
                              </div>
                            )}
                            <div className="summary-row total">
                              <span>{t('Total', '总计')}</span>
                              <span>RM {order.total}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
