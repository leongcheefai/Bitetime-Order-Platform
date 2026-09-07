import { useEffect, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { MoreHorizontal, Package, Lock } from 'lucide-react'
import { useSession } from '../SessionContext'
import { toast } from 'sonner'
import { lookupProducts, deleteProduct, deleteProductImages, productImageUrl, updateMerchantConfig } from '../store'
import { firstProductAdded } from './firstProduct'
import { trackEvent } from '../analytics/events'
import { formatUnit, UNITS } from '../productUnit'
import { formatMoney } from '../currency'
import { SkeletonText } from '../components/Loaders'
import ConfirmDialog from '../components/ConfirmDialog'
import { Button } from '../components/ui/button'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '../components/ui/dropdown-menu'
import { DataTable, SortableHeader } from '../components/ui/data-table'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from '../components/ui/empty'
import ProductFormSheet from './ProductFormSheet'
import CopyProductsDialog from './CopyProductsDialog'
import MenuCategoriesDialog from './MenuCategoriesDialog'
import MenuImportDialog from './MenuImportDialog'
import { Tooltip, TooltipTrigger, TooltipContent } from '../components/ui/tooltip'
import { findCategory } from '../menuGroups'
import { menuCategoriesFromRow } from '@bitetime/shared'
import type { MenuCategory } from '@bitetime/shared'

// Handlers + language + currency ride on table.options.meta so the column defs stay
// stable (defined once) and never reset sorting when a row action refetches.
interface ProductTableMeta {
  t: (en: string, zh: string) => string
  lang: string
  currency?: string
  /** The shop's own sections, so the Category column can name one — hidden ones included. */
  categories: MenuCategory[]
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
          loading="lazy"
          decoding="async"
          className="size-11 shrink-0 object-cover rounded-lg border-[0.5px] border-border"
        />
      ) : (
        <div className="size-11 shrink-0 rounded-lg border-[0.5px] border-dashed border-border" aria-hidden />
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
        <div className="text-[14px] font-medium text-foreground">
          {p.name}
          {p.name_zh ? <span className="text-muted-foreground font-normal"> / {p.name_zh}</span> : null}
          {!p.active && <em className="italic text-[12px] text-muted-foreground"> · {t('hidden', '已隐藏')}</em>}
        </div>
      )
    },
  },
  {
    // Which section the product sits in — and, more usefully, which products are still in none.
    // A new product falls to the bottom of the storefront's un-headed trailing block, and this
    // column is where a merchant notices that rather than mistaking it for a save that failed.
    id: 'category',
    // NOT sortable, and that is a deliberate trade rather than an omission. The label a merchant
    // would want to sort on is resolved from the shop's category list, which lives on
    // `table.options.meta` — reachable from a cell, but not from a `sortingFn`. Threading it in
    // would mean rebuilding these column defs whenever the merchant row changes, which is the one
    // thing the stability comment above exists to prevent (it resets the table's sort).
    enableSorting: false,
    header: ({ table }) => (
      <span className="whitespace-nowrap">{(table.options.meta as ProductTableMeta).t('Category', '分类')}</span>
    ),
    cell: ({ row, table }) => {
      const { t, lang, categories } = table.options.meta as ProductTableMeta
      // Hidden categories resolve too: a merchant needs to see where an item is filed even while
      // that section is switched off. Only an id the shop no longer holds reads as unfiled.
      const c = findCategory(categories, row.original.category_id)
      if (!c) return <span className="text-[13px] text-muted-foreground italic">{t('None', '未分类')}</span>
      return (
        <span className="text-[13px] text-muted-foreground whitespace-nowrap">
          {(lang === 'zh' && c.name_zh) || c.name}
          {!c.active && <em className="italic"> · {t('hidden', '已隐藏')}</em>}
        </span>
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
      return <span className="text-[13px] text-muted-foreground whitespace-nowrap">{formatMoney(p.price, currency)} / {formatUnit(p.unit_quantity, p.unit)}</span>
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
                  className="size-9 p-0 rounded-pill cursor-pointer pointer-coarse:size-11 hover:bg-brand-100 hover:text-primary"
                  aria-label={t('Actions', '操作')}
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onEdit(p)}>{t('Edit', '编辑')}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" className="cursor-pointer" onClick={() => meta.onRemove(p)}>{t('Delete', '删除')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )
    },
  },
]

