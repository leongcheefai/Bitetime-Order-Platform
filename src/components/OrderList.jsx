import { useState, useEffect } from 'react';
import { fetchAllOrders, loadOrderStatuses, saveOrderStatus, loadOrderAWBs, saveOrderAWB } from '../store';

const STATUS_OPTIONS = ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];

const STATUS_LABELS = {
  pending:   { en: 'Pending',   zh: '待处理' },
  confirmed: { en: 'Confirmed', zh: '已确认' },
  preparing: { en: 'Ready to Deliver', zh: '准备送货' },
  ready:     { en: 'Out for Delivery', zh: '派送中'  },
  completed: { en: 'Completed', zh: '已完成' },
  cancelled: { en: 'Cancelled', zh: '已取消' },
};

export default function OrderList({ lang }) {
  const t = (en, zh) => lang === 'zh' ? zh : en;
  const [orders, setOrders] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [filterStatus, setFilterStatus] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [awbs, setAwbs] = useState({});
  const [awbInputs, setAwbInputs] = useState({});
  const [awbSaving, setAwbSaving] = useState(null);

  useEffect(() => {
    Promise.all([fetchAllOrders(), loadOrderStatuses(), loadOrderAWBs()]).then(([ords, stats, awbData]) => {
      setOrders(ords);
      setStatuses(stats);
      setAwbs(awbData);
      setAwbInputs(awbData);
      setLoading(false);
    });
  }, []);

  async function handleAwbSave(orderNumber) {
    setAwbSaving(orderNumber);
    try {
      const updated = await saveOrderAWB(orderNumber, awbInputs[orderNumber] || '');
      setAwbs(updated);
    } catch (err) {
      console.error('Failed to save AWB:', err);
    } finally {
      setAwbSaving(null);
    }
  }

  async function handleStatusChange(orderNumber, newStatus) {
    // Optimistic update — change UI instantly
    setStatuses(prev => ({ ...prev, [orderNumber]: newStatus }));
    setSaving(orderNumber);
    setSaveError(null);
    try {
      await saveOrderStatus(orderNumber, newStatus);
    } catch (err) {
      console.error('Failed to save status:', err);
      setSaveError('Save failed: ' + err.message);
      // Revert on failure
      setStatuses(prev => { const r = { ...prev }; delete r[orderNumber]; return r; });
    } finally {
      setSaving(null);
    }
  }

  const q = searchQuery.trim().toLowerCase();
  const filtered = orders.filter(o => {
    const statusMatch = filterStatus === 'all' || (statuses[o.order_number] || 'pending') === filterStatus;
    const searchMatch = !q ||
      (o.order_number || '').toLowerCase().includes(q) ||
      (o.customer_name || '').toLowerCase().includes(q) ||
      (o.customer_wa || '').toLowerCase().includes(q);
    return statusMatch && searchMatch;
  });

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  if (loading) return <div className="order-list-status">{t('Loading orders…', '加载订单中…')}</div>;

  return (
    <div className="order-list-panel">
      <div className="order-list-header">
        <div className="admin-title" style={{ marginBottom: 0 }}>
          {t('All Orders', '全部订单')}
          <span className="order-list-count">{orders.length}</span>
        </div>
        <div className="order-list-search-row">
          <input
            type="text"
            className="order-search-input"
            placeholder={t('Search by order no., name, or WhatsApp…', '搜索订单号、姓名或WhatsApp…')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="order-search-clear" onClick={() => setSearchQuery('')}>✕</button>
          )}
        </div>
        <div className="order-list-filters">
          {['all', ...STATUS_OPTIONS].map(s => (
            <button
              key={s}
              className={'order-filter-btn' + (filterStatus === s ? ' active' : '')}
              onClick={() => setFilterStatus(s)}
            >
              {s === 'all' ? t('All', '全部') : t(STATUS_LABELS[s].en, STATUS_LABELS[s].zh)}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 && (
        <div className="order-list-status">{t('No orders found.', '暂无订单。')}</div>
      )}

      <div className="order-list">
        {filtered.map(order => {
          const status = statuses[order.order_number] || 'pending';
          const isOpen = expanded !== false && expanded === order.order_number;
          const items = Array.isArray(order.items) ? order.items : [];
          return (
            <div key={order.order_number} className={'owner-order-card' + (isOpen ? ' open' : '')}>
              <button
                className="owner-order-header"
                onClick={() => setExpanded(isOpen ? false : order.order_number)}
              >
                <div className="owner-order-left">
                  <span className="owner-order-num">{order.order_number}</span>
                  <span className="owner-order-customer">{order.customer_name || '—'}</span>
                  <span className="owner-order-date">{formatDate(order.created_at)}</span>
                </div>
                <div className="owner-order-right">
                  <span className={'order-status-badge status-' + status}>
                    {t(STATUS_LABELS[status].en, STATUS_LABELS[status].zh)}
                  </span>
                  <span className="owner-order-total">RM {Number(order.total || 0).toFixed(2)}</span>
                  <span className="order-accordion-chevron">{isOpen ? '▲' : '▼'}</span>
                </div>
              </button>

              {isOpen && (
                <div className="owner-order-body">
                  <div className="owner-order-detail-grid">
                    <div>
                      <div className="owner-order-detail-label">{t('WhatsApp', 'WhatsApp')}</div>
                      <div className="owner-order-detail-val">{order.customer_wa || '—'}</div>
                    </div>
                    <div>
                      <div className="owner-order-detail-label">{t('Mode', '取货方式')}</div>
                      <div className="owner-order-detail-val" style={{ textTransform: 'capitalize' }}>{order.mode || '—'}</div>
                    </div>
                    <div>
                      <div className="owner-order-detail-label">{t('Preferred Date', '期望日期')}</div>
                      <div className="owner-order-detail-val">{order.preferred_date || '—'}</div>
                    </div>
                    {order.address && (
                      <div style={{ gridColumn: '1 / -1' }}>
                        <div className="owner-order-detail-label">{t('Address', '地址')}</div>
                        <div className="owner-order-detail-val">{order.address}</div>
                      </div>
                    )}
                  </div>

                  <div className="owner-order-items">
                    <div className="owner-order-detail-label" style={{ marginBottom: '6px' }}>{t('Items', '产品')}</div>
                    {items.map((item, i) => (
                      <div key={i} className="owner-order-item-row">
                        <span>{item.name}</span>
                        <span>×{item.qty}</span>
                        <span>RM {(item.price * item.qty).toFixed(2)}</span>
                      </div>
                    ))}
                    {order.shipping_fee > 0 && (
                      <div className="owner-order-item-row shipping">
                        <span>{t('Delivery', '运费')} ({order.region})</span>
                        <span></span>
                        <span>RM {Number(order.shipping_fee).toFixed(2)}</span>
                      </div>
                    )}
                    <div className="owner-order-item-row total">
                      <span>{t('Total', '总计')}</span>
                      <span></span>
                      <span>RM {Number(order.total || 0).toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="owner-order-status-row">
                    <span className="owner-order-detail-label">{t('Update Status', '更新状态')}</span>
                    {saveError && <span style={{ fontSize: '12px', color: '#c0392b' }}>{saveError}</span>}
                    <div className="owner-status-btns">
                      {STATUS_OPTIONS.map(s => (
                        <button
                          key={s}
                          className={'owner-status-opt' + (status === s ? ' active status-' + s : '')}
                          disabled={saving !== null && saving === order.order_number}
                          onClick={() => handleStatusChange(order.order_number, s)}
                        >
                          {t(STATUS_LABELS[s].en, STATUS_LABELS[s].zh)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {status === 'ready' && (
                    <div className="owner-order-awb-row">
                      <div className="owner-order-detail-label">{t('Tracking / AWB Number', '追踪号码')}</div>
                      <div className="awb-input-row">
                        <input
                          type="text"
                          className="awb-input"
                          placeholder={t('e.g. JT1234567890MY', '例如：JT1234567890MY')}
                          value={awbInputs[order.order_number] || ''}
                          onChange={e => setAwbInputs(prev => ({ ...prev, [order.order_number]: e.target.value }))}
                        />
                        <button
                          className="awb-save-btn"
                          disabled={awbSaving === order.order_number}
                          onClick={() => handleAwbSave(order.order_number)}
                        >
                          {awbSaving === order.order_number ? t('Saving…', '保存中…') : t('Save', '保存')}
                        </button>
                      </div>
                      {awbs[order.order_number] && (
                        <div style={{ fontSize: '12px', color: '#1A7A3A', marginTop: '4px' }}>
                          ✓ {t('Saved:', '已保存：')} {awbs[order.order_number]}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
