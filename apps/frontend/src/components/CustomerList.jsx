import { useState, useEffect } from 'react';
import { fetchAllProfiles, fetchAllOrders, loadOrderStatuses } from '../store';

const STATUS_LABELS = {
  pending:   { en: 'Pending',          zh: '待处理' },
  confirmed: { en: 'Confirmed',        zh: '已确认' },
  preparing: { en: 'Ready to Deliver', zh: '准备送货' },
  ready:     { en: 'Out for Delivery', zh: '派送中' },
  completed: { en: 'Completed',        zh: '已完成' },
  cancelled: { en: 'Cancelled',        zh: '已取消' },
};

export default function CustomerList({ lang }) {
  const t = (en, zh) => lang === 'zh' ? zh : en;
  const [customers, setCustomers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [expandedCustomer, setExpandedCustomer] = useState(null);

  useEffect(() => {
    Promise.all([fetchAllProfiles(), fetchAllOrders(), loadOrderStatuses()])
      .then(([profiles, ords, stats]) => {
        setCustomers(profiles);
        setOrders(ords);
        setStatuses(stats);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = customers.filter(u =>
    !q || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)
  );

  function customerOrders(customerId) {
    return orders.filter(o => o.user_id === customerId);
  }

  function customerStats(customerId) {
    const ords = customerOrders(customerId).filter(o => (statuses[o.order_number] || 'pending') !== 'cancelled');
    return {
      count: ords.length,
      total: ords.reduce((s, o) => s + (o.total || 0), 0),
    };
  }

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-MY', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  return (
    <div className="customer-list-panel">
      <div className="admin-title">{t('Registered Customers', '注册顾客')}</div>

      {loading && <p className="customer-list-status">{t('Loading…', '加载中…')}</p>}
      {error && <p className="customer-list-status customer-list-error">{t('Error: ', '错误：')}{error}</p>}

      {!loading && !error && (
        <>
          <div className="customer-search-row">
            <input
              type="text"
              className="customer-search-input"
              placeholder={t('Search by name or email…', '按姓名或邮箱搜索…')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button className="order-search-clear" onClick={() => setSearch('')}>✕</button>
            )}
          </div>

          {filtered.length === 0 ? (
            <p className="customer-list-status">{t('No customers found.', '未找到顾客。')}</p>
          ) : (
            <>
              <div className="customer-count">{filtered.length} {t('customer(s)', '位顾客')}</div>
              <div className="customer-table-wrap">
                <table className="customer-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t('Name', '姓名')}</th>
                      <th>{t('Email', '邮箱')}</th>
                      <th>{t('Verified', '已验证')}</th>
                      <th>{t('Joined', '注册时间')}</th>
                      <th>{t('Orders', '订单')}</th>
                      <th>{t('Spent', '消费')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((u, i) => {
                      const stats = customerStats(u.id);
                      const isExpanded = expandedCustomer === u.id;
                      const uOrders = customerOrders(u.id);
                      return (
                        <>
                          <tr
                            key={u.id}
                            className={'customer-row-clickable' + (isExpanded ? ' customer-row-expanded' : '')}
                            onClick={() => setExpandedCustomer(isExpanded ? null : u.id)}
                          >
                            <td>{i + 1}</td>
                            <td>{u.name || '—'}</td>
                            <td>{u.email}</td>
                            <td>
                              {u.email_confirmed
                                ? <span className="order-status-badge status-pending">{t('Verified', '已验证')}</span>
                                : <span className="order-status-badge status-cancelled">{t('Unverified', '未验证')}</span>}
                            </td>
                            <td>{formatDate(u.created_at)}</td>
                            <td><strong>{stats.count}</strong></td>
                            <td><strong>RM {stats.total.toFixed(2)}</strong></td>
                          </tr>
                          {isExpanded && (
                            <tr key={u.id + '-orders'} className="customer-orders-row">
                              <td colSpan={7}>
                                <div className="customer-orders-panel">
                                  <div className="admin-section-label" style={{ marginBottom: '8px' }}>
                                    {t('Order history', '历史订单')} — {u.name || u.email}
                                  </div>
                                  {uOrders.length === 0 ? (
                                    <p style={{ fontSize: '13px', color: '#A07070', fontStyle: 'italic' }}>{t('No orders yet.', '暂无订单。')}</p>
                                  ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                      {uOrders.map(o => {
                                        const s = statuses[o.order_number] || 'pending';
                                        return (
                                          <div key={o.order_number} className="customer-order-row">
                                            <span className="user-order-num" style={{ fontSize: '12px' }}>{o.order_number}</span>
                                            <span style={{ fontSize: '12px', color: '#7A4F55' }}>{formatDateTime(o.created_at)}</span>
                                            <span style={{ fontSize: '12px', color: '#2B0A10', textTransform: 'capitalize' }}>{o.mode}</span>
                                            <span className={'order-status-badge status-' + s} style={{ fontSize: '10px' }}>
                                              {t(STATUS_LABELS[s].en, STATUS_LABELS[s].zh)}
                                            </span>
                                            <span style={{ fontSize: '13px', fontWeight: 600, color: '#2B0A10', marginLeft: 'auto' }}>
                                              RM {Number(o.total || 0).toFixed(2)}
                                            </span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
