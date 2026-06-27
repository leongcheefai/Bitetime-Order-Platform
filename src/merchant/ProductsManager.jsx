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

  if (!rows) return <p>{t('Loading…','加载中…')}</p>
  return (
    <div>
      <h3>{t('Your products','您的产品')}</h3>
      {rows.length === 0 && <p>{t('No products yet — add your first below.','还没有产品 — 在下方添加。')}</p>}
      <ul style={{ listStyle:'none', padding:0 }}>
        {rows.map(p => (
          <li key={p.id} style={{ borderTop:'1px solid #eee', padding:'8px 0', opacity: p.active ? 1 : 0.5 }}>
            <b>{p.name}</b>{p.name_zh ? ` / ${p.name_zh}` : ''} — RM {Number(p.price).toFixed(2)} / {p.unit}
            {!p.active && <em> ({t('hidden','已隐藏')})</em>}
            <span style={{ float:'right' }}>
              <button onClick={() => toggleActive(p)}>{p.active ? t('Hide','隐藏') : t('Show','显示')}</button>{' '}
              <button onClick={() => remove(p.id)}>{t('Delete','删除')}</button>
            </span>
          </li>
        ))}
      </ul>
      <form onSubmit={save} style={{ marginTop:16, display:'grid', gap:6, maxWidth:420 }}>
        <h4>{t('Add a product','添加产品')}</h4>
        <input placeholder={t('Name','名称')} value={form.name} onChange={e=>setForm({...form,name:e.target.value})} required />
        <input placeholder={t('Chinese name (optional)','中文名称（可选）')} value={form.name_zh} onChange={e=>setForm({...form,name_zh:e.target.value})} />
        <input placeholder={t('Description','描述')} value={form.descr} onChange={e=>setForm({...form,descr:e.target.value})} />
        <input type="number" step="0.01" placeholder={t('Price (RM)','价格 (RM)')} value={form.price} onChange={e=>setForm({...form,price:e.target.value})} required />
        <input placeholder={t('Unit (pc/box)','单位')} value={form.unit} onChange={e=>setForm({...form,unit:e.target.value})} />
        <button disabled={busy}>{busy ? t('Saving…','保存中…') : t('Add product','添加产品')}</button>
      </form>
    </div>
  )
}
