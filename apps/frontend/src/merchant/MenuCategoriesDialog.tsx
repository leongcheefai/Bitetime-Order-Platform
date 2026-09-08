import { useState } from 'react'
import { Trash2, Eye, EyeOff, Plus } from 'lucide-react'
import ConfirmDialog from '../components/ConfirmDialog'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Tooltip, TooltipTrigger, TooltipContent } from '../components/ui/tooltip'
import {
  validateMenuCategories, MAX_MENU_CATEGORIES, MENU_CATEGORY_NAME_MAX,
} from '@bitetime/shared'
import type { MenuCategory, CategoryConfigError } from '@bitetime/shared'

/**
 * The merchant arranging their menu into sections (ADR 0013).
 *
 * Lives in ProductsManager rather than Shop Settings even though the list is stored on the
 * merchant row: categories are menu *design*, and the merchant is already looking at the menu.
 * ADR 0008 rejected a separate options screen and a top-level Options tab on the same reasoning.
 *
 * ARRAY ORDER IS DISPLAY ORDER, so the ORDER of this list is a real decision — but it is not made
 * here. The merchant drags it on the Storefront tab, where they can see the menu they are
 * arranging (spec 2026-08-17). This dialog names, hides and deletes; the Storefront tab orders.
 * Two surfaces writing the same array would be two places to check when the order looks wrong.
 *
 * The Storefront tab hosts its own instance and seeds it from its DRAFT, so a rename made after a
 * drag saves the dragged order rather than writing the stored order back over it.
 *
 * The validation shown is `validateMenuCategories`, the SAME function the write endpoint refuses
 * on. ADR 0013 traded away every check constraint for a write path that already existed, so that
 * function is the only thing standing between a merchant and two headings reading "Cakes" —
 * showing its verdict here means they meet it while still looking at the form, not as a 400.
 *
 * The whole draft is saved by ONE `PATCH /api/merchants/:id`. There is no per-row save, so a
 * cancel really is a cancel and a merchant never leaves half a rearrangement behind.
 */

/** Ids are opaque and never rendered — a rename must not move a product, so it must not move. */
export const blankCategory = (): MenuCategory =>
  ({ id: crypto.randomUUID(), name: '', active: true })

export function categoryProblem(
  bad: CategoryConfigError,
  t: (en: string, zh: string) => string,
): string {
  switch (bad) {
    case 'blank_name':
      return t('Give every category a name.', '请为每个分类填写名称。')
    case 'name_too_long':
      return t(`A category name can be at most ${MENU_CATEGORY_NAME_MAX} characters.`,
               `分类名称最多 ${MENU_CATEGORY_NAME_MAX} 个字符。`)
    case 'duplicate_category_name':
      return t('Two categories have the same name. Customers would see the same heading twice.',
               '有两个分类名称相同，顾客会看到两个一样的标题。')
    case 'too_many_categories':
      return t(`A shop can have at most ${MAX_MENU_CATEGORIES} categories.`,
               `每家店最多 ${MAX_MENU_CATEGORIES} 个分类。`)
    default:
      return t('Something in this list is not valid.', '此列表中有内容无效。')
  }
}

