import { useState, useEffect } from 'react';
import { loadVouchers, createVoucher } from '../store';

function generateCode() {
  return 'BITE-' + Math.random().toString(36).toUpperCase().slice(2, 8);
}

export default function VoucherPanel({ lang }) {
  const t = (en, zh) => lang === 'zh' ? zh : en;

  const [vouchers, setVouchers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState(generateCode());
  const [discountType, setDiscountType] = useState('fixed');
  const [discountValue, setDiscountValue] = useState('');
  const [targetEmail, setTargetEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

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
      used: false,
      createdAt: new Date().toISOString(),
    };
    const updated = await createVoucher(newVoucher);
    setVouchers(updated);
    setCode(generateCode());
    setDiscountValue('');
    setTargetEmail('');
    setSaving(false);
    setSaveMsg(t('✓ Voucher created!', '✓ 优惠券已创建！'));
    setTimeout(() => setSaveMsg(''), 2500);
  }

  function formatDiscount(v) {
    return v.type === 'percent' ? `${v.value}% off` : `RM ${v.value} off`;
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString('en-MY', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  return (
    <div className="admin-panel">
      <div className="admin-title"><span>🎟️</span> {t('Vouchers', '优惠券')}</div>

      {/* Create voucher */}
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

      {/* Voucher list */}
      <div className="admin-section">
        <div className="admin-section-label">{t('All vouchers', '所有优惠券')}</div>
        {loading ? (
          <p style={{ color: '#aaa', fontSize: '13px' }}>{t('Loading…', '加载中…')}</p>
        ) : vouchers.length === 0 ? (
          <p style={{ color: '#aaa', fontSize: '13px' }}>{t('No vouchers yet.', '暂无优惠券。')}</p>
        ) : (
          <div className="voucher-list">
            {vouchers.map((v, i) => (
              <div key={i} className={'voucher-row' + (v.used ? ' used' : '')}>
                <div className="voucher-code">{v.code}</div>
                <div className="voucher-meta">
                  <span className="voucher-discount">{formatDiscount(v)}</span>
                  {v.email && <span className="voucher-email">→ {v.email}</span>}
                  <span className="voucher-date">{formatDate(v.createdAt)}</span>
                </div>
                <div className={'voucher-status' + (v.used ? ' used' : ' active')}>
                  {v.used ? t('Used', '已使用') : t('Active', '有效')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
