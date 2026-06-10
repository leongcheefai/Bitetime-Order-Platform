import { useState, useEffect, useRef } from 'react';
import emailjs from '@emailjs/browser';
import { DayPicker } from 'react-day-picker';
import { format } from 'date-fns';
import 'react-day-picker/dist/style.css';
import { lookupPostcode } from '../postcodes';
import { fetchAllOrders, loadOrderStatuses, saveOrderStatus, loadOrderAWBs, saveOrderAWB, loadOrderNotes, saveOrderNote, fetchProfileByUserId, saveOrder, getNextOrderNumber, fetchProfileByEmail, fetchAllProfiles } from '../store';

const STATUS_OPTIONS = ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];
const MY_STATES = ['Johor','Kedah','Kelantan','Melaka','Negeri Sembilan','Pahang','Perak','Perlis','Pulau Pinang','Sabah','Sarawak','Selangor','Terengganu','W.P. Kuala Lumpur','W.P. Labuan','W.P. Putrajaya'];
const EM_STATES = ['Sabah', 'Sarawak', 'W.P. Labuan'];

const BLANK_FORM = { custName: '', custWa: '', custDate: '', mode: 'delivery', addrLine1: '', addrLine2: '', city: '', postcode: '', state: '', qty: {}, initStatus: 'pending' };

const STATUS_LABELS = {
  pending:   { en: 'Pending',          zh: '待处理' },
  confirmed: { en: 'Confirmed',        zh: '已确认' },
  preparing: { en: 'Ready to Deliver', zh: '准备送货' },
  ready:     { en: 'Out for Delivery', zh: '派送中'  },
  completed: { en: 'Completed',        zh: '已完成' },
  cancelled: { en: 'Cancelled',        zh: '已取消' },
};

