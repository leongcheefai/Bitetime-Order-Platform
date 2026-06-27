import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchProducts, upsertProduct, deleteProduct } from '../store'

const BLANK = { name: '', name_zh: '', descr: '', price: '', unit: 'pc', active: true }

export default function ProductsManager() {
  const { t, merchant } = useSession()
  const [rows, setRows] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [busy, setBusy] = useState(false)

  async function load() { setRows(await fetchProducts(merchant.id)) }
  useEffect(() => { fetchProducts(merchant.id).then(setRows) }, [merchant.id])

  async function save(e) {
    e.preventDefault(); setBusy(true)
    try {
      await upsertProduct({
        ...form,
        price: Number(form.price) || 0,
        merchant_id: merchant.id,
      })
      setForm(BLANK); await load()
    } finally { setBusy(false) }
  }

  async function toggleActive(p) { await upsertProduct({ ...p, active: !p.active }); await load() }
  async function remove(id) { await deleteProduct(id); await load() }

  if (!rows) return (
    <div className="admin-panel">
      <p className="empty-msg">{t('Loading…', '加载中…')}</p>
    </div>
  )

  return (
    <div>
      <div className="admin-panel">
        <h3 className="admin-title">{t('Your products', '您的产品')}</h3>
        {rows.length === 0 ? (
          <p className="empty-msg">{t('No products yet — add your first below.', '还没有产品 — 在下方添加。')}</p>
        ) : (
          <div className="mm-product-list">
            {rows.map(p => (
              <div key={p.id} className={`mm-product-row${p.active ? '' : ' mm-product-row--hidden'}`}>
                <div className="mm-product-info">
                  <div className="mm-product-name">
                    {p.name}
                    {p.name_zh ? <span className="mm-product-zh"> / {p.name_zh}</span> : null}
                    {!p.active && <em className="mm-product-hidden-tag"> · {t('hidden', '已隐藏')}</em>}
                  </div>
                  <div className="mm-product-meta">RM {Number(p.price).toFixed(2)} / {p.unit}</div>
                </div>
                <div className="mm-product-actions">
                  <button type="button" className="mm-pill-btn" onClick={() => toggleActive(p)}>
                    {p.active ? t('Hide', '隐藏') : t('Show', '显示')}
                  </button>
                  <button type="button" className="mm-pill-btn" onClick={() => remove(p.id)}>
                    {t('Delete', '删除')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="admin-panel">
        <h3 className="admin-title">{t('Add a product', '添加产品')}</h3>
        <form onSubmit={save}>
          <div className="admin-fields">
            <div className="admin-field full">
              <label>{t('Name', '名称')}</label>
              <input
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                required
                placeholder={t('e.g. Brown Butter Cookie', '如：焦化奶油曲奇')}
              />
            </div>
            <div className="admin-field full">
              <label>{t('Chinese name (optional)', '中文名称（可选）')}</label>
              <input
                value={form.name_zh}
                onChange={e => setForm({ ...form, name_zh: e.target.value })}
                placeholder="e.g. 焦化奶油曲奇"
              />
            </div>
            <div className="admin-field full">
              <label>{t('Description', '描述')}</label>
              <input
                value={form.descr}
                onChange={e => setForm({ ...form, descr: e.target.value })}
                placeholder={t('Short description (optional)', '简短描述（可选）')}
              />
            </div>
            <div className="admin-field full">
              <label>{t('Price (RM)', '价格 (RM)')}</label>
              <input
                type="number"
                step="0.01"
                value={form.price}
                onChange={e => setForm({ ...form, price: e.target.value })}
                required
                placeholder="0.00"
              />
            </div>
            <div className="admin-field full">
              <label>{t('Unit', '单位')}</label>
              <input
                value={form.unit}
                onChange={e => setForm({ ...form, unit: e.target.value })}
                placeholder="pc / box / kg"
              />
            </div>
          </div>
          <button type="submit" className="save-btn" style={{ marginTop: '12px' }} disabled={busy}>
            {busy ? t('Saving…', '保存中…') : t('Add product', '添加产品')}
          </button>
        </form>
      </div>
    </div>
  )
}
