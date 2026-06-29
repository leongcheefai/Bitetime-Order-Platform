import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchAllOrders, fetchUserOrders, loadOrderStatuses } from '../store';
import type { Lang, Order } from '../types';

interface NotificationsProps {
  account: { id: string; email?: string } | null | undefined;
  isOwner: boolean;
  lang: Lang;
  onOpen?: () => void;
}

interface Note {
  id: string;
  title: string;
  body: string;
  ts?: string;
}

// Mirror of OrderList's labels so customer notifications read the same wording.
const STATUS_LABELS = {
  pending:   { en: 'Pending',          zh: '待处理' },
  confirmed: { en: 'Confirmed',        zh: '已确认' },
  preparing: { en: 'Ready to Deliver', zh: '准备送货' },
  ready:     { en: 'Out for Delivery', zh: '派送中'  },
  completed: { en: 'Completed',        zh: '已完成' },
  cancelled: { en: 'Cancelled',        zh: '已取消' },
};

const OWNER_TS_KEY = 'bitetime_owner_seen_ts';
const custSnapKey = (id: string) => `bitetime_cust_status_${id}`;

function readJSON(key: string): any {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

// Notification bell for both layouts.
// Owner: orders created after the last "seen" timestamp.
// Customer: own orders whose status changed since the last saved snapshot.
export default function Notifications({ account, isOwner, lang, onOpen }: NotificationsProps) {
  const t = (en: string, zh: string) => (lang === 'zh' ? zh : en);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const ref = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!account) return;
    if (isOwner) {
      const orders: Order[] = await fetchAllOrders();
      let seenTs = Number(localStorage.getItem(OWNER_TS_KEY) || 0);
      // First run on this device: baseline to now so we don't flood with every past order.
      if (!seenTs) { seenTs = Date.now(); localStorage.setItem(OWNER_TS_KEY, String(seenTs)); }
      const fresh = orders.filter((o: Order) => new Date(o.created_at ?? 0).getTime() > seenTs);
      setNotes(fresh.map((o: Order) => ({
        id: o.order_number ?? '',
        title: t('New order', '新订单'),
        body: `${o.order_number}${o.customer_name ? ' · ' + o.customer_name : ''}`,
        ts: o.created_at,
      })));
    } else {
      const [orders, statuses] = await Promise.all([fetchUserOrders(account.id), loadOrderStatuses()]);
      const snapKey = custSnapKey(account.id);
      const snap = readJSON(snapKey);
      const current: Record<string, string> = {};
      for (const o of orders as Order[]) current[o.order_number ?? ''] = statuses[o.order_number ?? ''] || 'pending';
      // First run: save baseline silently, nothing to report yet.
      if (snap === null) {
        localStorage.setItem(snapKey, JSON.stringify(current));
        setNotes([]);
        return;
      }
      const changed: Note[] = [];
      for (const o of orders as Order[]) {
        const cur = current[o.order_number ?? ''];
        const prev = snap[o.order_number ?? ''] ?? 'pending';
        if (cur !== prev) {
          const lbl = (STATUS_LABELS as Record<string, { en: string; zh: string }>)[cur] || { en: cur, zh: cur };
          changed.push({ id: o.order_number ?? '', title: t('Order updated', '订单状态更新'), body: `${o.order_number} → ${t(lbl.en, lbl.zh)}` });
        }
      }
      setNotes(changed);
    }
  }, [account, isOwner, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load(); // eslint-disable-line react-hooks/set-state-in-effect -- async: setState runs post-await, not during render
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, [load]);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function markRead() {
    if (isOwner) {
      localStorage.setItem(OWNER_TS_KEY, String(Date.now()));
    } else if (account) {
      // Re-snapshot current statuses so resolved changes stop showing.
      Promise.all([fetchUserOrders(account.id), loadOrderStatuses()]).then(([orders, statuses]) => {
        const current: Record<string, string> = {};
        for (const o of orders as Order[]) current[o.order_number ?? ''] = statuses[o.order_number ?? ''] || 'pending';
        localStorage.setItem(custSnapKey(account.id), JSON.stringify(current));
      });
    }
    setNotes([]);
    setOpen(false);
  }

  if (!account) return null;
  const count = notes.length;

  return (
    <div className="notif" ref={ref}>
      <button className="notif-bell" aria-label={t('Notifications', '通知')} onClick={() => setOpen(o => !o)}>
        <svg className="notif-bell-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {count > 0 && <span className="notif-badge">{count > 9 ? '9+' : count}</span>}
      </button>
      {open && (
        <div className="notif-panel">
          <div className="notif-panel-head">
            <span>{t('Notifications', '通知')}</span>
            {count > 0 && <button className="notif-readall" onClick={markRead}>{t('Mark all read', '全部已读')}</button>}
          </div>
          {count === 0 ? (
            <div className="notif-empty">{t('No new notifications', '暂无新通知')}</div>
          ) : (
            <div className="notif-list">
              {notes.map((n, i) => (
                <button
                  key={n.id + i}
                  className="notif-item"
                  onClick={() => { if (onOpen) onOpen(); markRead(); }}
                >
                  <div className="notif-item-title">{n.title}</div>
                  <div className="notif-item-body">{n.body}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
