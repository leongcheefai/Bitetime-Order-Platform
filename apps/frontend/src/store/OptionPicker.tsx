import { useState } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../components/ui/sheet'
import { Button } from '../components/ui/button'
import { validateSelections, picksDelta, snapshotSelections } from '@bitetime/shared'
import type { OptionGroup, Selection } from '@bitetime/shared'
import { formatMoney } from '../currency'
import type { Translate } from '../types'

/**
 * The customer answering a product's questions, for ONE unit of it.
 *
 * A sheet and not an inline expansion on the card: six allocations across N flavours with a
 * running counter is not a card-sized control, and growing the card reflows the whole menu list —
 * on a phone the product they tapped scrolls away. Products that ask nothing never open this;
 * they keep the ±1 stepper, which is one tap and is most shops on the platform.
 *
 * The answer describes one unit and `qty` repeats it (ADR 0009), so this collects a single
 * selection set. Two boxes with different mixes are two trips through here — which is also how a
 * customer thinks about it.
 *
 * WHAT THIS IS NOT: an authority. `validateSelections` gates the Add button so the browser cannot
 * build an order the door will refuse, but the same function runs again on the backend inside the
 * order transaction, against the shop's own rows. A gate in the UI is a courtesy to the customer,
 * never a security boundary.
 */
export interface OptionPickerProps {
  /**
   * The product being answered, or null when the sheet is closed.
   *
   * The Sheet stays MOUNTED and is driven by this going non-null, mirroring `OrderDetailSheet` —
   * Base UI's dialog needs the `open` transition and does not portal a popup that is already open
   * on its first render. The body is keyed on the product id instead, so each product gets fresh
   * state with no effect resetting anything.
   */
  product: { id: string; price: number } | null
  onClose: () => void
  /** Display name of the product, already localised by the caller. */
  productName: string
  currency?: string
  groups: OptionGroup[]
  t: Translate
  /** Localise a group or option name — only the caller knows which language is being read. */
  label: (name: string, nameZh?: string | null) => string
  onAdd: (selections: Selection[]) => void
}

/** How many units this answer allocates across one group. */
const totalFor = (selections: Selection[], groupId: string) =>
  Object.values(selections.find(s => s.groupId === groupId)?.picks ?? {})
    .reduce((a, b) => a + b, 0)

const qtyOf = (selections: Selection[], groupId: string, optionId: string) =>
  selections.find(s => s.groupId === groupId)?.picks[optionId] ?? 0

