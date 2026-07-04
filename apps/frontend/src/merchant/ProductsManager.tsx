import { useEffect, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { MoreHorizontal } from 'lucide-react'
import { useSession } from '../SessionContext'
import { toast } from 'sonner'
import { fetchProducts, upsertProduct, deleteProduct, deleteProductImages, productImageUrl } from '../store'
import { coerceQuantity, formatUnit } from '../productUnit'
import { formatMoney, currencyDef } from '../currency'
import { SkeletonText } from '../components/Loaders'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '../components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { DataTable, SortableHeader } from '../components/ui/data-table'
import ImagePicker from './ProductImages'

// Canonical unit options (value stored as-is; label is bilingual).
const UNITS: { value: string; en: string; zh: string }[] = [
  { value: 'pcs', en: 'pcs', zh: '件' },
  { value: 'box', en: 'box', zh: '盒' },
  { value: 'set', en: 'set', zh: '套' },
  { value: 'pack', en: 'pack', zh: '包' },
  { value: 'dozen', en: 'dozen', zh: '打' },
  { value: 'bottle', en: 'bottle', zh: '瓶' },
  { value: 'jar', en: 'jar', zh: '罐' },
  { value: 'tray', en: 'tray', zh: '盘' },
  { value: 'slice', en: 'slice', zh: '片' },
  { value: 'kg', en: 'kg', zh: '公斤' },
  { value: 'g', en: 'g', zh: '克' },
]

const BLANK = { name: '', name_zh: '', descr: '', price: '', unit: 'pcs', unit_quantity: 1, active: true }

// Handlers + language + currency ride on table.options.meta so the column defs stay
// stable (defined once) and never reset sorting when a row action refetches.
interface ProductTableMeta {
  t: (en: string, zh: string) => string
  currency?: string
  onEdit: (p: any) => void
  onRemove: (p: any) => void
}

const columns: ColumnDef<any>[] = [
  {
    id: 'photo',
    header: () => null,
    enableSorting: false,
    cell: ({ row }) => {
      const p = row.original
      return p.image_urls?.length ? (
        <img
          src={productImageUrl(p.image_urls[0])}
          alt=""
          className="size-11 shrink-0 object-cover rounded-lg border-[1.5px] border-clay-border"
        />
      ) : (
        <div className="size-11 shrink-0 rounded-lg border-[1.5px] border-dashed border-clay-border" aria-hidden />
      )
    },
  },
  {
    accessorKey: 'name',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as ProductTableMeta).t('Product', '产品')} />
    ),
    cell: ({ row, table }) => {
      const { t } = table.options.meta as ProductTableMeta
      const p = row.original
      return (
        <div className="text-[14px] font-medium text-ink">
          {p.name}
          {p.name_zh ? <span className="text-rose-muted font-normal"> / {p.name_zh}</span> : null}
          {!p.active && <em className="italic text-[12px] text-text-tertiary"> · {t('hidden', '已隐藏')}</em>}
        </div>
      )
    },
  },
  {
    accessorKey: 'price',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as ProductTableMeta).t('Price', '价格')} />
    ),
    cell: ({ row, table }) => {
      const { currency } = table.options.meta as ProductTableMeta
      const p = row.original
      return <span className="text-[13px] text-rose-muted whitespace-nowrap">{formatMoney(p.price, currency)} / {formatUnit(p.unit_quantity, p.unit)}</span>
    },
  },
  {
    id: 'actions',
    header: ({ table }) => (
      <div className="text-right whitespace-nowrap">{(table.options.meta as ProductTableMeta).t('Actions', '操作')}</div>
    ),
    cell: ({ row, table }) => {
      const meta = table.options.meta as ProductTableMeta
      const { t } = meta
      const p = row.original
      return (
        <div className="text-right">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="none"
                  className="size-8 p-0 rounded-full cursor-pointer hover:bg-oxblood-tint hover:text-oxblood"
                  aria-label={t('Actions', '操作')}
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onEdit(p)}>{t('Edit', '编辑')}</DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onRemove(p)}>{t('Delete', '删除')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )
    },
  },
]

