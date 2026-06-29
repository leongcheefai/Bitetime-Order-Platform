import { useState, useEffect } from 'react';
import { fetchAllOrders, loadOrderStatuses } from '../store';
import type { Lang, Order, OrderItem } from '../types';

interface SalesDashboardProps {
  lang: Lang;
}

const STATUS_LABELS: Record<string, { en: string; zh: string }> = {
  pending:   { en: 'Pending',          zh: '待处理' },
  confirmed: { en: 'Confirmed',         zh: '已确认' },
  preparing: { en: 'Ready to Deliver',  zh: '准备送货' },
  ready:     { en: 'Out for Delivery',  zh: '派送中' },
  completed: { en: 'Completed',         zh: '已完成' },
  cancelled: { en: 'Cancelled',         zh: '已取消' },
};

export default function SalesDashboard({ lang }: SalesDashboardProps) {
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;
  const [orders, setOrders] = useState<Order[]>([]);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchAllOrders(), loadOrderStatuses()]).then(([ords, stats]) => {
      setOrders(ords);
      setStatuses(stats);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="order-list-status">{t('Loading…', '加载中…')}</div>;

  const getStatus = (o: Order) => statuses[o.order_number ?? ''] || 'pending';
  const active = orders.filter((o: Order) => getStatus(o) !== 'cancelled');

  const totalRevenue = active.reduce((s: number, o: Order) => s + (o.total || 0), 0);

  const now = new Date();
  const thisMonthActive = active.filter((o: Order) => {
    const d = new Date(o.created_at ?? '');
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const monthRevenue = thisMonthActive.reduce((s: number, o: Order) => s + (o.total || 0), 0);

  const statusCounts: Record<string, number> = {};
  orders.forEach((o: Order) => {
    const s = getStatus(o);
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });

  const productQty: Record<string, number> = {};
  active.forEach((o: Order) => {
    (o.items || []).forEach((item: OrderItem) => {
      productQty[item.name ?? ''] = (productQty[item.name ?? ''] || 0) + item.qty;
    });
  });
  const topProducts = Object.entries(productQty).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxQty = topProducts[0]?.[1] || 1;

  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    const rev = active
      .filter((o: Order) => { const od = new Date(o.created_at ?? ''); return od.getFullYear() === d.getFullYear() && od.getMonth() === d.getMonth(); })
      .reduce((s: number, o: Order) => s + (o.total || 0), 0);
    return { label: d.toLocaleDateString('en-MY', { month: 'short', year: '2-digit' }), rev };
  });
  const maxRev = Math.max(...months.map(m => m.rev), 1);
  const BAR_H = 90;

  return (
    <div className="dashboard-panel">
      <div className="admin-title">{t('Sales Overview', '销售概览')}</div>

      <div className="dash-stat-grid">
        <div className="dash-stat-card dash-stat-accent">
          <div className="dash-stat-label">{t('Total Revenue', '总收入')}</div>
          <div className="dash-stat-value">RM {totalRevenue.toFixed(2)}</div>
          <div className="dash-stat-sub">{t('all time · excl. cancelled', '历史总计 · 不含已取消')}</div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-label">{t('Total Orders', '总订单')}</div>
          <div className="dash-stat-value">{active.length}</div>
          <div className="dash-stat-sub">{t('all time · excl. cancelled', '不含已取消')}</div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-label">{t('This Month', '本月收入')}</div>
          <div className="dash-stat-value">RM {monthRevenue.toFixed(2)}</div>
          <div className="dash-stat-sub">{thisMonthActive.length} {t('orders', '笔订单')}</div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-label">{t('Pending', '待处理')}</div>
          <div className="dash-stat-value">{statusCounts['pending'] || 0}</div>
          <div className="dash-stat-sub">{t('need attention', '需处理')}</div>
        </div>
      </div>

      <div className="dash-section">
        <div className="admin-section-label">{t('Revenue — last 6 months', '近 6 个月收入')}</div>
        <div className="dash-bar-chart">
          {months.map((m, i) => {
            const barH = m.rev > 0 ? Math.max(4, Math.round((m.rev / maxRev) * BAR_H)) : 2;
            return (
              <div key={i} className="dash-bar-col">
                <div className="dash-bar-amt">{m.rev > 0 ? `RM${Math.round(m.rev)}` : ''}</div>
                <div className="dash-bar-spacer" style={{ flex: 1 }} />
                <div className="dash-bar" style={{ height: `${barH}px` }} />
                <div className="dash-bar-label">{m.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {topProducts.length > 0 && (
        <div className="dash-section">
          <div className="admin-section-label">{t('Top Products (by qty)', '热门产品（按销量）')}</div>
          <div className="dash-product-list">
            {topProducts.map(([name, qty], i) => (
              <div key={name} className="dash-product-row">
                <span className="dash-product-rank">#{i + 1}</span>
                <span className="dash-product-name">{name}</span>
                <div className="dash-product-bar-wrap">
                  <div className="dash-product-bar" style={{ width: `${(qty / maxQty) * 100}%` }} />
                </div>
                <span className="dash-product-qty">{qty} {t('pcs', '件')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="dash-section">
        <div className="admin-section-label">{t('Orders by Status', '订单状态分布')}</div>
        <div className="dash-status-grid">
          {Object.keys(STATUS_LABELS).map(key => (
            <div key={key} className={'dash-status-pill order-status-badge status-' + key}>
              <span className="dash-status-count">{statusCounts[key] || 0}</span>
              <span className="dash-status-name">{t(STATUS_LABELS[key].en, STATUS_LABELS[key].zh)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
