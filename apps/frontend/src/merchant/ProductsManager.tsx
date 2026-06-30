import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { useToast } from '../ToastContext'
import { fetchProducts, upsertProduct, deleteProduct } from '../store'
import { SkeletonText } from '../components/Loaders'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'

const BLANK = { name: '', name_zh: '', descr: '', price: '', unit: 'pc', active: true }

export default function ProductsManager() {
  const { t, merchant } = useSession()
  const toast = useToast()
  const [rows, setRows] = useState<any[] | null>(null)
  const [form, setForm] = useState<any>(BLANK)
  const [busy, setBusy] = useState(false)

  async function load() { setRows(await fetchProducts(merchant!.id)) }
  useEffect(() => { fetchProducts(merchant!.id).then(setRows) }, [merchant!.id])

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true)
    try {
      await upsertProduct({
        ...form,
        price: Number(form.price) || 0,
        merchant_id: merchant!.id,
      })
      setForm(BLANK); await load()
      toast.success(t('Product saved', '产品已保存'))
    } finally { setBusy(false) }
  }

  async function toggleActive(p: any) { await upsertProduct({ ...p, active: !p.active }); await load() }
  async function remove(id: string) { await deleteProduct(id); await load(); toast.success(t('Product deleted', '产品已删除')) }

  if (!rows) return (
    <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
      <SkeletonText lines={4} />
    </div>
  )

  return (
    <div>
      {/* Your products panel */}
      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
        <h3 className="font-heading text-[15px] font-medium text-oxblood mb-4 flex items-center gap-2">
          {t('Your products', '您的产品')}
        </h3>
        {rows.length === 0 ? (
          <p className="empty-msg">{t('No products yet — add your first below.', '还没有产品 — 在下方添加。')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((p: any) => (
              <div
                key={p.id}
                className={`flex items-center gap-3 px-[14px] py-[10px] bg-cream border-[1.5px] border-clay-border rounded-lg transition-colors max-[480px]:flex-wrap${p.active ? '' : ' opacity-50'}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-medium text-ink">
                    {p.name}
                    {p.name_zh ? <span className="text-rose-muted font-normal"> / {p.name_zh}</span> : null}
                    {!p.active && <em className="italic text-[12px] text-text-tertiary"> · {t('hidden', '已隐藏')}</em>}
                  </div>
                  <div className="text-[12px] text-rose-muted mt-0.5">RM {Number(p.price).toFixed(2)} / {p.unit}</div>
                </div>
                <div className="flex gap-[6px] shrink-0 max-[480px]:w-full max-[480px]:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="none"
                    className="rounded-pill py-[5px] px-3 text-[12px] bg-surface-raised whitespace-nowrap hover:border-oxblood hover:text-oxblood hover:bg-oxblood-tint"
                    onClick={() => toggleActive(p)}
                  >
                    {p.active ? t('Hide', '隐藏') : t('Show', '显示')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="none"
                    className="rounded-pill py-[5px] px-3 text-[12px] bg-surface-raised whitespace-nowrap hover:border-oxblood hover:text-oxblood hover:bg-oxblood-tint"
                    onClick={() => remove(p.id)}
                  >
                    {t('Delete', '删除')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add a product panel */}
      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
        <h3 className="font-heading text-[15px] font-medium text-oxblood mb-4 flex items-center gap-2">
          {t('Add a product', '添加产品')}
        </h3>
        <form onSubmit={save}>
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="pm-1">{t('Name', '名称')}</Label>
              <Input
                id="pm-1"
                variant="compact"
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                required
                placeholder={t('e.g. Brown Butter Cookie', '如：焦化奶油曲奇')}
              />
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="pm-2">{t('Chinese name (optional)', '中文名称（可选）')}</Label>
              <Input
                id="pm-2"
                variant="compact"
                value={form.name_zh}
                onChange={e => setForm({ ...form, name_zh: e.target.value })}
                placeholder="e.g. 焦化奶油曲奇"
              />
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="pm-3">{t('Description', '描述')}</Label>
              <Textarea
                id="pm-3"
                value={form.descr}
                onChange={e => setForm({ ...form, descr: e.target.value })}
                placeholder={t('Short description (optional)', '简短描述（可选）')}
                className="bg-cream text-[13px] rounded-sm py-[7px] px-2.5 min-h-0"
              />
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="pm-4">{t('Price (RM)', '价格 (RM)')}</Label>
              <Input
                id="pm-4"
                variant="compact"
                type="number"
                step="0.01"
                value={form.price}
                onChange={e => setForm({ ...form, price: e.target.value })}
                required
                placeholder="0.00"
              />
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="pm-5">{t('Unit', '单位')}</Label>
              <Input
                id="pm-5"
                variant="compact"
                value={form.unit}
                onChange={e => setForm({ ...form, unit: e.target.value })}
                placeholder="pc / box / kg"
              />
            </div>
          </div>
          <Button type="submit" size="md" className="mt-3" disabled={busy}>
            {busy ? t('Saving…', '保存中…') : t('Add product', '添加产品')}
          </Button>
        </form>
      </div>
    </div>
  )
}
