import { useState, useEffect } from 'react';
import { fetchAllOrders, loadOrderStatuses, saveOrderStatus, loadOrderAWBs, saveOrderAWB, loadOrderNotes, saveOrderNote } from '../store';

const STATUS_OPTIONS = ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];

const STATUS_LABELS = {
  pending:   { en: 'Pending',          zh: '待处理' },
  confirmed: { en: 'Confirmed',        zh: '已确认' },
  preparing: { en: 'Ready to Deliver', zh: '准备送货' },
  ready:     { en: 'Out for Delivery', zh: '派送中'  },
  completed: { en: 'Completed',        zh: '已完成' },
  cancelled: { en: 'Cancelled',        zh: '已取消' },
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
  const [notes, setNotes] = useState({});
  const [noteInputs, setNoteInputs] = useState({});
  const [noteSaving, setNoteSaving] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [bulkStatus, setBulkStatus] = useState('confirmed');
  const [bulkSaving, setBulkSaving] = useState(false);

  useEffect(() => {
    Promise.all([fetchAllOrders(), loadOrderStatuses(), loadOrderAWBs(), loadOrderNotes()]).then(([ords, stats, awbData, notesData]) => {
      setOrders(ords);
      setStatuses(stats);
      setAwbs(awbData);
      setAwbInputs(awbData);
      setNotes(notesData);
      setNoteInputs(notesData);
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

  async function handleNoteSave(orderNumber) {
    setNoteSaving(orderNumber);
    try {
      const updated = await saveOrderNote(orderNumber, noteInputs[orderNumber] || '');
      setNotes(updated);
    } catch (err) {
      console.error('Failed to save note:', err);
    } finally {
      setNoteSaving(null);
    }
  }

  async function handleStatusChange(orderNumber, newStatus) {
    setStatuses(prev => ({ ...prev, [orderNumber]: newStatus }));
    setSaving(orderNumber);
    setSaveError(null);
    try {
      await saveOrderStatus(orderNumber, newStatus);
    } catch (err) {
      console.error('Failed to save status:', err);
      setSaveError('Save failed: ' + err.message);
      setStatuses(prev => { const r = { ...prev }; delete r[orderNumber]; return r; });
    } finally {
      setSaving(null);
    }
  }

  async function handleBulkStatusChange() {
    if (selected.size === 0) return;
    setBulkSaving(true);
    const nums = [...selected];
    setStatuses(prev => {
      const next = { ...prev };
      nums.forEach(n => { next[n] = bulkStatus; });
      return next;
    });
    try {
      await Promise.all(nums.map(n => saveOrderStatus(n, bulkStatus)));
      setSelected(new Set());
    } catch (err) {
      console.error('Bulk save failed:', err);
    } finally {
      setBulkSaving(false);
    }
  }

  function toggleSelect(orderNumber, e) {
    e.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      next.has(orderNumber) ? next.delete(orderNumber) : next.add(orderNumber);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(o => o.order_number)));
    }
  }

  function exportCSV() {
    const headers = ['Order Number', 'Customer Name', 'WhatsApp', 'Date', 'Mode', 'Address', 'Region', 'Shipping (RM)', 'Items', 'Total (RM)', 'Status', 'AWB', 'Note'];
    const rows = orders.map(o => {
      const items = Array.isArray(o.items) ? o.items.map(i => `${i.name} x${i.qty}`).join('; ') : '';
      return [
        o.order_number,
        o.customer_name || '',
        o.customer_wa || '',
        o.created_at ? new Date(o.created_at).toLocaleDateString('en-MY') : '',
        o.mode || '',
        (o.address || '').replace(/"/g, '""'),
        o.region || '',
        o.shipping_fee || 0,
        items,
        o.total || 0,
        statuses[o.order_number] || 'pending',
        awbs[o.order_number] || '',
        (notes[o.order_number] || '').replace(/"/g, '""'),
      ].map(v => `"${v}"`).join(',');
    });
    const csv = [headers.map(h => `"${h}"`).join(','), ...rows].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bitetime-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 0 }}>
          <div className="admin-title" style={{ marginBottom: 0 }}>
            {t('All Orders', '全部订单')}
            <span className="order-list-count">{orders.length}</span>
          </div>
          <button className="export-btn" onClick={exportCSV}>
            ↓ {t('Export CSV', '导出 CSV')}
          </button>
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

      {filtered.length > 0 && (
        <div className="bulk-action-bar">
          <label className="bulk-select-all">
            <input
              type="checkbox"
              className="bulk-select-check"
              checked={selected.size === filtered.length && filtered.length > 0}
              onChange={toggleSelectAll}
            />
            {selected.size > 0
              ? t(`${selected.size} selected`, `已选 ${selected.size} 单`)
              : t('Select all', '全选')}
          </label>
          {selected.size > 0 && (
            <>
              <select
                className="bulk-status-select"
                value={bulkStatus}
                onChange={e => setBulkStatus(e.target.value)}
              >
                {STATUS_OPTIONS.map(s => (
                  <option key={s} value={s}>{t(STATUS_LABELS[s].en, STATUS_LABELS[s].zh)}</option>
                ))}
              </select>
              <button
                className="bulk-apply-btn"
                disabled={bulkSaving}
                onClick={handleBulkStatusChange}
              >
                {bulkSaving ? t('Saving…', '保存中…') : t('Apply', '应用')}
              </button>
              <button className="bulk-clear-btn" onClick={() => setSelected(new Set())}>
                {t('Clear', '清除')}
              </button>
            </>
          )}
        </div>
      )}

      {filtered.length === 0 && (
        <div className="order-list-status">{t('No orders found.', '暂无订单。')}</div>
      )}

      <div className="order-list">
        {filtered.map(order => {
          const status = statuses[order.order_number] || 'pending';
          const isOpen = expanded !== false && expanded === order.order_number;
          const items = Array.isArray(order.items) ? order.items : [];
          const isSelected = selected.has(order.order_number);
          return (
            <div key={order.order_number} className={'user-order-card' + (isOpen ? ' open' : '') + (isSelected ? ' selected-card' : '')}>
              <div className="user-order-header-wrap">
                <label className="order-select-label" onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="bulk-select-check"
                    checked={isSelected}
                    onChange={e => toggleSelect(order.order_number, e)}
                  />
                </label>
                <button
                  className="user-order-header"
                  style={{ flex: 1 }}
                  onClick={() => setExpanded(isOpen ? false : order.order_number)}
                >
                  <div className="user-order-left">
                    <span className="user-order-num">{order.order_number}</span>
                    <span className="user-order-customer">{order.customer_name || '—'}</span>
                    <span className="user-order-date">{formatDate(order.created_at)}</span>
                  </div>
                  <div className="user-order-right">
                    <span className={'order-status-badge status-' + status}>
                      {t(STATUS_LABELS[status].en, STATUS_LABELS[status].zh)}
                    </span>
                    <span className="user-order-total">RM {Number(order.total || 0).toFixed(2)}</span>
                    <span className="order-accordion-chevron">{isOpen ? '▲' : '▼'}</span>
                  </div>
                </button>
              </div>

              {isOpen && (
                <div className="user-order-body">
                  <div className="user-order-detail-grid">
                    <div>
                      <div className="user-order-detail-label">{t('WhatsApp', 'WhatsApp')}</div>
                      <div className="user-order-detail-val">{order.customer_wa || '—'}</div>
                    </div>
                    <div>
                      <div className="user-order-detail-label">{t('Mode', '取货方式')}</div>
                      <div className="user-order-detail-val" style={{ textTransform: 'capitalize' }}>{order.mode || '—'}</div>
                    </div>
                    <div>
                      <div className="user-order-detail-label">{t('Preferred Date', '期望日期')}</div>
                      <div className="user-order-detail-val">{order.preferred_date || '—'}</div>
                    </div>
                    {order.address && (
                      <div style={{ gridColumn: '1 / -1' }}>
                        <div className="user-order-detail-label">{t('Address', '地址')}</div>
                        <div className="user-order-detail-val">{order.address}</div>
                      </div>
                    )}
                  </div>

                  <div className="user-order-items">
                    <div className="user-order-detail-label" style={{ marginBottom: '6px' }}>{t('Items', '产品')}</div>
                    {items.map((item, i) => (
                      <div key={i} className="user-order-item-row">
                        <span>{item.name}</span>
                        <span>×{item.qty}</span>
                        <span>RM {(item.price * item.qty).toFixed(2)}</span>
                      </div>
                    ))}
                    {order.shipping_fee > 0 && (
                      <div className="user-order-item-row shipping">
                        <span>{t('Delivery', '运费')} ({order.region})</span>
                        <span></span>
                        <span>RM {Number(order.shipping_fee).toFixed(2)}</span>
                      </div>
                    )}
                    <div className="user-order-item-row total">
                      <span>{t('Total', '总计')}</span>
                      <span></span>
                      <span>RM {Number(order.total || 0).toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="user-order-status-row">
                    <span className="user-order-detail-label">{t('Update Status', '更新状态')}</span>
                    {saveError && <span style={{ fontSize: '12px', color: '#c0392b' }}>{saveError}</span>}
                    <div className="user-status-btns">
                      {STATUS_OPTIONS.map(s => (
                        <button
                          key={s}
                          className={'user-status-opt' + (status === s ? ' active status-' + s : '')}
                          disabled={saving !== null && saving === order.order_number}
                          onClick={() => handleStatusChange(order.order_number, s)}
                        >
                          {t(STATUS_LABELS[s].en, STATUS_LABELS[s].zh)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {(status === 'ready' || awbs[order.order_number]) && (
                    <div className="user-order-awb-row">
                      <div className="user-order-detail-label">{t('Tracking / AWB Number', '追踪号码')}</div>
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

                  <div className="user-order-note-row">
                    <div className="user-order-detail-label">{t('Internal note', '内部备注')}</div>
                    <textarea
                      className="order-note-textarea"
                      placeholder={t('Add a note (e.g. allergy info, packing instructions…)', '添加备注（如过敏信息、包装说明等…）')}
                      value={noteInputs[order.order_number] || ''}
                      onChange={e => setNoteInputs(prev => ({ ...prev, [order.order_number]: e.target.value }))}
                    />
                    <button
                      className="note-save-btn"
                      disabled={noteSaving === order.order_number}
                      onClick={() => handleNoteSave(order.order_number)}
                    >
                      {noteSaving === order.order_number ? t('Saving…', '保存中…') : t('Save note', '保存备注')}
                    </button>
                    {notes[order.order_number] && noteInputs[order.order_number] === notes[order.order_number] && (
                      <div style={{ fontSize: '12px', color: '#1A7A3A' }}>✓ {t('Note saved', '备注已保存')}</div>
                    )}
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
