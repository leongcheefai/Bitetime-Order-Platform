import { useState, useEffect } from 'react';
import { loadVouchers, createVoucher, deleteVoucher, voucherFullyUsed } from '../store';
import type { Lang, Voucher } from '../types';

interface VoucherPanelProps {
  lang: Lang;
}

function generateCode() {
  return 'BITE-' + Math.random().toString(36).toUpperCase().slice(2, 8);
}

export default function VoucherPanel({ lang }: VoucherPanelProps) {
  const t = (en: string, zh: string) => lang === 'zh' ? zh : en;

  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState(generateCode());
  const [discountType, setDiscountType] = useState('fixed');
  const [discountValue, setDiscountValue] = useState('');
  const [targetEmail, setTargetEmail] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [minOrder, setMinOrder] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    loadVouchers().then(v => { setVouchers(v); setLoading(false); });
  }, []);

  async function handleCreate() {
    if (!discountValue || parseFloat(discountValue) <= 0) {
      setSaveMsg(t('⚠ Enter a valid discount amount.', '⚠ 请输入有效折扣金额。'));
      return;
    }
    setSaving(true);
    const newVoucher = {
      code: code.trim().toUpperCase(),
      type: discountType,
      value: parseFloat(discountValue),
      email: targetEmail.trim().toLowerCase() || null,
      expiresAt: expiresAt || null,
      minOrder: minOrder ? parseFloat(minOrder) : null,
      maxUses: maxUses ? parseInt(maxUses, 10) : null,
      usedBy: [],
      createdAt: new Date().toISOString(),
    };
    const updated = await createVoucher(newVoucher);
    setVouchers(updated);
    setCode(generateCode());
    setDiscountValue('');
    setTargetEmail('');
    setExpiresAt('');
    setMinOrder('');
    setMaxUses('');
    setSaving(false);
    setSaveMsg(t('✓ Voucher created!', '✓ 优惠券已创建！'));
    setTimeout(() => setSaveMsg(''), 2500);
  }

  async function handleDelete(voucherCode: string) {
    if (!window.confirm(t(`Delete voucher ${voucherCode}?`, `确定删除优惠券 ${voucherCode}？`))) return;
    setDeleting(voucherCode);
    const updated = await deleteVoucher(voucherCode);
    setVouchers(updated);
    setDeleting(null);
  }

  function formatDiscount(v: Voucher) {
    return v.type === 'percent' ? `${v.value}% off` : `RM ${v.value} off`;
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-MY', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function isExpired(v: Voucher) {
    return v.expiresAt && new Date(v.expiresAt) < new Date();
  }

  return (
    <div className="admin-panel">
      <div className="admin-title">{t('Vouchers', '优惠券')}</div>

      <div className="admin-section">
        <div className="admin-section-label">{t('Create voucher', '创建优惠券')}</div>
        <div className="voucher-fields">
          <div className="voucher-field">
            <label>{t('Voucher code', '优惠码')}</label>
            <div className="voucher-code-row">
              <input type="text" value={code} onChange={e => setCode(e.target.value.toUpperCase())} />
              <button className="voucher-gen-btn" onClick={() => setCode(generateCode())}>
                🔀 {t('Generate', '随机')}
              </button>
            </div>
          </div>
          <div className="voucher-field">
            <label>{t('Discount type', '折扣类型')}</label>
            <select value={discountType} onChange={e => setDiscountType(e.target.value)}>
              <option value="fixed">{t('Fixed amount (RM)', '固定金额 (RM)')}</option>
              <option value="percent">{t('Percentage (%)', '百分比 (%)')}</option>
            </select>
          </div>
          <div className="voucher-field">
            <label>{discountType === 'fixed' ? t('Discount amount (RM)', '折扣金额 (RM)') : t('Discount percentage (%)', '折扣百分比 (%)')}</label>
            <input
              type="number" min="0"
              step={discountType === 'fixed' ? '0.50' : '1'}
              max={discountType === 'percent' ? '100' : undefined}
              placeholder={discountType === 'fixed' ? 'e.g. 5' : 'e.g. 10'}
              value={discountValue}
              onChange={e => setDiscountValue(e.target.value)}
            />
          </div>
          <div className="voucher-field">
            <label>
              {t('Minimum order (RM)', '最低消费 (RM)')}
              <span>{t('optional', '选填')}</span>
            </label>
            <input
              type="number" min="0" step="1"
              placeholder={t('e.g. 30', '例如：30')}
              value={minOrder}
              onChange={e => setMinOrder(e.target.value)}
            />
          </div>
          <div className="voucher-field">
            <label>
              {t('Max redemptions', '可使用总次数')}
              <span>{t('optional — blank = unlimited', '选填 — 空白表示无限')}</span>
            </label>
            <input
              type="number" min="1" step="1"
              placeholder={t('e.g. 50', '例如：50')}
              value={maxUses}
              onChange={e => setMaxUses(e.target.value)}
            />
          </div>
          <div className="voucher-field">
            <label>
              {t('Expiry date', '到期日期')}
              <span>{t('optional', '选填')}</span>
            </label>
            <input
              type="date"
              value={expiresAt}
              min={new Date().toISOString().slice(0, 10)}
              onChange={e => setExpiresAt(e.target.value)}
            />
          </div>
          <div className="voucher-field">
            <label>
              {t('Assign to customer email', '指定顾客邮箱')}
              <span>{t('optional — blank = any customer', '选填 — 空白表示任何顾客可用')}</span>
            </label>
            <input type="email" placeholder="customer@example.com" value={targetEmail} onChange={e => setTargetEmail(e.target.value)} />
          </div>
        </div>
        <button className="save-btn" style={{ marginTop: '1rem' }} onClick={handleCreate} disabled={saving}>
          {saving ? t('Creating…', '创建中…') : t('✚ Create voucher', '✚ 创建优惠券')}
        </button>
        {saveMsg && <p className="save-msg">{saveMsg}</p>}
      </div>

      <div className="admin-section">
        <div className="admin-section-label">{t('All vouchers', '所有优惠券')}</div>
        {loading ? (
          <p style={{ color: '#aaa', fontSize: '13px' }}>{t('Loading…', '加载中…')}</p>
        ) : vouchers.length === 0 ? (
          <p style={{ color: '#aaa', fontSize: '13px' }}>{t('No vouchers yet.', '暂无优惠券。')}</p>
        ) : (
          <div className="voucher-list">
            {vouchers.map((v, i) => (
              <div key={i} className={'voucher-row' + (voucherFullyUsed(v) || isExpired(v) ? ' used' : '')}>
                <div className="voucher-code">{v.code}</div>
                <div className="voucher-meta">
                  <span className="voucher-discount">{formatDiscount(v)}</span>
                  {v.minOrder && <span className="voucher-minorder">min RM {v.minOrder}</span>}
                  <span className="voucher-uses">
                    {(v.usedBy?.length ?? 0)}{v.maxUses ? ` / ${v.maxUses}` : ''} {t('used', '已用')}
                  </span>
                  {v.email && <span className="voucher-email">→ {v.email}</span>}
                  {v.expiresAt && (
                    <span className={isExpired(v) ? 'voucher-expiry expired' : 'voucher-expiry'}>
                      {isExpired(v) ? t('Expired', '已过期') : t('Exp', '到期')} {formatDate(v.expiresAt)}
                    </span>
                  )}
                  <span className="voucher-date">{formatDate(v.createdAt)}</span>
                </div>
                <div className={'voucher-status' + (voucherFullyUsed(v) ? ' used' : isExpired(v) ? ' used' : ' active')}>
                  {voucherFullyUsed(v) ? t('Used up', '已用完') : isExpired(v) ? t('Expired', '已过期') : t('Active', '有效')}
                </div>
                <button
                  className="voucher-delete-btn"
                  disabled={deleting === v.code}
                  onClick={() => handleDelete(v.code)}
                  title={t('Delete voucher', '删除优惠券')}
                >
                  {deleting === v.code ? '…' : '✕'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