export default function OrderList({ lang, settings = {} }) {
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
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState(BLANK_FORM);
  const [addDateObj, setAddDateObj] = useState(null);
  const [showAddCal, setShowAddCal] = useState(false);
  const addCalRef = useRef(null);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState('');
  const [linkedEmail, setLinkedEmail] = useState('');
  const [linkedProfile, setLinkedProfile] = useState(null);
  const [linkLooking, setLinkLooking] = useState(false);
  const [linkMsg, setLinkMsg] = useState('');
  const [allProfiles, setAllProfiles] = useState([]);
  const [showEmailDrop, setShowEmailDrop] = useState(false);
  const emailDropRef = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (emailDropRef.current && !emailDropRef.current.contains(e.target)) setShowEmailDrop(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    const handler = (e) => { if (addCalRef.current && !addCalRef.current.contains(e.target)) setShowAddCal(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

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

  const products = settings.products ?? [];

  function addFormTotal() {
    let total = 0;
    products.forEach(p => { total += p.price * (addForm.qty[p.id] || 0); });
    if (addForm.mode === 'delivery' && addForm.state) {
      const region = EM_STATES.includes(addForm.state) ? 'EM' : 'WM';
      total += settings.shipping?.[region] || 0;
    }
    return parseFloat(total.toFixed(2));
  }

  async function handleLookupEmail() {
    if (!linkedEmail.trim()) return;
    setLinkLooking(true);
    setLinkMsg('');
    setLinkedProfile(null);
    const profile = await fetchProfileByEmail(linkedEmail);
    if (profile) {
      setLinkedProfile(profile);
      setLinkMsg('');
    } else {
      setLinkMsg(t('No account found for this email.', '找不到此邮箱的账户。'));
    }
    setLinkLooking(false);
  }

  async function handleAddOrder(e) {
    e.preventDefault();
    const hasItems = products.some(p => (addForm.qty[p.id] || 0) > 0);
    if (!addForm.custName.trim() || !addForm.custWa.trim()) { setAddError(t('Name and WhatsApp are required.', '姓名和WhatsApp为必填项。')); return; }
    if (!hasItems) { setAddError(t('Add at least one item.', '请至少添加一件产品。')); return; }
    if (addForm.mode === 'delivery' && (!addForm.addrLine1.trim() || !addForm.city.trim() || !addForm.postcode.trim() || !addForm.state)) {
      setAddError(t('Fill in all delivery address fields.', '请填写所有送货地址字段。')); return;
    }
    setAddSaving(true);
    setAddError('');
    try {
      const orderNumber = await getNextOrderNumber();
      const items = products
        .filter(p => (addForm.qty[p.id] || 0) > 0)
        .map(p => ({ id: p.id, name: p.name, qty: addForm.qty[p.id], price: p.price }));
      const region = addForm.mode === 'delivery' ? (EM_STATES.includes(addForm.state) ? 'EM' : 'WM') : null;
      const shippingFee = region ? (settings.shipping?.[region] || 0) : 0;
      const address = addForm.mode === 'delivery'
        ? [addForm.addrLine1, addForm.addrLine2, addForm.city, addForm.postcode, addForm.state].filter(Boolean).join(', ')
        : null;
      const order = {
        order_number: orderNumber,
        user_id: linkedProfile?.id ?? null,
        customer_name: addForm.custName.trim(),
        customer_wa: addForm.custWa.trim(),
        preferred_date: addForm.custDate || null,
        mode: addForm.mode,
        address,
        region,
        shipping_fee: shippingFee,
        items,
        total: addFormTotal(),
      };
      await saveOrder(order);
      if (addForm.initStatus !== 'pending') await saveOrderStatus(orderNumber, addForm.initStatus);
      setOrders(prev => [{ ...order, created_at: new Date().toISOString() }, ...prev]);
      setStatuses(prev => ({ ...prev, [orderNumber]: addForm.initStatus }));
      setShowAddModal(false);
      setAddForm(BLANK_FORM);
    } catch (err) {
      setAddError(t('Failed to save order: ', '保存订单失败：') + err.message);
    } finally {
      setAddSaving(false);
    }
  }

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
      if (
        newStatus === 'ready' &&
        settings.ejsServiceId &&
        settings.ejsShippingTemplateId &&
        settings.ejsPublicKey
      ) {
        const order = orders.find(o => o.order_number === orderNumber);
        if (order?.user_id) {
          const profile = await fetchProfileByUserId(order.user_id);
          if (profile?.email) {
            emailjs.send(
              settings.ejsServiceId,
              settings.ejsShippingTemplateId,
              {
                to_name: order.customer_name || profile.name || '',
                to_email: profile.email,
                order_number: orderNumber,
                tracking_number: awbs[orderNumber] || '',
              },
              settings.ejsPublicKey,
            ).catch(() => {});
          }
        }
      }
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
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="add-order-btn" onClick={() => { setAddForm(BLANK_FORM); setAddDateObj(null); setAddError(''); setLinkedEmail(''); setLinkedProfile(null); setLinkMsg(''); setShowEmailDrop(false); setShowAddModal(true); fetchAllProfiles().then(setAllProfiles).catch(() => {}); }}>
              + {t('Add Order', '新增订单')}
            </button>
            <button className="export-btn" onClick={exportCSV}>
              ↓ {t('Export CSV', '导出 CSV')}
            </button>
          </div>
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

      {showAddModal && (
        <div className="add-order-overlay" onClick={() => setShowAddModal(false)}>
          <div className="add-order-modal" onClick={e => e.stopPropagation()}>
            <div className="add-order-modal-header">
              <span>{t('Add Order Manually', '手动新增订单')}</span>
              <button className="add-order-close" onClick={() => setShowAddModal(false)}>✕</button>
            </div>
            <form className="add-order-form" onSubmit={handleAddOrder}>
              <div className="add-order-section-label">{t('Link to Customer Account', '关联客户账户')} <span style={{ fontWeight: 400, textTransform: 'none', fontSize: 11, color: '#A07070' }}>{t('(optional)', '（可选）')}</span></div>
              <div className="add-order-link-row" ref={emailDropRef} style={{ position: 'relative' }}>
                <input
                  className="add-order-link-input"
                  type="email"
                  placeholder={t('Customer email address', '客户邮箱地址')}
                  value={linkedEmail}
                  onChange={e => { setLinkedEmail(e.target.value); setLinkedProfile(null); setLinkMsg(''); setShowEmailDrop(true); }}
                  onFocus={() => setShowEmailDrop(true)}
                  onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleLookupEmail())}
                />
                <button type="button" className="add-order-link-btn" disabled={linkLooking || !linkedEmail.trim()} onClick={handleLookupEmail}>
                  {linkLooking ? '…' : t('Look up', '查找')}
                </button>
                {showEmailDrop && linkedEmail.trim() && (() => {
                  const q = linkedEmail.toLowerCase();
                  const matches = allProfiles.filter(p => p.email?.toLowerCase().includes(q) || p.name?.toLowerCase().includes(q)).slice(0, 6);
                  if (!matches.length) return null;
                  return (
                    <div className="email-drop">
                      {matches.map(p => (
                        <button key={p.id} type="button" className="email-drop-item" onMouseDown={e => {
                          e.preventDefault();
                          setLinkedEmail(p.email);
                          setLinkedProfile(p);
                          setLinkMsg('');
                          setShowEmailDrop(false);
                        }}>
                          <span className="email-drop-name">{p.name || '—'}</span>
                          <span className="email-drop-email">{p.email}</span>
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>
              {linkedProfile && (
                <div className="add-order-link-found">
                  ✓ {linkedProfile.name || linkedProfile.email} — {t('order will appear in their history', '订单将显示在其历史记录中')}
                  <button type="button" className="add-order-link-clear" onClick={() => { setLinkedProfile(null); setLinkedEmail(''); }}>✕</button>
                </div>
              )}
              {linkMsg && <div style={{ fontSize: 12, color: '#C0392B' }}>{linkMsg}</div>}

              <div className="add-order-section-label">{t('Customer Info', '客户资料')}</div>
              <div className="add-order-row">
                <div className="add-order-field">
                  <label>{t('Name', '姓名')} *</label>
                  <input value={addForm.custName} onChange={e => setAddForm(f => ({ ...f, custName: e.target.value }))} placeholder={t('Customer name', '客户姓名')} />
                </div>
                <div className="add-order-field">
                  <label>{t('WhatsApp', 'WhatsApp')} *</label>
                  <input value={addForm.custWa} onChange={e => setAddForm(f => ({ ...f, custWa: e.target.value }))} placeholder="e.g. 0123456789" />
                </div>
              </div>
              <div className="add-order-row">
                <div className="add-order-field" ref={addCalRef} style={{ position: 'relative' }}>
                  <label>{t('Preferred Date', '期望日期')}</label>
                  <button type="button" className="date-picker-btn" onClick={() => setShowAddCal(v => !v)}>
                    <span>{addDateObj ? format(addDateObj, 'dd MMM yyyy') : t('Select a date', '选择日期')}</span>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="13" rx="2" stroke="currentColor" strokeWidth="1.4"/><path d="M1 6h14" stroke="currentColor" strokeWidth="1.4"/><path d="M5 1v2M11 1v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
                  </button>
                  {showAddCal && (
                    <div className="date-picker-popup">
                      <DayPicker
                        mode="single"
                        selected={addDateObj}
                        onSelect={d => { setAddDateObj(d); setAddForm(f => ({ ...f, custDate: d ? format(d, 'yyyy-MM-dd') : '' })); setShowAddCal(false); }}
                        disabled={d => { const min = new Date(); min.setHours(0,0,0,0); min.setDate(min.getDate() + (settings.leadDays ?? 3)); const allowed = settings.availableDays ?? [1,2,3,4,5,6]; const blocked = settings.blockedDates ?? []; return d < min || !allowed.includes(d.getDay()) || blocked.includes(format(d, 'yyyy-MM-dd')); }}
                      />
                    </div>
                  )}
                </div>
                <div className="add-order-field">
                  <label>{t('Mode', '取货方式')}</label>
                  <select value={addForm.mode} onChange={e => setAddForm(f => ({ ...f, mode: e.target.value }))}>
                    <option value="delivery">{t('Delivery', '送货')}</option>
                    <option value="pickup">{t('Self-pickup', '自取')}</option>
                  </select>
                </div>
              </div>

              {addForm.mode === 'delivery' && (
                <>
                  <div className="add-order-section-label">{t('Delivery Address', '送货地址')}</div>
                  <div className="add-order-field">
                    <label>{t('Address Line 1', '地址第1行')} *</label>
                    <input value={addForm.addrLine1} onChange={e => setAddForm(f => ({ ...f, addrLine1: e.target.value }))} placeholder={t('Street, unit no.', '街道、单位号')} />
                  </div>
                  <div className="add-order-field">
                    <label>{t('Address Line 2', '地址第2行')}</label>
                    <input value={addForm.addrLine2} onChange={e => setAddForm(f => ({ ...f, addrLine2: e.target.value }))} placeholder={t('Area, neighbourhood (optional)', '区域（可选）')} />
                  </div>
                  <div className="add-order-row">
                    <div className="add-order-field">
                      <label>{t('Postcode', '邮编')} *</label>
                      <input value={addForm.postcode} onChange={e => {
                        const val = e.target.value.replace(/\D/g, '');
                        setAddForm(f => {
                          const next = { ...f, postcode: val };
                          if (val.length === 5) {
                            const result = lookupPostcode(val);
                            if (result) { next.city = result.city; next.state = result.state; }
                          }
                          return next;
                        });
                      }} placeholder="e.g. 53000" maxLength={5} />
                    </div>
                    <div className="add-order-field">
                      <label>{t('City', '城市')} *</label>
                      <input value={addForm.city} onChange={e => setAddForm(f => ({ ...f, city: e.target.value }))} placeholder={t('City', '城市')} />
                    </div>
                  </div>
                  <div className="add-order-field">
                    <label>{t('State', '州属')} *</label>
                    <select value={addForm.state} onChange={e => setAddForm(f => ({ ...f, state: e.target.value }))}>
                      <option value="">{t('Select state…', '选择州属…')}</option>
                      {MY_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </>
              )}

              <div className="add-order-section-label">{t('Items', '产品')}</div>
              {products.length === 0 && <div style={{ fontSize: 13, color: '#A07070' }}>{t('No products configured.', '未配置产品。')}</div>}
              {products.map(p => (
                <div key={p.id} className="add-order-item-row">
                  <span className="add-order-item-name">{p.name} <span className="add-order-item-price">RM {p.price}</span></span>
                  <div className="add-order-qty-ctrl">
                    <button type="button" onClick={() => setAddForm(f => ({ ...f, qty: { ...f.qty, [p.id]: Math.max(0, (f.qty[p.id] || 0) - 1) } }))}>−</button>
                    <span>{addForm.qty[p.id] || 0}</span>
                    <button type="button" onClick={() => setAddForm(f => ({ ...f, qty: { ...f.qty, [p.id]: (f.qty[p.id] || 0) + 1 } }))}>+</button>
                  </div>
                </div>
              ))}

              <div className="add-order-section-label">{t('Order Status', '订单状态')}</div>
              <div className="add-order-field">
                <select value={addForm.initStatus} onChange={e => setAddForm(f => ({ ...f, initStatus: e.target.value }))}>
                  {STATUS_OPTIONS.map(s => <option key={s} value={s}>{t(STATUS_LABELS[s].en, STATUS_LABELS[s].zh)}</option>)}
                </select>
              </div>

              <div className="add-order-total">
                {t('Total', '总计')}: RM {addFormTotal().toFixed(2)}
                {addForm.mode === 'delivery' && addForm.state && (
                  <span className="add-order-shipping-note"> ({t('incl. delivery', '含运费')})</span>
                )}
              </div>

              {addError && <div className="add-order-error">{addError}</div>}
              <div className="add-order-actions">
                <button type="button" className="add-order-cancel" onClick={() => setShowAddModal(false)}>{t('Cancel', '取消')}</button>
                <button type="submit" className="add-order-submit" disabled={addSaving}>
                  {addSaving ? t('Saving…', '保存中…') : t('Save Order', '保存订单')}
                </button>
              </div>
            </form>
          </div>
        </div>
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
