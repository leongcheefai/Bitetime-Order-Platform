import { useEffect, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { MoreHorizontal, Package } from 'lucide-react'
import { useSession } from '../SessionContext'
import { toast } from 'sonner'
import { fetchProducts, upsertProduct, deleteProduct, deleteProductImages, productImageUrl } from '../store'
import { coerceQuantity, formatUnit } from '../productUnit'
import { formatMoney, currencyDef } from '../currency'
import { promoEndFromDate, promoEndToDate } from '../promoEnd'
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
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from '../components/ui/empty'
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

const BLANK = {
  name: '', name_zh: '', descr: '', price: '', unit: 'pcs', unit_quantity: 1, active: true,
  promo_price: '', promo_limit: '', promo_end: '',
}

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
  const [msg, setMsg] = useState('')
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
    setImages([]); setDraftId(crypto.randomUUID()); setMsg('')
    setFormOpen(true)
  }
  function openEdit(p: any) {
    setEditingProduct(p)
    setMsg('')
    setForm({
      name: p.name ?? '', name_zh: p.name_zh ?? '', descr: p.descr ?? '',
      price: String(p.price ?? ''), unit: p.unit ?? 'pc', unit_quantity: p.unit_quantity ?? 1, active: p.active,
      promo_price: p.promo_price === null || p.promo_price === undefined ? '' : String(p.promo_price),
      promo_limit: p.promo_limit === null || p.promo_limit === undefined ? '' : String(p.promo_limit),
      promo_end: promoEndToDate(p.promo_end),
    })
    setImages(p.image_urls ?? [])
    setFormOpen(true)
  }

  /**
   * The promo columns, from the three form fields. An empty field is NULL — no promo / no cap / no
   * end date — and `promo_price: 0` is a real promo (a free item), so this tests for '' and never
   * for falsiness.
   *
   * `promo_sold` is deliberately absent: the browser cannot write it (a DB trigger pins it), and it
   * is the backend's counter. The whole-row spread below still carries it back unchanged; the
   * trigger is what makes that harmless.
   */
  function promoFields(f: any) {
    return {
      promo_price: f.promo_price === '' ? null : Number(f.promo_price),
      promo_limit: f.promo_limit === '' ? null : Number(f.promo_limit),
      promo_end: promoEndFromDate(f.promo_end),
    }
  }

  /** Returns a message to show, or null. The DB has the same check — this is the one with words. */
  function promoProblem(f: any): string | null {
    if (f.promo_price === '') return null
    const promo = Number(f.promo_price)
    const price = Number(f.price) || 0
    if (!Number.isFinite(promo) || promo < 0) {
      return t('The promo price must be a number, and not negative.', '优惠价必须是非负数字。')
    }
    if (promo >= price) {
      return t('The promo price must be below the normal price.', '优惠价必须低于原价。')
    }
    if (f.promo_limit !== '' && (!Number.isInteger(Number(f.promo_limit)) || Number(f.promo_limit) < 1)) {
      return t('The promo limit must be a whole number of at least 1.', '优惠数量上限必须是不小于 1 的整数。')
    }
    return null
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMsg('')
    const problem = promoProblem(form)
    if (problem) { setMsg(problem); setBusy(false); return }
    try {
      if (editingProduct) {
        // Spread the original row first so sort / active / etc. survive the upsert.
        await upsertProduct({
          ...editingProduct, ...form, ...promoFields(form),
          image_urls: images,
          price: Number(form.price) || 0,
          unit_quantity: coerceQuantity(form.unit_quantity),
        })
      } else {
        await upsertProduct({
          ...form,
          ...promoFields(form),
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
    } catch (err: any) {
      // The DB's own check (`products_promo_below_price`) is the backstop for a promo left running
      // when the merchant later drops the base price below it — the form's own check above cannot
      // see that case, since it only runs against the price typed in this same save. Postgres's raw
      // constraint string is not something to show a merchant.
      if (typeof err?.message === 'string' && err.message.includes('products_promo_below_price')) {
        setMsg(t('The promo price is no longer below the normal price. Lower or clear the promo price first.',
          '优惠价已不低于原价。请先降低或清除优惠价。'))
      } else {
        setMsg(err?.message || t('Something went wrong.', '出错了。'))
      }
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

      {rows.length === 0 ? (
        <Empty className="border-[1.5px] border-dashed border-clay-border bg-cream/50">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-oxblood-tint text-oxblood">
              <Package />
            </EmptyMedia>
            <EmptyTitle className="text-oxblood">{t('No products yet', '还没有产品')}</EmptyTitle>
            <EmptyDescription className="text-rose-muted">
              {t('Add your first product to start taking orders in your storefront.', '添加第一个产品，开始在店面接收订单。')}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" size="none" className="rounded-pill py-[6px] px-[14px] text-[13px]" onClick={openAdd}>
              {t('+ Add product', '+ 添加产品')}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          meta={meta}
          searchPlaceholder={t('Search products…', '搜索产品…')}
          emptyText={t('No products match your search.', '没有匹配的产品。')}
          prevLabel={t('Previous', '上一页')}
          nextLabel={t('Next', '下一页')}
        />
      )}

      {/* Add / edit product details. disablePointerDismissal: the unit Select
          portals its menu to <body>, so an item click would otherwise read as an
          outside-press and close the dialog. Close via the X, Save, or Escape. */}
      <Dialog open={formOpen} onOpenChange={setFormOpen} disablePointerDismissal>
        <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingProduct ? t('Edit product', '编辑产品') : t('Add a product', '添加产品')}</DialogTitle>
          </DialogHeader>
          {msg && (
            <div className="text-[13px] text-ink-soft bg-oxblood-tint border border-rose-border rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
              {msg}
            </div>
          )}
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
                <Label htmlFor="pm-promo-price">{t('Promo price', '优惠价')}</Label>
                <Input
                  id="pm-promo-price"
                  variant="compact"
                  type="number"
                  step="0.01"
                  value={form.promo_price}
                  onChange={e => setForm({ ...form, promo_price: e.target.value })}
                  placeholder="0.00"
                />
                <span className="text-[12px] text-text-tertiary">{t('Leave empty for no promo.', '留空表示无优惠。')}</span>
              </div>
              <div className="flex flex-col gap-[6px]">
                <Label htmlFor="pm-promo-limit">{t('Promo limit', '优惠数量上限')}</Label>
                <Input
                  id="pm-promo-limit"
                  variant="compact"
                  type="number"
                  step="1"
                  min="1"
                  value={form.promo_limit}
                  onChange={e => setForm({ ...form, promo_limit: e.target.value })}
                  placeholder={t('No limit', '不限')}
                />
                <span className="text-[12px] text-text-tertiary">
                  {t('How many units sell at this price. Leave empty for no limit.', '以此价格出售的数量。留空表示不限。')}
                </span>
              </div>
              <div className="flex flex-col gap-[6px]">
                <Label htmlFor="pm-promo-end">{t('Promo ends', '优惠结束日期')}</Label>
                <Input
                  id="pm-promo-end"
                  variant="compact"
                  type="date"
                  value={form.promo_end}
                  onChange={e => setForm({ ...form, promo_end: e.target.value })}
                />
                <span className="text-[12px] text-text-tertiary">
                  {t('The promo runs to the end of this day. Leave empty for no end date.', '优惠持续到当天结束。留空表示无结束日期。')}
                </span>
              </div>
              {editingProduct && editingProduct.promo_price !== null && editingProduct.promo_price !== undefined && (
                <p className="text-[12px] text-rose-muted">
                  {editingProduct.promo_limit
                    ? t(`${editingProduct.promo_sold ?? 0} of ${editingProduct.promo_limit} sold at the promo price.`,
                        `已以优惠价售出 ${editingProduct.promo_sold ?? 0} / ${editingProduct.promo_limit} 件。`)
                    : t(`${editingProduct.promo_sold ?? 0} sold at the promo price.`,
                        `已以优惠价售出 ${editingProduct.promo_sold ?? 0} 件。`)}
                  {' '}
                  {t('Changing the promo price starts the count again.', '更改优惠价将重新计数。')}
                </p>
              )}
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
