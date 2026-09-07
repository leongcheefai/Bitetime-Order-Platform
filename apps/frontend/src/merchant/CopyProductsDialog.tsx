// Product copy (CONTEXT.md → Product copy): the superadmin-only dialog that pulls another shop's
// products INTO the shop whose dashboard is open. Rendered only for a superadmin — the button
// that opens it is role-gated in ProductsManager.
//
// The dialog decides nothing the backend does not re-check; what it does own is the picker's
// defaults (copyPickerRows.ts) — the write path does dumb inserts, so "duplicates start
// unchecked" here is the only thing standing between a re-run and a doubled menu.
import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { copyProducts, fetchAllMerchants, lookupProducts } from '../store'
import { copyPickerRows, filterShops, optionGroupSummary, type CopyPickerRow } from './copyPickerRows'
import { currencyDef } from '../currency'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'

export default function CopyProductsDialog({
  open, onOpenChange, targetMerchantId, targetProducts, t, lang, onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  targetMerchantId: string
  /** The rows ProductsManager already holds — what the badge logic compares names against. */
  targetProducts: any[]
  t: (en: string, zh: string) => string
  lang: 'en' | 'zh'
  onSaved: () => void | Promise<void>
}) {
  const [shops, setShops] = useState<any[] | null>(null)
  const [query, setQuery] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [rows, setRows] = useState<CopyPickerRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [copying, setCopying] = useState(false)
  const [msg, setMsg] = useState('')

  // The shop list is loaded when the dialog opens, not at mount: this component sits on every
  // superadmin visit to any dashboard, and most of those never open it.
  useEffect(() => {
    if (!open || shops !== null) return
    fetchAllMerchants().then(r => {
      if (!r.ok) { setMsg(t('Could not load the shop list', '无法加载店铺列表')); return }
      setShops(r.data.filter(m => m.id !== targetMerchantId))
    })
  }, [open, shops, targetMerchantId, t])

  // A handler, not an effect: picking a shop is the event, and the sequence counter is what keeps
  // a slow response for the previous pick from landing over a newer one.
  const loadSeq = useRef(0)
  async function pickSource(value: string | null) {
    const id = value ?? ''
    setSourceId(id)
    setMsg('')
    setRows(null)
    if (!id) return
    const seq = ++loadSeq.current
    setLoading(true)
    const r = await lookupProducts(id)
    if (seq !== loadSeq.current) return
    setLoading(false)
    if (!r.ok) { setMsg(t('Could not load that shop’s products', '无法加载该店铺的产品')); return }
    setRows(copyPickerRows(r.data, targetProducts))
  }

  function reset() {
    // The bump orphans any in-flight product load, so it cannot land on a reopened dialog.
    loadSeq.current++
    setQuery(''); setSourceId(''); setRows(null); setMsg(''); setLoading(false); setCopying(false)
  }
  function close(v: boolean) {
    if (copying) return
    if (!v) reset()
    onOpenChange(v)
  }

  const source = shops?.find(s => s.id === sourceId)
  const symbol = currencyDef(source?.currency).symbol
  const chosen = rows?.filter(r => r.include) ?? []

  function setInclude(id: string, include: boolean) {
    setRows(prev => prev?.map(r => (r.id === id ? { ...r, include } : r)) ?? prev)
  }
  function setAll(include: boolean) {
    setRows(prev => prev?.map(r => ({ ...r, include })) ?? prev)
  }

  /**
   * The backend's refusal codes, in words. `r.error.message` carries the raw code (api.ts sets
   * message from the body's `error`), so falling back to it would toast literal `copy_failed`.
   */
  function refusalText(code?: string): string {
    switch (code) {
      case 'product_not_in_source':
        return t('The shop list changed — pick the shop again.', '店铺列表已变更，请重新选择店铺。')
      case 'too_many_categories':
        return t('This shop cannot hold that many menu sections.', '本店无法容纳这么多菜单分类。')
      case 'too_many_products':
        return t('Too many products for one copy.', '一次复制的产品太多。')
      default:
        return t('Could not copy the products.', '无法复制产品。')
    }
  }

  async function copy() {
    setCopying(true)
    const r = await copyProducts(sourceId, targetMerchantId, chosen.map(c => c.id))
    setCopying(false)
    if (!r.ok) {
      toast.error(refusalText(r.error.code))
      return
    }
    // A skipped photo is a photo already gone at the source — worth a mention, not a failure.
    toast.success(r.data.skippedImages > 0
      ? t(
          `Copied ${r.data.copied} products (${r.data.skippedImages} missing photos skipped)`,
          `已复制 ${r.data.copied} 个产品（跳过 ${r.data.skippedImages} 张缺失的照片）`,
        )
      : t(`Copied ${r.data.copied} products`, `已复制 ${r.data.copied} 个产品`))
    await onSaved()
    reset()
    onOpenChange(false)
  }

  const label = (r: CopyPickerRow) => (lang === 'zh' && r.name_zh) ? r.name_zh : r.name

  return (
    <Dialog open={open} onOpenChange={close} disablePointerDismissal>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('Copy from another shop', '从其他店铺复制')}</DialogTitle>
        </DialogHeader>

        <p className="text-[13px] text-muted-foreground -mt-1 mb-3">
          {t(
            'Pick a shop, then the products to copy into this one. Sections come along; promos do not.',
            '选择一个店铺，再选择要复制到本店的产品。分类会一并复制；促销不会。',
          )}
        </p>

        {/* A filter input over a plain list, not a dropdown: the platform holds a couple of
            hundred shops, and a search box is the affordance that makes finding one possible. */}
        {source ? (
          <div className="min-w-0 flex items-center justify-between gap-2 mb-3 rounded-lg border-[0.5px] border-border bg-background/50 px-3 py-2">
            {/* min-w-0 TWICE — on this banner and on the name span — and both are load-bearing:
                DialogContent is a grid and the banner is a grid child (min-width:auto), the span
                is a flex child; without either one a long shop name refuses to truncate and
                grows the row past the dialog instead. */}
            <span className="min-w-0 flex-1 text-[13px] truncate">
              {t('Copying from', '复制来源')}: <span className="font-medium">{source.name} ({source.slug})</span>
            </span>
            <Button
              type="button" variant="soft" size="none"
              className="rounded-lg py-1 px-3 text-[12px] shrink-0"
              onClick={() => pickSource('')}
              disabled={copying}
            >
              {t('Change shop', '更换店铺')}
            </Button>
          </div>
        ) : (
          <>
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label={t('Search shops', '搜索店铺')}
              placeholder={t('Search shops by name or slug…', '按名称或网址搜索店铺…')}
              className="mb-2"
              autoFocus
            />
            {shops === null ? (
              <p className="text-[13px] text-muted-foreground mb-3 flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                {t('Loading shops…', '正在加载店铺…')}
              </p>
            ) : (
              <ul className="divide-y divide-border border-[0.5px] border-border rounded-xl mb-3 max-h-56 overflow-y-auto">
                {filterShops(shops, query).map(s => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-[13px] cursor-pointer hover:bg-accent"
                      onClick={() => pickSource(s.id)}
                    >
                      {s.name} <span className="text-muted-foreground">({s.slug})</span>
                    </button>
                  </li>
                ))}
                {filterShops(shops, query).length === 0 && (
                  <li className="px-3 py-2 text-[13px] text-muted-foreground">
                    {t('No shop matches that search.', '没有匹配的店铺。')}
                  </li>
                )}
              </ul>
            )}
          </>
        )}

        {msg && <p className="text-[13px] text-destructive mb-3">{msg}</p>}
        {loading && (
          <p className="text-[13px] text-muted-foreground mb-3 flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            {t('Loading products…', '正在加载产品…')}
          </p>
        )}

        {rows !== null && (rows.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {t('That shop has no products.', '该店铺没有产品。')}
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] text-muted-foreground">
                {t(`${chosen.length} of ${rows.length} selected`, `已选择 ${chosen.length}/${rows.length} 个`)}
              </span>
              <div className="flex gap-2">
                <Button type="button" variant="soft" size="none" className="rounded-lg py-1 px-3 text-[12px]" onClick={() => setAll(true)}>
                  {t('Select all', '全选')}
                </Button>
                <Button type="button" variant="soft" size="none" className="rounded-lg py-1 px-3 text-[12px]" onClick={() => setAll(false)}>
                  {t('Select none', '全不选')}
                </Button>
              </div>
            </div>

            <ul className="divide-y divide-border border-[0.5px] border-border rounded-xl mb-4">
              {rows.map(r => (
                <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                  <Checkbox
                    checked={r.include}
                    onCheckedChange={v => setInclude(r.id, v === true)}
                    aria-label={label(r)}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-[13px]">
                      {label(r)}
                      {!r.active && (
                        <span className="ml-2 text-[11px] text-muted-foreground">{t('Hidden', '已隐藏')}</span>
                      )}
                      {r.duplicate && (
                        <span className="ml-2 text-[11px] rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">
                          {t('Already in shop', '本店已有')}
                        </span>
                      )}
                    </span>
                    {optionGroupSummary(r.option_groups, lang).length > 0 && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {t('Options', '选项')}: {optionGroupSummary(r.option_groups, lang).join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="text-[13px] text-muted-foreground shrink-0">
                    {symbol}{Number(r.price ?? 0).toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>

            <div className="flex justify-end">
              <Button
                type="button" size="none"
                className="rounded-lg py-[6px] px-[14px] text-[13px]"
                onClick={copy}
                disabled={copying || chosen.length === 0}
              >
                {copying && <Loader2 className="size-4 mr-1 animate-spin" />}
                {copying
                  ? t('Copying…', '正在复制…')
                  : t(`Copy ${chosen.length} products`, `复制 ${chosen.length} 个产品`)}
              </Button>
            </div>
          </>
        ))}
      </DialogContent>
    </Dialog>
  )
}
