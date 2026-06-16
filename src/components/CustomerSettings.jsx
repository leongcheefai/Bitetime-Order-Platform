import { useState, useEffect } from 'react';
import { fetchUserOrders, saveDeliveryAddress, loadDeliveryAddress, loadVouchers, loadOrderStatuses, loadOrderAWBs, loadReferralRewards, referralCodeOf } from '../store';
import { lookupPostcode } from '../postcodes';

const CUST_STATUS = {
  pending:   { en: 'Order Received',   zh: '已收到订单',   cls: 'cust-status-received'  },
  confirmed: { en: 'Order Confirmed',  zh: '订单已确认',   cls: 'cust-status-confirmed' },
  preparing: { en: 'Ready to Deliver', zh: '准备送货',      cls: 'cust-status-preparing' },
  ready:     { en: 'Out for Delivery', zh: '派送中',       cls: 'cust-status-ready'     },
  completed: { en: 'Completed',        zh: '已完成',       cls: 'cust-status-completed' },
  cancelled: { en: 'Cancelled',        zh: '已取消',       cls: 'cust-status-cancelled' },
};

export default function CustomerSettings({ user, lang, settings = {}, onAddressSaved, refreshKey, section = 'details' }) {
  const t = (en, zh) => lang === 'zh' ? zh : en;

  const [orders, setOrders] = useState([]);
  const [orderStatuses, setOrderStatuses] = useState({});
  const [orderAWBs, setOrderAWBs] = useState({});
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [expandedOrders, setExpandedOrders] = useState({});
  const toggleOrder = (key) => setExpandedOrders(prev => ({ ...prev, [key]: !prev[key] }));
  const [myVouchers, setMyVouchers] = useState([]);
  const [vouchersLoading, setVouchersLoading] = useState(true);
  const [myRewards, setMyRewards] = useState([]);
  const [copyMsg, setCopyMsg] = useState('');

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
    if (settings.referral?.enabled) {
      loadReferralRewards().then(all => setMyRewards(all.filter(r => r.referrerUserId === user.id))).catch(() => {});
    }
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
  }, [user.id, user.email, refreshKey, settings.referral?.enabled]);

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

  function generateInvoice(order) {
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const money = (n) => Number(n || 0).toFixed(2);
    const modeLabel = order.mode === 'delivery' ? t('Delivery', '送货')
      : order.mode === 'sameday' ? t('Same-day delivery', '当天配送')
      : t('Self-pickup', '自取');
    const items = (order.items || []).map(it => `
      <tr>
        <td>${esc(it.name)}</td>
        <td class="num">${esc(it.qty)}</td>
        <td class="num">RM ${money(it.price)}</td>
        <td class="num">RM ${money(it.price * it.qty)}</td>
      </tr>`).join('');
    const showShip = (order.mode === 'delivery' || order.mode === 'sameday') && order.shipping_fee > 0;
    const shipRow = showShip ? `
      <tr>
        <td colspan="3">${order.mode === 'sameday' ? t('Same-day delivery', '当天配送') : t('Delivery', '送货') + (order.region ? ` (${esc(order.region)})` : '')}</td>
        <td class="num">RM ${money(order.shipping_fee)}</td>
      </tr>` : '';
    const awb = orderAWBs[order.order_number];
    const pickupAddr = settings.pickup?.address;

    const html = `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8">
<title>${t('Invoice', '发票')} ${esc(order.order_number || '')}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Lora:wght@500;600;700&family=DM+Sans:wght@400;500&display=swap');
  * { box-sizing: border-box; }
  body { font-family: 'DM Sans', -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #3a2a2a; margin: 0; padding: 32px; }
  .invoice { max-width: 640px; margin: 0 auto; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #E5C8C8; padding-bottom: 16px; margin-bottom: 20px; }
  .brand { font-family: 'Lora', Georgia, serif; font-size: 30px; font-weight: 600; color: #7A1028; letter-spacing: 0.3px; }
  .brand-sub { font-size: 12px; color: #A07070; margin-top: 4px; }
  .inv-meta { text-align: right; font-size: 13px; color: #6a5050; }
  .inv-meta .title { font-size: 18px; font-weight: 700; color: #3a2a2a; margin-bottom: 6px; }
  .section-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #A07070; margin: 18px 0 6px; }
  .details { font-size: 13px; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 13px; }
  th { text-align: left; border-bottom: 1px solid #E5C8C8; padding: 8px 6px; color: #A07070; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  td { padding: 8px 6px; border-bottom: 1px solid #f0e4e4; }
  td.num, th.num { text-align: right; }
  tr.total td { font-weight: 700; font-size: 15px; border-bottom: none; border-top: 2px solid #E5C8C8; padding-top: 12px; }
  .awb { background: #FBF1F1; border-radius: 8px; padding: 10px 14px; margin-top: 14px; font-size: 13px; }
  .awb b { color: #B86B6B; }
  .foot { margin-top: 28px; text-align: center; font-size: 12px; color: #A07070; }
  @media print { body { padding: 0; } .no-print { display: none; } }
  .no-print { text-align: center; margin-bottom: 20px; }
  .no-print button { background: #B86B6B; color: #fff; border: none; border-radius: 8px; padding: 10px 24px; font-size: 14px; cursor: pointer; }
</style></head><body>
<div class="no-print"><button onclick="window.print()">${t('Print / Save as PDF', '打印 / 保存为 PDF')}</button></div>
<div class="invoice">
  <div class="head">
    <div>
      <div class="brand">Bitetime &amp; Co.</div>
      <div class="brand-sub">${pickupAddr ? esc(pickupAddr) : ''}</div>
    </div>
    <div class="inv-meta">
      <div class="title">${t('INVOICE', '发票')}</div>
      <div>${t('No.', '号码')} ${esc(order.order_number || '—')}</div>
      <div>${esc(formatDate(order.created_at))}</div>
    </div>
  </div>

  <div class="section-label">${t('Bill to', '客户')}</div>
  <div class="details">
    ${order.customer_name ? `<div>${esc(order.customer_name)}</div>` : ''}
    ${order.customer_wa ? `<div>${esc(order.customer_wa)}</div>` : ''}
    <div>${t('Order type', '订单类型')}: ${esc(modeLabel)}</div>
    ${order.preferred_date ? `<div>${t('Preferred date', '预计日期')}: ${esc(order.preferred_date)}</div>` : ''}
    ${order.address ? `<div>${t('Delivery address', '送货地址')}: ${esc(order.address)}</div>` : ''}
  </div>

  <div class="section-label">${t('Order', '订单')}</div>
  <table>
    <thead><tr>
      <th>${t('Item', '项目')}</th>
      <th class="num">${t('Qty', '数量')}</th>
      <th class="num">${t('Price', '单价')}</th>
      <th class="num">${t('Amount', '金额')}</th>
    </tr></thead>
    <tbody>
      ${items}
      ${shipRow}
      <tr class="total"><td colspan="3">${t('Total', '总计')}</td><td class="num">RM ${money(order.total)}</td></tr>
    </tbody>
  </table>

  ${awb ? `<div class="awb">${t('Tracking / AWB Number', '追踪号码')}: <b>${esc(awb)}</b></div>` : ''}

  <div class="foot">${t('Thank you for your order! 🍪', '感谢您的订购！🍪')}</div>
</div>
<script>window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };</script>
</body></html>`;

    const w = window.open('', '_blank');
    if (!w) {
      alert(t('Please allow pop-ups to generate the invoice.', '请允许弹出窗口以生成发票。'));
      return;
    }
    w.document.write(html);
    w.document.close();
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

      {/* ── Promos & Events ── */}
      {(section === 'promos' || section === 'vouchers') && (() => {
        const now = new Date();
        const events = (settings.events ?? []).filter(ev =>
          ev.active !== false && (ev.title || '').trim() &&
          (!ev.until || now <= new Date(ev.until + 'T23:59:59'))
        );
        return (
          <div className="settings-section">
            <div className="settings-section-title">{t('Promos & Events', '活动专区')}</div>
            {events.length === 0 ? (
              <p className="settings-hint">{t('No events right now — stay tuned!', '暂无活动，敬请期待！')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '1.25rem' }}>
                {events.map((ev, i) => (
                  <div key={i} className="success-info-box" style={{ textAlign: 'left' }}>
                    <div className="success-info-title">🎉 {ev.title}</div>
                    {ev.desc && <div style={{ whiteSpace: 'pre-line' }}>{ev.desc}</div>}
                    {ev.until && (
                      <div style={{ fontSize: '12px', color: '#A07070', marginTop: '4px' }}>
                        {t(`Until ${ev.until}`, `截止 ${ev.until}`)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Referral program ── */}
      {(section === 'promos' || section === 'vouchers') && settings.referral?.enabled && (() => {
        const myCode = referralCodeOf(user.id);
        const shareLink = `${window.location.origin}${window.location.pathname}?ref=${myCode}`;
        const giftProductName = settings.products?.find(p => p.id === settings.referral?.giftProductId)?.name || '';
        const pending = myRewards.filter(r => r.status === 'pending');
        return (
          <div className="settings-section">
            <div className="settings-section-title">{t('Refer a friend', '推荐朋友')}</div>
            <p className="settings-hint">
              {t(
                `Share your code — your friend gets RM ${settings.referral?.discount || 0} off their first order, and you get a free ${giftProductName || 'treat'} with your next order!`,
                `分享您的推荐码 — 朋友首单立减 RM ${settings.referral?.discount || 0}，您下次下单获得免费${giftProductName || '小礼物'}！`
              )}
            </p>
            <div className="success-info-box" style={{ textAlign: 'left', marginTop: '10px' }}>
              <div className="success-info-title">{t('Your referral code', '您的推荐码')}</div>
              <div style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '2px', margin: '6px 0' }}>{myCode}</div>
              <button
                className="voucher-apply-btn"
                style={{ marginTop: '4px' }}
                onClick={() => {
                  navigator.clipboard?.writeText(shareLink)
                    .then(() => { setCopyMsg(t('✓ Link copied!', '✓ 链接已复制！')); setTimeout(() => setCopyMsg(''), 2500); })
                    .catch(() => { setCopyMsg(shareLink); });
                }}
              >
                📋 {t('Copy share link', '复制分享链接')}
              </button>
              {copyMsg && <div style={{ fontSize: '12px', color: '#1A7A3A', marginTop: '6px', wordBreak: 'break-all' }}>{copyMsg}</div>}
            </div>
            {myRewards.length > 0 && (
              <div style={{ marginTop: '12px' }}>
                <div className="settings-section-title" style={{ fontSize: '14px' }}>{t('My rewards', '我的奖励')}</div>
                {pending.length > 0 && (
                  <p className="settings-hint" style={{ color: '#1A7A3A' }}>
                    {t(`🎁 ${pending.length} free gift(s) waiting — added automatically to your next order!`, `🎁 ${pending.length} 份免费礼物待领 — 下次下单自动赠送！`)}
                  </p>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                  {myRewards.map((r, i) => (
                    <div key={i} className="summary-row" style={{ fontSize: '13px' }}>
                      <span>🎁 {r.giftProductName || t('Gift', '礼物')}</span>
                      <span style={{ color: r.status === 'pending' ? '#1A7A3A' : '#A07070' }}>
                        {r.status === 'pending' ? t('Ready to redeem', '待领取') : t(`Redeemed (${r.redeemedOrder || ''})`, `已领取（${r.redeemedOrder || ''}）`)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Vouchers ── */}
      {(section === 'promos' || section === 'vouchers') && (
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
                            <div className="summary-detail-cell"><span className="detail-label">{t('Order type', '订单类型')}</span><span className="detail-value">{order.mode === 'delivery' ? t('Delivery', '送货') : order.mode === 'sameday' ? t('Same-day delivery', '当天配送') : t('Self-pickup', '自取')}</span></div>
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

                        <button className="invoice-btn" onClick={() => generateInvoice(order)}>
                          🧾 {t('Generate invoice', '生成发票')}
                        </button>
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
