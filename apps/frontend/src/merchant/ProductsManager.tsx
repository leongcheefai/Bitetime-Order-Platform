import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { toast } from 'sonner'
import { fetchProducts, upsertProduct, deleteProduct, deleteProductImages, productImageUrl } from '../store'
import { formatMoney, currencyDef } from '../currency'
import { SkeletonText } from '../components/Loaders'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog'
import ImagePicker from './ProductImages'

const BLANK = { name: '', name_zh: '', descr: '', price: '', unit: 'pc', active: true }

export default function ProductsManager() {
  const { t, merchant } = useSession()
  const [rows, setRows] = useState<any[] | null>(null)
  const [form, setForm] = useState<any>(BLANK)
  const [busy, setBusy] = useState(false)
  // Draft id lets the add-form upload images to Storage before the row exists.
  const [draftId, setDraftId] = useState(() => crypto.randomUUID())
  const [draftImages, setDraftImages] = useState<string[]>([])
  const [editingPhotos, setEditingPhotos] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const currency = merchant?.currency
  const symbol = currencyDef(currency).symbol

  async function load() { setRows(await fetchProducts(merchant!.id)) }
  useEffect(() => { fetchProducts(merchant!.id).then(setRows) }, [merchant!.id])

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true)
    try {
      await upsertProduct({
        ...form,
        id: draftId,
        image_urls: draftImages,
        price: Number(form.price) || 0,
        merchant_id: merchant!.id,
      })
      setForm(BLANK); setDraftImages([]); setDraftId(crypto.randomUUID()); setAddOpen(false); await load()
      toast.success(t('Product saved', '产品已保存'))
    } finally { setBusy(false) }
  }

  async function toggleActive(p: any) { await upsertProduct({ ...p, active: !p.active }); await load() }
  async function setProductImages(p: any, image_urls: string[]) {
    await upsertProduct({ ...p, image_urls }); await load()
  }
  async function remove(p: any) {
    await deleteProduct(p.id)
    if (p.image_urls?.length) { try { await deleteProductImages(p.image_urls) } catch { /* best-effort */ } }
    await load(); toast.success(t('Product deleted', '产品已删除'))
  }

  const addForm = (
    <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('Add a product', '添加产品')}</DialogTitle>
      </DialogHeader>
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
            <Label htmlFor="pm-4">{t(`Price (${symbol})`, `价格 (${symbol})`)}</Label>
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
          <div className="flex flex-col gap-[6px]">
            <Label>{t('Photos (optional)', '图片（可选）')}</Label>
            <ImagePicker
              merchantId={merchant!.id}
              productId={draftId}
              value={draftImages}
              onChange={paths => setDraftImages(paths as string[])}
              t={t}
            />
          </div>
        </div>
        <Button type="submit" size="md" className="mt-4 w-full" disabled={busy}>
          {busy ? t('Saving…', '保存中…') : t('Add product', '添加产品')}
        </Button>
      </form>
    </DialogContent>
  )

  if (!rows) return (
    <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
      <SkeletonText lines={4} />
    </div>
  )

  return (
    <div>
      {/* Your products panel */}
      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="font-heading text-[15px] font-medium text-oxblood flex items-center gap-2">
            {t('Your products', '您的产品')}
          </h3>
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger
              render={
                <Button type="button" size="none" className="rounded-pill py-[6px] px-[14px] text-[13px] whitespace-nowrap" />
              }
            >
              {t('+ Add product', '+ 添加产品')}
            </DialogTrigger>
            {addForm}
          </Dialog>
        </div>
        {rows.length === 0 ? (
          <p className="text-[13px] text-text-tertiary italic">{t('No products yet — tap “Add product” to create your first.', '还没有产品 — 点击“添加产品”创建第一个。')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((p: any) => (
              <div
                key={p.id}
                className={`flex flex-col gap-2 px-[14px] py-[10px] bg-cream border-[1.5px] border-clay-border rounded-lg transition-colors${p.active ? '' : ' opacity-50'}`}
              >
                <div className="flex items-center gap-3 max-[480px]:flex-wrap">
                  {p.image_urls?.length ? (
                    <img
                      src={productImageUrl(p.image_urls[0])}
                      alt=""
                      className="size-11 shrink-0 object-cover rounded-lg border-[1.5px] border-clay-border"
                    />
                  ) : (
                    <div className="size-11 shrink-0 rounded-lg border-[1.5px] border-dashed border-clay-border" aria-hidden />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-medium text-ink">
                      {p.name}
                      {p.name_zh ? <span className="text-rose-muted font-normal"> / {p.name_zh}</span> : null}
                      {!p.active && <em className="italic text-[12px] text-text-tertiary"> · {t('hidden', '已隐藏')}</em>}
                    </div>
                    <div className="text-[12px] text-rose-muted mt-0.5">{formatMoney(p.price, currency)} / {p.unit}</div>
                  </div>
                  <div className="flex gap-[6px] shrink-0 max-[480px]:w-full max-[480px]:justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="none"
                      className="rounded-pill py-[5px] px-3 text-[12px] bg-surface-raised whitespace-nowrap hover:border-oxblood hover:text-oxblood hover:bg-oxblood-tint"
                      onClick={() => setEditingPhotos(editingPhotos === p.id ? null : p.id)}
                    >
                      {t('Photos', '图片')}{p.image_urls?.length ? ` (${p.image_urls.length})` : ''}
                    </Button>
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
                      onClick={() => remove(p)}
                    >
                      {t('Delete', '删除')}
                    </Button>
                  </div>
                </div>
                {editingPhotos === p.id && (
                  <div className="pl-[52px] max-[480px]:pl-0">
                    <ImagePicker
                      merchantId={merchant!.id}
                      productId={p.id}
                      value={p.image_urls ?? []}
                      onChange={paths => setProductImages(p, paths)}
                      t={t}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
