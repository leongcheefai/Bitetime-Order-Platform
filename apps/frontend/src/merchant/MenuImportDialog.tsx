// Menu import review (tasks/prd-ai-menu-import.md).
//
// The machine reads; the merchant decides. Nothing here saves until the merchant presses the
// button, and the drafts go out through `upsertProduct` — the same call the add-product form
// makes — so every rule that already applies to a product applies to an imported one.
//
// The screen is built around ONE job: checking a price against the photograph. That is why the
// photo stays on screen beside the rows rather than behind a preview toggle, and why a price the
// reader could not parse arrives as an empty required field rather than a 0 the merchant has to
// notice among forty rows.
import { useRef, useState } from 'react'
import { Loader2, Upload, ZoomIn } from 'lucide-react'
import { toast } from 'sonner'
import { importMenu, upsertProduct, updateMerchantConfig } from '../store'
import { buildRows, newCategoryLabels, norm, type Row } from './menuImportRows'
import { currencyDef } from '../currency'
import { coerceQuantity } from '../productUnit'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Checkbox } from '../components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { MAX_MENU_CATEGORIES } from '@bitetime/shared'
import type { MenuCategory } from '@bitetime/shared'

/** Mirrors the backend's own cap (MAX_MENU_IMAGE_BYTES) so an oversized file is refused here. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ACCEPTED = ['image/jpeg', 'image/png'] as const

/**
 * Marks a Category dropdown choice as a section that does not exist yet.
 *
 * Safe against collision with a real choice: an existing category's value is its uuid and "no
 * category" is ''.
 */
const NEW_PREFIX = 'new:'
const newValue = (label: string) => `${NEW_PREFIX}${norm(label)}`

/** Strips the `data:image/jpeg;base64,` prefix a FileReader produces. */
function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('read_failed'))
    reader.readAsDataURL(file)
  })
}