export function OptionPicker({
  product, onClose, productName, currency, groups, t, label, onAdd,
}: OptionPickerProps) {
  return (
    <Sheet open={product !== null} onOpenChange={open => { if (!open) onClose() }}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{product ? productName : ''}</SheetTitle>
        </SheetHeader>
        {product && (
          <PickerBody
            key={product.id}
            basePrice={product.price}
            currency={currency} groups={groups} t={t} label={label}
            onAdd={selections => { onAdd(selections); onClose() }}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

interface PickerBodyProps {
  basePrice: number
  currency?: string
  groups: OptionGroup[]
  t: Translate
  label: (name: string, nameZh?: string | null) => string
  onAdd: (selections: Selection[]) => void
}

function PickerBody({ basePrice, currency, groups, t, label, onAdd }: PickerBodyProps) {
  // A fresh answer per product, guaranteed by the CALLER mounting this only while a product is
  // being picked and keying it on that product's id — so the state simply does not survive.
  // Resetting in an effect instead would be a synchronous setState on mount, a cascading render,
  // and one more way for a previous product's choices to flash on screen before being cleared.
  const [selections, setSelections] = useState<Selection[]>([])

  // Switched-off groups are not questions — that is what makes the Pro downgrade survivable
  // without any screen asking what tier the shop is on.
  const asked = groups.filter(g => g.active)

  /**
   * Move one option's quantity BY a delta, deriving from the previous state.
   *
   * Not `setQty(..., qty + 1)`: `qty` comes from the render closure, so three quick taps in one
   * React batch all read the same stale value and land as ONE. A customer tapping + six times on
   * a six-muffin box got two — found by running it, not by a test, because the loss only appears
   * when the taps outrun a render.
   *
   * The ceilings are re-checked HERE against `prev` for the same reason: a disabled attribute
   * computed at render time is one frame behind the taps it is meant to stop.
   */
  const bump = (group: OptionGroup, optionId: string, delta: number) => {
    setSelections(prev => {
      const rest = prev.filter(s => s.groupId !== group.id)
      const picks = { ...(prev.find(s => s.groupId === group.id)?.picks ?? {}) }
      const next = (picks[optionId] ?? 0) + delta
      if (delta > 0) {
        if (group.maxPerOption !== null && next > group.maxPerOption) return prev
        const others = Object.entries(picks)
          .reduce((n, [k, v]) => (k === optionId ? n : n + v), 0)
        if (group.maxSelect !== null && others + next > group.maxSelect) return prev
      }
      // A group with nothing picked carries no entry at all, so an untouched optional group never
      // reaches the backend as an empty answer it would have to interpret.
      if (next <= 0) delete picks[optionId]
      else picks[optionId] = next
      return Object.keys(picks).length === 0 ? rest : [...rest, { groupId: group.id, picks }]
    })
  }

  /** Tick / untick, for a group that allows at most one of each choice. */
  const toggle = (group: OptionGroup, optionId: string) => {
    setSelections(prev => {
      const rest = prev.filter(s => s.groupId !== group.id)
      const picks = { ...(prev.find(s => s.groupId === group.id)?.picks ?? {}) }
      if (picks[optionId]) delete picks[optionId]
      else {
        const total = Object.values(picks).reduce((a, b) => a + b, 0)
        if (group.maxSelect !== null && total + 1 > group.maxSelect) return prev
        picks[optionId] = 1
      }
      return Object.keys(picks).length === 0 ? rest : [...rest, { groupId: group.id, picks }]
    })
  }

  /**
   * Pick-one: choosing REPLACES whatever was chosen, rather than adding to it.
   *
   * Re-tapping the already-chosen option clears it — but only when the group is optional
   * (`minSelect === 0`). A required pick-one must always carry a value, so it has no empty state
   * to return to.
   */
  const chooseOnly = (group: OptionGroup, optionId: string) =>
    setSelections(prev => {
      const rest = prev.filter(s => s.groupId !== group.id)
      const already = prev.find(s => s.groupId === group.id)?.picks[optionId]
      if (already && group.minSelect === 0) return rest
      return [...rest, { groupId: group.id, picks: { [optionId]: 1 } }]
    })

  const problem = validateSelections(asked, selections)
  const delta = picksDelta(snapshotSelections(asked, selections))

  return (
    <div className="px-4 pb-4 flex flex-col gap-5">
          {asked.map(group => {
            const chosen = totalFor(selections, group.id)
            const isPickOne = group.maxSelect === 1 && group.maxPerOption === 1
            const allocates = group.maxPerOption !== 1
            return (
              <div key={group.id} className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[14px] font-medium text-foreground">
                    {label(group.name, group.name_zh)}
                    {group.minSelect > 0 && <span className="text-primary"> *</span>}
                  </span>
                  {/* The running count is the whole affordance of a mix-and-match box: without it
                      the customer cannot tell how far off six they are until Add stays disabled. */}
                  {group.maxSelect !== null && group.maxSelect > 1 && (
                    <span className="text-[12px] text-muted-foreground" aria-live="polite">
                      {t(`${chosen} of ${group.maxSelect} chosen`, `已选 ${chosen} / ${group.maxSelect}`)}
                    </span>
                  )}
                </div>

                {group.options.filter(o => o.active).map(option => {
                  const qty = qtyOf(selections, group.id, option.id)
                  const atGroupCap = group.maxSelect !== null && chosen >= group.maxSelect
                  const atOptionCap = group.maxPerOption !== null && qty >= group.maxPerOption
                  return (
                    <div key={option.id} className="flex items-center justify-between gap-3">
                      <span className="text-[13px] text-foreground">
                        {label(option.name, option.name_zh)}
                        {option.delta > 0 && (
                          <span className="text-[12px] text-muted-foreground">
                            {' '}+{formatMoney(option.delta, currency)}
                          </span>
                        )}
                      </span>

                      {allocates ? (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="soft" size="iconRound" className="text-[16px]"
                            disabled={qty === 0}
                            onClick={() => bump(group, option.id, -1)}
                            aria-label={`${t('Decrease', '减少')} ${label(option.name, option.name_zh)}`}
                          >−</Button>
                          <span className="text-[13px] min-w-[20px] text-center" aria-live="polite">{qty}</span>
                          <Button
                            variant="soft" size="iconRound" className="text-[16px]"
                            disabled={atGroupCap || atOptionCap}
                            onClick={() => bump(group, option.id, 1)}
                            aria-label={`${t('Increase', '增加')} ${label(option.name, option.name_zh)}`}
                          >+</Button>
                        </div>
                      ) : (
                        <Button
                          variant={qty > 0 ? 'default' : 'soft'}
                          size="sm"
                          disabled={!isPickOne && qty === 0 && atGroupCap}
                          onClick={() => (isPickOne
                            ? chooseOnly(group, option.id)
                            : toggle(group, option.id))}
                          aria-pressed={qty > 0}
                        >
                          {qty > 0 ? t('Chosen', '已选') : t('Choose', '选择')}
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}

          <Button
            className="w-full"
            disabled={problem !== null}
        onClick={() => onAdd(selections)}
      >
        {t(
          `Add — ${formatMoney(basePrice + delta, currency)}`,
          `加入购物车 — ${formatMoney(basePrice + delta, currency)}`,
        )}
      </Button>
    </div>
  )
}
