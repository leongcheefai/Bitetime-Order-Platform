import { useState, useEffect } from 'react';
import { fetchAllOrders, loadOrderStatuses, saveOrderStatus } from '../store';

const STATUS_OPTIONS = ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];

const STATUS_LABELS = {
  pending:   { en: 'Pending',   zh: '待处理' },
  confirmed: { en: 'Confirmed', zh: '已确认' },
  preparing: { en: 'Preparing', zh: '制作中' },
  ready:     { en: 'Ready',     zh: '已备好' },
  completed: { en: 'Completed', zh: '已完成' },
  cancelled: { en: 'Cancelled', zh: '已取消' },
};

export default function OrderList({ lang }) {
  const t = (en, zh) => lang === 'zh' ? zh : en;
  const [orders, setOrders] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [saving, setSaving] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [filterStatus, setFilterStatus] = useState('all');

  useEffect(() => {
    Promise.all([fetchAllOrders(), loadOrderStatuses()]).then(([ords, stats]) => {
      setOrders(ords);
      setStatuses(stats);
      setLoading(false);
    });
  }, []);

  async function handleStatusChange(orderNumber, newStatus) {
    setSaving(orderNumber);
    setSaveError(null);
    try {
      const updated = await saveOrderStatus(orderNumber, newStatus);
      setStatuses(updated);
    } catch (err) {
      console.error('Failed to save status:', err);
      setSaveError('Failed to save. Try again.');
    } finally {
      setSaving(null);
    }
  }

  const filtered = filterStatus === 'all'
    ? orders
    : orders.filter(o => (statuses[o.order_number] || 'pending') === filterStatus);

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
          const isOpen = expanded === order.order_number;
          const items = Array.isArray(order.items) ? order.items : [];
          return (
            <div key={order.order_number} className={'owner-order-card' + (isOpen ? ' open' : '')}>
              <button
                className="owner-order-header"
                onClick={() => setExpanded(isOpen ? null : order.order_number)}
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
                    {saveError && saving === null && <span style={{ fontSize: '12px', color: '#c0392b' }}>{saveError}</span>}
                    <div className="owner-status-btns">
                      {STATUS_OPTIONS.map(s => (
                        <button
                          key={s}
                          className={'owner-status-opt' + (status === s ? ' active status-' + s : '')}
                          disabled={saving === order.order_number}
                          onClick={() => handleStatusChange(order.order_number, s)}
                        >
                          {t(STATUS_LABELS[s].en, STATUS_LABELS[s].zh)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