export default function MenuImportDialog({
  open, onOpenChange, merchantId, currency, categories, unitItems, t, onSaved, onCategoriesChanged,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  merchantId: string
  currency?: string
  categories: MenuCategory[]
  /** The product form's own unit list, passed in so the two can never offer different units. */
  unitItems: { value: string; label: string }[]
  t: (en: string, zh: string) => string
  onSaved: () => void | Promise<void>
  onCategoriesChanged: () => void | Promise<void>
}) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string>('')
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [msg, setMsg] = useState('')
  const [zoom, setZoom] = useState(false)
  // Fit to the screen first, actual size on the next click. A menu board shot from two metres away
  // is unreadable at either one alone: fitted it is too small, and at full size the merchant has
  // lost the page before they find the row they are checking.
  const [actualSize, setActualSize] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const symbol = currencyDef(currency).symbol

  const chosen = rows?.filter(r => r.include) ?? []
  // A price the reader could not read is an empty required field. Saving past one would put a
  // product priced 0 on the storefront, which is the failure this whole screen exists to prevent.
  const unpriced = chosen.filter(r => r.price === null || Number.isNaN(r.price))
  // Computed plainly rather than memoised: `chosen` is rebuilt on every render, so a `useMemo`
  // keyed on it would recompute every render anyway while reading as though it did not. The list
  // is at most a few dozen rows.
  //
  // `offered` is every heading the menu printed that the shop lacks — the panel above the rows.
  // `creating` is the subset the merchant has left ticked, which is what save actually writes.
  const offered = rows ? newCategoryLabels(rows, categories) : []
  // Ticked in the panel, and therefore choosable in every row's Category dropdown. Blind to
  // `include` on purpose: unticking the last product in a section must not make the section
  // vanish from the panel, or the merchant cannot tick a product back into it.
  const queued = offered.filter(l => rows?.some(r => norm(r.newCategory) === norm(l)))
  // What save actually creates — the ticked sections that still hold a product to file.
  const creating = [...new Set(chosen.filter(r => r.newCategory).map(r => r.newCategory))]
  const overCategoryCap = categories.length + creating.length > MAX_MENU_CATEGORIES

  const categoryItems = [
    { value: '', label: t('No category', '不分类') },
    ...categories.map(c => ({ value: c.id, label: c.name })),
    ...queued.map(l => ({ value: newValue(l), label: t(`${l} (new)`, `${l}（新）`) })),
  ]

  /** A dropdown choice back into the row's two mutually exclusive category fields. */
  function categoryPatch(v: string | null): Partial<Row> {
    const value = v ?? ''
    if (!value.startsWith(NEW_PREFIX)) return { category_id: value, newCategory: '' }
    return { category_id: '', newCategory: queued.find(l => newValue(l) === value) ?? '' }
  }

  function reset() {
    setFile(null); setPreview(''); setRows(null); setMsg(''); setReading(false); setSaving(false)
    setZoom(false); setActualSize(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  function close(next: boolean) {
    // Cancelling discards every draft. Nothing was written, so there is nothing to undo.
    if (!next) reset()
    onOpenChange(next)
  }

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0]
    if (!picked) return
    setMsg(''); setRows(null); setZoom(false); setActualSize(false)
    if (!(ACCEPTED as readonly string[]).includes(picked.type)) {
      setMsg(t('Choose a JPG or PNG photo.', '请选择 JPG 或 PNG 照片。'))
      return
    }
    if (picked.size > MAX_IMAGE_BYTES) {
      setMsg(t('That photo is larger than 5MB. Take it again at a smaller size.', '照片超过 5MB。请用较小的尺寸重新拍摄。'))
      return
    }
    setFile(picked)
    setPreview(await readAsDataUrl(picked))
  }

  async function read() {
    if (!file || !preview) return
    setReading(true); setMsg('')
    const r = await importMenu(merchantId, base64Of(preview), file.type as 'image/jpeg' | 'image/png')
    setReading(false)
    if (!r.ok) {
      // Each refusal says something different, and a merchant can act on the difference.
      const byCode: Record<string, string> = {
        menu_import_unavailable: t('Menu reading is not switched on for this platform yet.', '本平台尚未开启菜单识别。'),
        daily_limit_reached: t('You have reached today’s limit of 20 menu reads.', '您已达到今天 20 次菜单识别的上限。'),
        // A different message from the daily one on purpose. "Come back tomorrow" and "come back
        // next month" are not the same news, and a merchant who reads the wrong one either waits
        // a day for nothing or gives up on a feature that returns on the 1st.
        //
        // It names the MONTHLY figure and not the one-time setup grant, matching what the backend
        // sends: by the time a merchant sees this the grant is gone for good, and promising its
        // return would be a lie. Five a month is what actually comes back.
        monthly_limit_reached: t('You have reached this month’s limit of 5 menu reads. It resets on the 1st of next month.', '您已达到本月 5 次菜单识别的上限。下月 1 日重置。'),
        could_not_read_menu: t('The menu could not be read. Try a sharper photo, or one page at a time.', '无法识别该菜单。请拍得更清晰，或每次只拍一页。'),
        image_too_large: t('That photo is larger than 5MB.', '照片超过 5MB。'),
        shop_not_active: t('Your shop is not active, so menu reading is switched off.', '您的店铺未启用，菜单识别已关闭。'),
      }
      setMsg(byCode[r.error.code ?? ''] ?? r.error.message)
      return
    }
    setRows(buildRows(r.data.items, categories))
  }

  function edit(key: string, patch: Partial<Row>) {
    setRows(prev => prev?.map(r => (r.key === key ? { ...r, ...patch } : r)) ?? prev)
  }

  /**
   * Ticks or unticks one new section for the whole import.
   *
   * Untick empties `newCategory` on every row pointing at it, including rows the merchant moved
   * there by hand: the section will not exist, so there is nothing left for them to point at. They
   * become uncategorized, which the row's own dropdown then says plainly.
   */
  function toggleNewCategory(label: string, on: boolean) {
    const key = norm(label)
    setRows(prev => prev?.map(r => {
      if (on) {
        // Back to the heading the menu printed for it. A row the merchant moved elsewhere keeps
        // where they put it — this tick restores a section, it does not re-file their work.
        return norm(r.category_label ?? '') === key && !r.category_id && !r.newCategory
          ? { ...r, newCategory: label }
          : r
      }
      return norm(r.newCategory) === key ? { ...r, newCategory: '' } : r
    }) ?? prev)
  }

  async function save() {
    if (!rows) return
    setSaving(true); setMsg('')

    // Create the new sections FIRST, in one write, so every product that wants one has an id to
    // point at. `updateMerchantConfig` replaces the whole list, so it is built from the current
    // one rather than appended to blindly.
    const labelToId = new Map<string, string>()
    if (creating.length > 0) {
      const created: MenuCategory[] = creating.map(name => ({
        id: crypto.randomUUID(), name, active: true,
      }))
      for (const c of created) labelToId.set(norm(c.name), c.id)
      const r = await updateMerchantConfig(merchantId, { product_categories: [...categories, ...created] })
      if (!r.ok) {
        setSaving(false)
        setMsg(t('Could not create the new categories.', '无法创建新分类。'))
        return
      }
      await onCategoriesChanged()
    }

    let saved = 0
    const failed: string[] = []
    for (const row of rows.filter(r => r.include)) {
      const categoryId = row.newCategory
        ? labelToId.get(norm(row.newCategory)) ?? null
        : row.category_id || null
      const r = await upsertProduct({
        id: crypto.randomUUID(),
        merchant_id: merchantId,
        name: row.name,
        name_zh: row.name_zh ?? '',
        descr: row.description ?? '',
        price: Number(row.price) || 0,
        unit: row.unit ?? 'pcs',
        unit_quantity: coerceQuantity(row.unit_quantity ?? 1),
        active: true,
        category_id: categoryId,
        image_urls: [],
        option_groups: [],
      })
      if (r.ok) saved++
      else failed.push(row.name)
    }

    setSaving(false)
    await onSaved()

    if (failed.length === 0) {
      toast.success(t(`Added ${saved} products`, `已添加 ${saved} 个产品`))
      reset()
      onOpenChange(false)
      return
    }
    // Partial success is reported as partial. A toast saying "done" over three silently dropped
    // products is how a merchant ships an incomplete menu without knowing.
    toast.error(t(
      `Added ${saved}. These could not be saved: ${failed.join(', ')}`,
      `已添加 ${saved} 个。以下未能保存：${failed.join('、')}`,
    ))
    setRows(prev => prev?.filter(r => !r.include || failed.includes(r.name)) ?? prev)
  }

  return (
    <Dialog open={open} onOpenChange={close} disablePointerDismissal>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('Import from a photo', '从照片导入')}</DialogTitle>
        </DialogHeader>

        <p className="text-[13px] text-muted-foreground -mt-1 mb-3">
          {t(
            'Take a photo of your menu. We read it into products for you to check. Nothing is saved until you press Add.',
            '拍一张菜单照片。我们会读成产品供您核对。按“添加”之前不会保存任何内容。',
          )}
        </p>

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png"
            onChange={pick}
            className="hidden"
            id="menu-import-file"
          />
          <Button
            type="button" variant="soft" size="none"
            className="rounded-lg py-[6px] px-[14px] text-[13px]"
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="size-4 mr-1" />
            {file ? t('Choose another photo', '换一张照片') : t('Choose a photo', '选择照片')}
          </Button>
          {file && !rows && (
            <Button
              type="button" size="none"
              className="rounded-lg py-[6px] px-[14px] text-[13px]"
              onClick={read}
              disabled={reading}
            >
              {reading && <Loader2 className="size-4 mr-1 animate-spin" />}
              {reading ? t('Reading the menu…', '正在识别菜单…') : t('Read this menu', '识别这张菜单')}
            </Button>
          )}
        </div>

        {msg && <p role="alert" className="text-[13px] text-danger-fg mb-3">{msg}</p>}

        {preview && (
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
            {/* Stays on screen while the rows are corrected: checking a price against the photo
                is the merchant's whole job here, and making them scroll away to do it is how a
                misread price gets saved. */}
            <div className="md:sticky md:top-0 md:self-start">
              {/* Clickable, because the photo beside the rows is capped at 60vh and a price
                  printed small on a menu board does not survive that. */}
              <button
                type="button"
                onClick={() => { setActualSize(false); setZoom(true) }}
                aria-label={t('Enlarge the menu photo', '放大菜单照片')}
                className="group relative block w-full cursor-zoom-in rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <img
                  src={preview}
                  alt={t('The menu photo you chose', '您选择的菜单照片')}
                  className="w-full rounded-xl border-[0.5px] border-border object-contain max-h-[60vh]"
                />
                <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-lg bg-card/90 px-2 py-1 text-[11px] text-muted-foreground shadow-elev-1 group-hover:text-foreground">
                  <ZoomIn className="size-3.5" />
                  {t('Enlarge', '放大')}
                </span>
              </button>
            </div>

            <div>
              {rows === null ? (
                <p className="text-[13px] text-muted-foreground">
                  {reading
                    ? t('Reading the menu. This takes a few seconds.', '正在识别菜单，需要几秒钟。')
                    : t('Press “Read this menu” to start.', '请按“识别这张菜单”开始。')}
                </p>
              ) : rows.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  {t(
                    'No menu items were found in that photo. Try a sharper photo, or one page at a time.',
                    '这张照片中没有找到菜单项目。请拍得更清晰，或每次只拍一页。',
                  )}
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {/* One panel, not one tick per row: the same heading over eight items is ONE
                      decision, and repeating it eight times reads as eight sections. Every row
                      then says which section it lands in through its own Category dropdown, which
                      is where a merchant already looks for that. */}
                  {offered.length > 0 && (
                    <div className="rounded-xl border-[0.5px] border-border bg-muted/40 p-3">
                      <p className="text-[12px] font-medium text-foreground">
                        {t('New categories from this menu', '来自这张菜单的新分类')}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {t(
                          'We create the ticked ones when you press Add, and file the products under them.',
                          '按“添加”时，我们会创建已勾选的分类，并把产品归入其中。',
                        )}
                      </p>
                      <div className="flex flex-wrap gap-x-4 gap-y-2 mt-2">
                        {offered.map(label => {
                          const on = queued.some(c => norm(c) === norm(label))
                          // Counted off the PRINTED heading, not off where the rows currently sit:
                          // this number says how big the section is on the menu, and it must not
                          // fall to zero the moment the merchant unticks it.
                          const count = rows.filter(r => norm(r.category_label ?? '') === norm(label)).length
                          return (
                            <label
                              key={label}
                              className="flex items-center gap-2 text-[12px] text-foreground cursor-pointer"
                            >
                              <Checkbox
                                checked={on}
                                onCheckedChange={v => toggleNewCategory(label, v === true)}
                              />
                              <span>
                                {label}
                                <span className="text-muted-foreground">
                                  {' '}({t(`${count} products`, `${count} 个产品`)})
                                </span>
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {rows.map(row => {
                    const priceMissing = row.include && (row.price === null || Number.isNaN(row.price))
                    return (
                      <div
                        key={row.key}
                        className={`rounded-xl border-[0.5px] border-border p-3 ${row.include ? '' : 'opacity-50'}`}
                      >
                        <div className="flex items-start gap-2 mb-2">
                          <Checkbox
                            checked={row.include}
                            onCheckedChange={v => edit(row.key, { include: v === true })}
                            aria-label={t(`Include ${row.name}`, `包含 ${row.name}`)}
                          />
                          <Input
                            value={row.name}
                            onChange={e => edit(row.key, { name: e.target.value })}
                            className="h-8 text-[13px]"
                            aria-label={t('Product name', '产品名称')}
                          />
                          <Input
                            value={row.name_zh ?? ''}
                            onChange={e => edit(row.key, { name_zh: e.target.value })}
                            placeholder={t('Chinese name', '中文名称')}
                            className="h-8 text-[13px]"
                            aria-label={t('Chinese name', '中文名称')}
                          />
                        </div>

                        <div className="grid gap-2 sm:grid-cols-[auto_1fr_1fr] items-end pl-6">
                          <div>
                            <Label className="text-[11px] text-muted-foreground">
                              {t('Price', '价格')} ({symbol})
                            </Label>
                            <Input
                              type="number" step="0.01" min="0"
                              value={row.price === null ? '' : String(row.price)}
                              onChange={e => edit(row.key, {
                                price: e.target.value === '' ? null : Number(e.target.value),
                              })}
                              className={`h-8 w-28 text-[13px] ${priceMissing ? 'border-destructive' : ''}`}
                              aria-label={t('Price', '价格')}
                            />
                          </div>
                          <div>
                            <Label htmlFor={`menu-import-${row.key}-unit`} className="text-[11px] text-muted-foreground">{t('Unit', '单位')}</Label>
                            <Select
                              value={row.unit ?? 'pcs'}
                              onValueChange={v => edit(row.key, { unit: v ?? 'pcs' })}
                              items={unitItems}
                            >
                              <SelectTrigger id={`menu-import-${row.key}-unit`} className="h-8 text-[13px]"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {unitItems.map(u => (
                                  <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label htmlFor={`menu-import-${row.key}-category`} className="text-[11px] text-muted-foreground">{t('Category', '分类')}</Label>
                            {/* The sections the panel above will create are ordinary choices here,
                                marked "new". A row filed under one has to SAY so: a dropdown
                                reading "No category" beside a panel that creates the section is
                                two answers to one question. */}
                            <Select
                              value={row.newCategory ? newValue(row.newCategory) : row.category_id}
                              onValueChange={v => edit(row.key, categoryPatch(v))}
                              items={categoryItems}
                            >
                              <SelectTrigger id={`menu-import-${row.key}-category`} className="h-8 text-[13px]"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="">{t('No category', '不分类')}</SelectItem>
                                {categories.map(c => (
                                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                                ))}
                                {queued.map(label => (
                                  <SelectItem key={newValue(label)} value={newValue(label)}>
                                    {t(`${label} (new)`, `${label}（新）`)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        {/* The printed price, kept beside the parsed one. It is what the merchant
                            checks against, and it is the only thing on screen that came off the
                            menu untouched. */}
                        {row.price_text && (
                          <p className="text-[11px] text-muted-foreground mt-1 pl-6">
                            {t('Printed on the menu:', '菜单上印的：')} <span>{row.price_text}</span>
                            {priceMissing && (
                              <span className="text-danger-fg">
                                {' · '}{t('Type the price yourself.', '请自行输入价格。')}
                              </span>
                            )}
                          </p>
                        )}

                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {rows && rows.length > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-3 mt-4 pt-3 border-t-[0.5px] border-border">
            {unpriced.length > 0 && (
              <p className="text-[12px] text-danger-fg mr-auto">
                {t(
                  `${unpriced.length} of the selected products still need a price.`,
                  `已选产品中有 ${unpriced.length} 个还没有价格。`,
                )}
              </p>
            )}
            {overCategoryCap && (
              <p className="text-[12px] text-danger-fg mr-auto">
                {t(
                  `That is more than ${MAX_MENU_CATEGORIES} categories. Untick some.`,
                  `分类数超过 ${MAX_MENU_CATEGORIES} 个。请取消部分勾选。`,
                )}
              </p>
            )}
            <Button
              type="button" variant="soft" size="none"
              className="rounded-lg py-[6px] px-[14px] text-[13px]"
              onClick={() => close(false)}
              disabled={saving}
            >
              {t('Cancel', '取消')}
            </Button>
            <Button
              type="button" size="none"
              className="rounded-lg py-[6px] px-[14px] text-[13px]"
              onClick={save}
              disabled={saving || chosen.length === 0 || unpriced.length > 0 || overCategoryCap}
            >
              {saving && <Loader2 className="size-4 mr-1 animate-spin" />}
              {t(`Add ${chosen.length} products`, `添加 ${chosen.length} 个产品`)}
            </Button>
          </div>
        )}

        {/* The photo on its own. A second dialog rather than a swap inside this one: the rows keep
            their scroll position, so closing it puts the merchant back on the row they doubted. */}
        <Dialog open={zoom} onOpenChange={setZoom}>
          <DialogContent className="sm:max-w-[min(96vw,72rem)] max-h-[92vh] overflow-auto p-3">
            <DialogTitle className="sr-only">{t('The menu photo you chose', '您选择的菜单照片')}</DialogTitle>
            <button
              type="button"
              onClick={() => setActualSize(v => !v)}
              aria-label={actualSize
                ? t('Fit the photo to the screen', '缩放照片以适合屏幕')
                : t('Show the photo at full size', '按原尺寸显示照片')}
              className={`block ${actualSize ? 'cursor-zoom-out' : 'cursor-zoom-in'}`}
            >
              <img
                src={preview}
                alt={t('The menu photo you chose', '您选择的菜单照片')}
                className={actualSize
                  ? 'max-w-none rounded-lg'
                  : 'w-full max-h-[82vh] object-contain rounded-lg'}
              />
            </button>
            <p className="text-[11px] text-muted-foreground text-center">
              {actualSize
                ? t('Click the photo to fit it to the screen.', '点击照片以适合屏幕。')
                : t('Click the photo to see it at full size.', '点击照片查看原尺寸。')}
            </p>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}