export default function MenuCategoriesDialog({
  open, onOpenChange, value, counts, saving, onSave, t,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: MenuCategory[]
  /** How many products sit in each category, so a delete can say what it costs. */
  counts: Record<string, number>
  saving: boolean
  /** Resolves true when the list was written; the dialog stays open on a refusal. */
  onSave: (next: MenuCategory[]) => Promise<boolean>
  t: (en: string, zh: string) => string
}) {
  const [draft, setDraft] = useState<MenuCategory[]>(value)
  const [msg, setMsg] = useState('')
  // The row a Delete is asking about. Held here rather than in the row so the confirm can quote
  // the name and the count after the row itself is gone from the draft.
  const [pendingDelete, setPendingDelete] = useState<MenuCategory | null>(null)

  // Reseed each time it opens: the dialog holds a DRAFT of the stored list, and a cancel must not
  // leave the next open showing the abandoned edits.
  //
  // Adjusted DURING RENDER rather than in an effect — the pattern React documents for state
  // derived from a prop change. An effect here would set state after paint (a wasted render, and
  // one frame of the stale draft on screen) and the compiler's lint rejects it outright.
  const [seededOpen, setSeededOpen] = useState(open)
  if (open !== seededOpen) {
    setSeededOpen(open)
    if (open) { setDraft(value); setMsg('') }
  }

  const patch = (i: number, over: Partial<MenuCategory>) =>
    setDraft(draft.map((c, j) => (j === i ? { ...c, ...over } : c)))

  // `name_zh` is DROPPED when cleared rather than stored as '' — absent is the "no Chinese name"
  // state the validator accepts, and an empty string is a blank name it refuses.
  const patchZh = (i: number, zh: string) =>
    setDraft(draft.map((c, j) => {
      if (j !== i) return c
      const { name_zh: _drop, ...rest } = c
      return zh.trim() === '' ? rest : { ...rest, name_zh: zh }
    }))

  async function save() {
    // Trim on the way out, not on every keystroke — trimming as the merchant types eats the
    // space they are about to put between two words.
    const trimmed = draft.map(c => ({
      ...c,
      name: c.name.trim(),
      ...(c.name_zh !== undefined ? { name_zh: c.name_zh.trim() } : {}),
    }))
    const bad = validateMenuCategories(trimmed)
    if (bad) { setMsg(categoryProblem(bad, t)); return }
    setMsg('')
    if (await onSave(trimmed)) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!saving) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t('Menu categories', '菜单分类')}</DialogTitle>
        </DialogHeader>

        <p className="text-[12px] text-muted-foreground leading-[1.6]">
          {t('Customers see these as headings on your storefront. Drag them into order on the Storefront tab. Products you have not put in a category are listed last, without a heading.',
             '顾客会在店面看到这些标题。请在“店面”页拖动排序。未归入分类的产品会排在最后，且不带标题。')}
        </p>

        <div className="flex flex-col gap-2 mt-3 max-h-[46vh] overflow-y-auto">
          {draft.length === 0 && (
            <p className="text-[13px] text-muted-foreground italic py-4 text-center">
              {t('No categories yet. Your menu is one list.', '暂无分类，您的菜单是一个列表。')}
            </p>
          )}
          {draft.map((c, i) => (
            <div key={c.id} className="flex items-center gap-2 rounded-lg border-[0.5px] border-border p-2">
              <div className="flex flex-col gap-1 min-w-0 flex-1">
                <Input
                  value={c.name}
                  maxLength={MENU_CATEGORY_NAME_MAX}
                  onChange={e => patch(i, { name: e.target.value })}
                  // `e.g. …`, not a bare noun. "Beverage" alone read as a value already typed in
                  // — two empty rows looked like two saved categories with the same name — and
                  // it was English on a Chinese dialog besides. The idiom the rest of the app
                  // uses for an example is `e.g. X` / `如：X`.
                  placeholder={t('e.g. Beverage', '如：饮料')}
                  aria-label={t('Category name', '分类名称')}
                />
                <Input
                  value={c.name_zh ?? ''}
                  maxLength={MENU_CATEGORY_NAME_MAX}
                  onChange={e => patchZh(i, e.target.value)}
                  placeholder={t('Chinese name (optional)', '中文名称（可选）')}
                  // Descriptive rather than an example, and deliberately unlike the field above:
                  // this one is optional, and naming that is worth more than showing a specimen.
                  aria-label={t('Category name in Chinese', '分类中文名称')}
                />
              </div>
              <div className="flex flex-col gap-1">
                <div className="flex gap-1">
                  {/* Hiding a category hides its HEADING. Its products keep selling, listed with
                      the uncategorized ones — a merchant tidying their menu must never take
                      items off sale without being told. */}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button" variant="ghost" size="none"
                          className="size-8 rounded-lg cursor-pointer"
                          onClick={() => patch(i, { active: !c.active })}
                          aria-label={c.active ? t('Hide category', '隐藏分类') : t('Show category', '显示分类')}
                        />
                      }
                    >
                      {c.active ? <Eye className="size-4" /> : <EyeOff className="size-4 text-muted-foreground" />}
                    </TooltipTrigger>
                    <TooltipContent>
                      {c.active
                        ? t('Shown on your storefront', '显示在店面')
                        : t('Hidden — its products are still on sale, listed without a heading',
                            '已隐藏 — 其产品仍在售，只是不带标题')}
                    </TooltipContent>
                  </Tooltip>
                  <Button
                    type="button" variant="ghost" size="none"
                    className="size-8 rounded-lg cursor-pointer text-muted-foreground hover:text-foreground"
                    onClick={() => setPendingDelete(c)}
                    aria-label={t('Delete category', '删除分类')}
                  ><Trash2 className="size-4" /></Button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <Button
          type="button" variant="soft" size="none"
          className="mt-3 self-start rounded-lg py-[6px] px-[12px] text-[13px]"
          disabled={draft.length >= MAX_MENU_CATEGORIES}
          onClick={() => setDraft([...draft, blankCategory()])}
        >
          <Plus className="size-4 mr-1" />
          {t('Add category', '添加分类')}
        </Button>

        {msg && <p role="alert" className="text-[12px] text-danger-fg mt-3">{msg}</p>}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('Cancel', '取消')}
          </Button>
          <Button type="button" onClick={save} disabled={saving}>
            {saving ? t('Saving…', '保存中…') : t('Save categories', '保存分类')}
          </Button>
        </DialogFooter>

        {/* Deleting takes nothing with it: the products keep their now-dangling id, which the
            storefront reads as uncategorized, and they carry on selling in the trailing block.
            The count is the whole point of this confirm — it is the one consequence a merchant
            cannot see from the dialog. */}
        <ConfirmDialog
          className="z-modal-popover"
          open={!!pendingDelete}
          onOpenChange={o => { if (!o) setPendingDelete(null) }}
          title={t('Delete this category?', '删除此分类？')}
          body={
            <>
              <p className="text-[13px] text-muted-foreground">
                {t(`"${pendingDelete?.name || t('Untitled', '未命名')}" will be removed from your menu.`,
                   `“${pendingDelete?.name || t('Untitled', '未命名')}”将从菜单中移除。`)}
              </p>
              <p className="text-[13px] text-muted-foreground mt-2">
                {(counts[pendingDelete?.id ?? ''] ?? 0) > 0
                  ? t(`${counts[pendingDelete!.id]} product(s) will stay on sale, listed without a heading.`,
                      `${counts[pendingDelete!.id]} 件产品仍在售，只是不带标题。`)
                  : t('No products are in it.', '此分类下没有产品。')}
              </p>
            </>
          }
          confirmLabel={t('Delete', '删除')}
          onConfirm={() => {
            setDraft(draft.filter(c => c.id !== pendingDelete?.id))
            setPendingDelete(null)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