export default function ProductsManager() {
  const { t, lang, merchant, refreshMerchant, role } = useSession()
  const [rows, setRows] = useState<any[] | null>(null)
  // editingProduct = the row the form is open on (null → add mode).
  const [editingProduct, setEditingProduct] = useState<any | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  // One id per opening of the form. It is what tells ProductFormSheet a NEW opening has arrived
  // (the same product twice must still start clean), and in add mode it doubles as the product's
  // id, which is what lets the form upload photos to Storage before the row exists.
  const [formSession, setFormSession] = useState(() => crypto.randomUUID())
  // The shop's menu sections (ADR 0013). Read off the merchant row the session already holds —
  // no request — and written back through `PATCH /api/merchants/:id`, so `refreshMerchant` is
  // what makes a save visible rather than a local copy that could drift from the row.
  const categories = menuCategoriesFromRow(merchant?.product_categories)
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  // Menu import (tasks/prd-ai-menu-import.md). Its own dialog, and deliberately not folded into
  // the add/edit form: that form saves ONE product on submit, and this one proposes many and
  // saves none until asked.
  const [importOpen, setImportOpen] = useState(false)
  // Product copy (CONTEXT.md → Product copy) — superadmin-only, so the state is harmless for a
  // merchant: the button that sets it is never rendered for them.
  const [copyOpen, setCopyOpen] = useState(false)
  const [categoriesSaving, setCategoriesSaving] = useState(false)
  // The row a Delete action is asking about, held here rather than in the column def so the
  // columns stay stable (see ProductTableMeta). null → no confirm open.
  const [pendingDelete, setPendingDelete] = useState<any | null>(null)

  const currency = merchant?.currency

  // Both create paths end here — the add-product form and MenuImportDialog's bulk save (onSaved) —
  // which is what lets ONE check cover both, and lets a fifteen-item menu import report a single
  // first product rather than fifteen.
  //
  // The mount effect below deliberately does NOT go through this function. It must not: on a shop
  // that already has a menu it would read 0 → n and report a first product on every dashboard
  // visit. `rows === null` is the same guard from the other side — it means the count was never
  // known, which is not the same fact as a menu known to be empty.
  async function load() {
    const before = rows
    const r = await lookupProducts(merchant!.id)
    const next = r.ok ? r.data : []
    setRows(next)
    if (before !== null && firstProductAdded(before.length, next.length)) {
      trackEvent('onboarding_step', { step: 'product' })
    }
  }
  useEffect(() => { lookupProducts(merchant!.id).then(r => setRows(r.ok ? r.data : [])) }, [merchant!.id])

  function openAdd() {
    setEditingProduct(null)
    setFormSession(crypto.randomUUID())
    setFormOpen(true)
  }
  function openEdit(p: any) {
    setEditingProduct(p)
    setFormSession(crypto.randomUUID())
    setFormOpen(true)
  }

  // The name to quote back in the delete confirm, in the language being read.
  function productLabel(p: any) {
    return (lang === 'zh' && p.name_zh) ? p.name_zh : p.name
  }
  async function remove(p: any) {
    const r = await deleteProduct(p.id, merchant!.id)
    if (!r.ok) { toast.error(r.error.message || t('Could not delete product', '无法删除产品')); return }
    if (p.image_urls?.length) { try { await deleteProductImages(p.image_urls) } catch { /* best-effort */ } }
    await load(); toast.success(t('Product deleted', '产品已删除'))
  }

  /**
   * Write the whole category list back, in one PATCH.
   *
   * `refreshMerchant` rather than a local copy: this list lives on the merchant row that the
   * session holds and that the storefront reads, so keeping a second copy here would leave the
   * two able to disagree about what the shop's menu looks like.
   */
  async function saveCategories(next: MenuCategory[]): Promise<boolean> {
    setCategoriesSaving(true)
    const r = await updateMerchantConfig(merchant!.id, { product_categories: next })
    setCategoriesSaving(false)
    if (!r.ok) {
      toast.error(r.error.message || t('Could not save categories', '无法保存分类'))
      return false
    }
    await refreshMerchant()
    toast.success(t('Categories saved', '分类已保存'))
    return true
  }

  // How many products each category holds, so the delete confirm can say what it costs. Counted
  // over ALL products, hidden ones included: a merchant deleting a category is told about every
  // row that points at it, not only the ones currently on sale.
  const categoryCounts = (rows ?? []).reduce<Record<string, number>>((acc, p) => {
    if (p.category_id) acc[p.category_id] = (acc[p.category_id] ?? 0) + 1
    return acc
  }, {})

  const meta: ProductTableMeta = {
    t, lang, currency, categories,
    onEdit: openEdit,
    onRemove: setPendingDelete,
  }

  if (!rows) return (
    <div className="bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border">
      <SkeletonText lines={4} />
    </div>
  )

  return (
    <div className="bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border">
      {/* `flex-wrap`, and no `whitespace-nowrap` on the buttons. Three nowrap buttons in a row
          that cannot wrap are wider than this card on a phone, and a block card does not grow to
          fit them — the PAGE does, which is the horizontal scroll that also drags the table's
          right-hand columns off screen. Wrapping keeps them inside the card at any width, and a
          label free to break inside its own button is the backstop for the one case wrapping
          cannot fix: a single button wider than the whole row. */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h3 className="font-heading text-[15px] font-medium text-primary flex items-center gap-2">
          {t('Your products', '您的产品')}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {role === 'superadmin' && (
            <Button
              type="button" variant="soft" size="none"
              className="rounded-lg py-[6px] px-[14px] text-[13px]"
              onClick={() => setCopyOpen(true)}
            >
              {t('Copy from another shop', '从其他店铺复制')}
            </Button>
          )}
          <Button
            type="button" variant="soft" size="none"
            className="rounded-lg py-[6px] px-[14px] text-[13px]"
            onClick={() => setCategoriesOpen(true)}
          >
            {t('Categories', '分类')}
          </Button>
          <Button
            type="button" variant="soft" size="none"
            className="rounded-lg py-[6px] px-[14px] text-[13px]"
            onClick={() => setImportOpen(true)}
          >
            {t('Import from a photo', '从照片导入')}
          </Button>
          <Button data-tour="add-product" type="button" size="none" className="rounded-lg py-[6px] px-[14px] text-[13px]" onClick={openAdd}>
            {t('+ Add product', '+ 添加产品')}
          </Button>
        </div>
      </div>

      <MenuImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        merchantId={merchant!.id}
        currency={currency}
        categories={categories}
        unitItems={UNITS.map(u => ({ value: u.value, label: t(u.en, u.zh) }))}
        t={t}
        onSaved={load}
        onCategoriesChanged={refreshMerchant}
      />

      {role === 'superadmin' && (
        <CopyProductsDialog
          open={copyOpen}
          onOpenChange={setCopyOpen}
          targetMerchantId={merchant!.id}
          targetProducts={rows}
          t={t}
          lang={lang}
          // The copy can append categories too, so the merchant row is refreshed with the list.
          onSaved={async () => { await refreshMerchant(); await load() }}
        />
      )}

      <MenuCategoriesDialog
        open={categoriesOpen}
        onOpenChange={setCategoriesOpen}
        value={categories}
        counts={categoryCounts}
        saving={categoriesSaving}
        onSave={saveCategories}
        t={t}
      />

      {rows.length === 0 ? (
        <Empty className="border-[0.5px] border-dashed border-border bg-background/50">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-brand-100 text-primary">
              <Package />
            </EmptyMedia>
            <EmptyTitle className="text-primary">{t('No products yet', '还没有产品')}</EmptyTitle>
            <EmptyDescription className="text-muted-foreground">
              {t('Add your first product to start taking orders in your storefront.', '添加第一个产品，开始在店面接收订单。')}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            {/* Both offered, with the import first: this is the screen a shop with a printed menu
                and no products is looking at, and typing forty items by hand is where trials
                stall. Adding by hand stays one press away for a shop with three items. */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                type="button" size="none"
                className="rounded-lg py-[6px] px-[14px] text-[13px]"
                onClick={() => setImportOpen(true)}
              >
                {t('Import from a photo', '从照片导入')}
              </Button>
              <Button
                type="button" variant="soft" size="none"
                className="rounded-lg py-[6px] px-[14px] text-[13px]"
                onClick={openAdd}
              >
                {t('+ Add product', '+ 添加产品')}
              </Button>
            </div>
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

      <ProductFormSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        product={editingProduct}
        sessionId={formSession}
        products={rows}
        categories={categories}
        categoriesSaving={categoriesSaving}
        onSaveCategories={saveCategories}
        onSaved={load}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={o => { if (!o) setPendingDelete(null) }}
        title={t('Delete this product?', '删除此产品？')}
        body={
          <p>
            {t(
              `“${pendingDelete ? productLabel(pendingDelete) : ''}” disappears from your storefront and cannot be brought back. Orders already placed keep their record of it.`,
              `“${pendingDelete ? productLabel(pendingDelete) : ''}” 将从店面消失且无法恢复。已下的订单仍保留该记录。`,
            )}
          </p>
        }
        confirmLabel={t('Delete product', '删除产品')}
        onConfirm={async () => { if (pendingDelete) await remove(pendingDelete) }}
      />
    </div>
  )
}