export default function ProductsManager() {
  const { t, merchant } = useSession()
  const [rows, setRows] = useState<any[] | null>(null)
  const [form, setForm] = useState<any>(BLANK)
  const [busy, setBusy] = useState(false)
  // editingProduct = the row being edited (null → add mode).
  const [editingProduct, setEditingProduct] = useState<any | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  // Draft id lets the add-form upload images to Storage before the row exists.
  const [draftId, setDraftId] = useState(() => crypto.randomUUID())
  // Photos being edited in the add/edit dialog (add: new draft; edit: the row's).
  const [images, setImages] = useState<string[]>([])
  const currency = merchant?.currency
  const symbol = currencyDef(currency).symbol

  async function load() { setRows(await fetchProducts(merchant!.id)) }
  useEffect(() => { fetchProducts(merchant!.id).then(setRows) }, [merchant!.id])

  function openAdd() {
    setEditingProduct(null)
    setForm(BLANK)
    setImages([]); setDraftId(crypto.randomUUID())
    setFormOpen(true)
  }
  function openEdit(p: any) {
    setEditingProduct(p)
    setForm({
      name: p.name ?? '', name_zh: p.name_zh ?? '', descr: p.descr ?? '',
      price: String(p.price ?? ''), unit: p.unit ?? 'pc', unit_quantity: p.unit_quantity ?? 1, active: p.active,
    })
    setImages(p.image_urls ?? [])
    setFormOpen(true)
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true)
    try {
      if (editingProduct) {
        // Spread the original row first so sort / active / etc. survive the upsert.
        await upsertProduct({ ...editingProduct, ...form, image_urls: images, price: Number(form.price) || 0, unit_quantity: coerceQuantity(form.unit_quantity) })
      } else {
        await upsertProduct({
          ...form,
          id: draftId,
          image_urls: images,
          price: Number(form.price) || 0,
          unit_quantity: coerceQuantity(form.unit_quantity),
          merchant_id: merchant!.id,
        })
      }
      setFormOpen(false); setForm(BLANK); setEditingProduct(null); setImages([]); setDraftId(crypto.randomUUID())
      await load()
      toast.success(t('Product saved', '产品已保存'))
    } finally { setBusy(false) }
  }

  async function setProductImages(p: any, image_urls: string[]) {
    await upsertProduct({ ...p, image_urls }); await load()
  }
  async function remove(p: any) {
    await deleteProduct(p.id)
    if (p.image_urls?.length) { try { await deleteProductImages(p.image_urls) } catch { /* best-effort */ } }
    await load(); toast.success(t('Product deleted', '产品已删除'))
  }

  const meta: ProductTableMeta = {
    t, currency,
    onEdit: openEdit,
    onRemove: remove,
  }

  if (!rows) return (
    <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
      <SkeletonText lines={4} />
    </div>
  )

  return (
    <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="font-heading text-[15px] font-medium text-oxblood flex items-center gap-2">
          {t('Your products', '您的产品')}
        </h3>
        <Button type="button" size="none" className="rounded-pill py-[6px] px-[14px] text-[13px] whitespace-nowrap" onClick={openAdd}>
          {t('+ Add product', '+ 添加产品')}
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        meta={meta}
        searchPlaceholder={t('Search products…', '搜索产品…')}
        emptyText={t('No products yet — tap “Add product” to create your first.', '还没有产品 — 点击“添加产品”创建第一个。')}
        prevLabel={t('Previous', '上一页')}
        nextLabel={t('Next', '下一页')}
      />

      {/* Add / edit product details. disablePointerDismissal: the unit Select
          portals its menu to <body>, so an item click would otherwise read as an
          outside-press and close the dialog. Close via the X, Save, or Escape. */}
      <Dialog open={formOpen} onOpenChange={setFormOpen} disablePointerDismissal>
        <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingProduct ? t('Edit product', '编辑产品') : t('Add a product', '添加产品')}</DialogTitle>
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
                <div className="flex gap-2">
                  <Input
                    id="pm-qty"
                    variant="compact"
                    type="number"
                    step="0.01"
                    min="0.01"
                    className="w-24"
                    value={form.unit_quantity}
                    onChange={e => setForm({ ...form, unit_quantity: e.target.value })}
                    aria-label={t('Unit quantity', '单位数量')}
                    placeholder="1"
                  />
                  <Select value={form.unit} onValueChange={v => setForm({ ...form, unit: v })}>
                    <SelectTrigger id="pm-5" className="flex-1 bg-cream border-clay-border text-[13px]">
                      <SelectValue />
                    </SelectTrigger>
                    {/* z-modal-popover (400) floats above the dialog popup (z-modal). */}
                    <SelectContent className="z-modal-popover">
                      {/* Keep a legacy value (e.g. old "pc") selectable so existing rows survive. */}
                      {form.unit && !UNITS.some(u => u.value === form.unit) && (
                        <SelectItem value={form.unit}>{form.unit}</SelectItem>
                      )}
                      {UNITS.map(u => (
                        <SelectItem key={u.value} value={u.value}>{t(u.en, u.zh)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-col gap-[6px]">
                <Label>{t('Photos (optional)', '图片（可选）')}</Label>
                <ImagePicker
                  merchantId={merchant!.id}
                  productId={editingProduct ? editingProduct.id : draftId}
                  value={images}
                  onChange={paths => {
                    setImages(paths as string[])
                    // Edit mode: the row exists, so persist immediately — that way a
                    // removed photo isn't left dangling if the dialog is cancelled.
                    if (editingProduct) return setProductImages(editingProduct, paths as string[])
                  }}
                  t={t}
                />
              </div>
              <div className="flex items-center justify-between gap-3 pt-1">
                <div className="flex flex-col">
                  <Label htmlFor="pm-active">{t('Visible in storefront', '在店面显示')}</Label>
                  <span className="text-[12px] text-text-tertiary">
                    {form.active ? t('Customers can order this', '顾客可下单') : t('Hidden from customers', '对顾客隐藏')}
                  </span>
                </div>
                <button
                  id="pm-active"
                  type="button"
                  role="switch"
                  aria-checked={form.active}
                  onClick={() => setForm({ ...form, active: !form.active })}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer ${form.active ? 'bg-oxblood' : 'bg-clay-border'}`}
                >
                  <span className={`inline-block size-5 rounded-full bg-white shadow-sm transition-transform ${form.active ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                </button>
              </div>
            </div>
            <Button type="submit" size="md" className="mt-4 w-full" disabled={busy}>
              {busy ? t('Saving…', '保存中…') : editingProduct ? t('Save changes', '保存更改') : t('Add product', '添加产品')}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
