import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { useToast } from '../ToastContext'
import { fetchMerchantVouchers, createMerchantVoucher, deleteMerchantVoucher } from '../store'
import { SkeletonText } from '../components/Loaders'
import type { Voucher } from '../types'

const BLANK = { code: '', kind: 'percent', amount: '', maxUses: '' }

export default function VouchersManager() {
  const { t, merchant } = useSession()
  const toast = useToast()
  const [rows, setRows] = useState<Voucher[] | null>(null)
  const [form, setForm] = useState<any>(BLANK)
  const [busy, setBusy] = useState(false)

  async function load() { setRows(await fetchMerchantVouchers(merchant!.id)) }
  useEffect(() => { fetchMerchantVouchers(merchant!.id).then(setRows) }, [merchant!.id])

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true)
    try {
      await createMerchantVoucher({
        merchantId: merchant!.id,
        code: form.code,
        kind: form.kind,
        amount: Number(form.amount) || 0,
        maxUses: form.maxUses === '' ? null : Number(form.maxUses),
      })
      setForm(BLANK); await load()
      toast.success(t('Voucher created', '优惠券已创建'))
    } catch {
      toast.error(t('Could not create voucher — is the code already used?', '无法创建优惠券 — 优惠码是否已存在？'))
    } finally { setBusy(false) }
  }

  async function remove(id: string) {
    await deleteMerchantVoucher(id); await load()
    toast.success(t('Voucher deleted', '优惠券已删除'))
  }

  function valueLabel(v: Voucher) {
    const value = (v as any).value
    return (v as any).type === 'percent' ? `${value}% off` : `RM ${Number(value).toFixed(2)} off`
  }
  function usesLabel(v: Voucher) {
    const used = Array.isArray(v.usedBy) ? v.usedBy.length : 0
    const cap = v.maxUses == null ? '∞' : v.maxUses
    return t(`${used} / ${cap} used`, `已用 ${used} / ${cap}`)
  }

  if (!rows) return (
    <div className="admin-panel">
      <SkeletonText lines={4} />
    </div>
  )

  return (
    <div>
      <div className="admin-panel">
        <h3 className="admin-title">{t('Your vouchers', '您的优惠券')}</h3>
        {rows.length === 0 ? (
          <p className="empty-msg">{t('No vouchers yet — create your first below.', '还没有优惠券 — 在下方创建。')}</p>
        ) : (
          <div className="mm-product-list">
            {rows.map((v: Voucher) => (
              <div key={(v as any).id} className="mm-product-row">
                <div className="mm-product-info">
                  <div className="mm-product-name">{v.code}</div>
                  <div className="mm-product-meta">{valueLabel(v)} · {usesLabel(v)}</div>
                </div>
                <div className="mm-product-actions">
                  <button type="button" className="mm-pill-btn" onClick={() => remove((v as any).id)}>
                    {t('Delete', '删除')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="admin-panel">
        <h3 className="admin-title">{t('Create a voucher', '创建优惠券')}</h3>
        <form onSubmit={save}>
          <div className="admin-fields">
            <div className="admin-field full">
              <label htmlFor="vm-code">{t('Code', '优惠码')}</label>
              <input id="vm-code"
                value={form.code}
                onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })}
                required
                placeholder={t('e.g. SAVE10', '如：SAVE10')}
              />
            </div>
            <div className="admin-field full">
              <label htmlFor="vm-kind">{t('Type', '类型')}</label>
              <select id="vm-kind"
                value={form.kind}
                onChange={e => setForm({ ...form, kind: e.target.value })}
              >
                <option value="percent">{t('Percentage (%)', '百分比 (%)')}</option>
                <option value="fixed">{t('Fixed amount (RM)', '固定金额 (RM)')}</option>
              </select>
            </div>
            <div className="admin-field full">
              <label htmlFor="vm-amount">
                {form.kind === 'percent' ? t('Percent off', '折扣百分比') : t('Amount off (RM)', '折扣金额 (RM)')}
              </label>
              <input id="vm-amount"
                type="number"
                step={form.kind === 'percent' ? '1' : '0.01'}
                value={form.amount}
                onChange={e => setForm({ ...form, amount: e.target.value })}
                required
                placeholder={form.kind === 'percent' ? '10' : '5.00'}
              />
            </div>
            <div className="admin-field full">
              <label htmlFor="vm-max">{t('Max total uses (blank = unlimited)', '最大使用次数（留空 = 不限）')}</label>
              <input id="vm-max"
                type="number"
                step="1"
                value={form.maxUses}
                onChange={e => setForm({ ...form, maxUses: e.target.value })}
                placeholder={t('unlimited', '不限')}
              />
            </div>
          </div>
          <button type="submit" className="save-btn" style={{ marginTop: '12px' }} disabled={busy}>
            {busy ? t('Saving…', '保存中…') : t('Create voucher', '创建优惠券')}
          </button>
        </form>
      </div>
    </div>
  )
}
