// One place-picker, used by BOTH sides of distance pricing: the merchant choosing their
// delivery origin in Shop Settings, and the customer choosing their destination at checkout.
//
// One component because the rule is one rule — an address that will be ROUTED must come from a
// selected place, never from typed text. A typed string can be re-resolved differently between
// the quote and the charge, which is precisely the drift the place id exists to remove.
import { useEffect, useRef, useState } from 'react'
import { suggestPlaces, placeDetail, newPlaceSession, type PlaceSuggestion, type PlaceDetail } from '../places'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { cn } from '@/lib/utils'

interface Props {
  id: string
  label: string
  /** What to show in the box — the caller owns it, so a confirmed pick can display its own text. */
  value: string
  placeholder?: string
  disabled?: boolean
  /** Fired only on a real selection. A keystroke NEVER produces one. */
  onPick: (detail: PlaceDetail) => void
  /** Fired on every keystroke, so the caller can clear a stale confirmed pick. */
  onTextChange?: (text: string) => void
  t: (en: string, zh: string) => string
}

const optionId = (id: string, placeId: string) => `${id}-option-${placeId}`

/**
 * A combobox, not a click-only dropdown: at a distance-priced shop, an address that cannot be
 * selected means no delivery order can be placed, so keyboard and screen-reader users need the
 * same path to a pick that a mouse user gets. `aria-activedescendant` tracks the highlighted
 * option without moving DOM focus off the input, which is what keeps typing uninterrupted while
 * arrowing through results.
 */
export default function AddressAutocomplete({ id, label, value, placeholder, disabled, onPick, onTextChange, t }: Props) {
  // The raw fetch result. What's actually shown is derived below — hidden whenever the field is
  // closed or the text has dropped under the 3-char floor — so closing/shrinking never needs an
  // effect to reach back in and clear this synchronously (that cascades a render for no reason).
  const [fetched, setFetched] = useState<PlaceSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // -1 = no option highlighted. Index-based so ArrowUp/Down can move it with plain arithmetic;
  // resolved back to a suggestion (and its stable id) at render and on Enter.
  const [activeIndex, setActiveIndex] = useState(-1)
  // One token per burst of typing, reset after a pick: it is what makes a burst of keystrokes
  // bill as a single lookup.
  const session = useRef(newPlaceSession())
  const listboxId = `${id}-listbox`

  const eligible = open && value.trim().length >= 3
  const suggestions = eligible ? fetched : []

  useEffect(() => {
    if (!eligible) return
    // Debounced: every keystroke that reaches the proxy is a request the platform pays for.
    let live = true
    const timer = setTimeout(async () => {
      const hits = await suggestPlaces(value, session.current)
      if (live) { setFetched(hits); setActiveIndex(-1) }
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [value, eligible])

  async function pick(s: PlaceSuggestion) {
    setBusy(true)
    // The SAME session token as the suggests — that is what closes the billable session.
    const detail = await placeDetail(s.placeId, session.current)
    setBusy(false)
    setOpen(false)
    setFetched([])
    setActiveIndex(-1)
    session.current = newPlaceSession()
    // A details call that failed must NOT be turned into an address: the caller would then hold
    // a place the fee cannot be measured to.
    if (detail) onPick(detail)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (value.trim().length < 3) return // nothing to open or navigate — leave the key alone
      e.preventDefault()
      // Reopens even after Escape closed it: a keyboard user's only way back into a list they
      // dismissed is the same key that first opened one, not more typing.
      setOpen(true)
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setActiveIndex(i => {
        if (suggestions.length === 0) return -1 // list not populated yet (still debouncing)
        if (i === -1) return delta === 1 ? 0 : suggestions.length - 1
        return (i + delta + suggestions.length) % suggestions.length
      })
    } else if (e.key === 'Enter') {
      // Only intercept Enter when it would select a highlighted option — otherwise leave it
      // alone rather than swallow a form submit the caller might depend on.
      if (open && activeIndex >= 0 && suggestions[activeIndex]) {
        e.preventDefault()
        void pick(suggestions[activeIndex])
      }
    } else if (e.key === 'Escape') {
      // Close and drop the highlight; the text and normal typing continue exactly as before.
      setOpen(false)
      setActiveIndex(-1)
    }
  }

  const activeOption = activeIndex >= 0 ? suggestions[activeIndex] : undefined
  const showList = open && suggestions.length > 0

  return (
    <div className="flex flex-col gap-[6px] relative">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeOption ? optionId(id, activeOption.placeId) : undefined}
        value={value}
        disabled={disabled || busy}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={e => { setOpen(true); onTextChange?.(e.target.value) }}
        onKeyDown={onKeyDown}
        // A blur that closes immediately eats the click on a suggestion.
        onBlur={() => setTimeout(() => { setOpen(false); setActiveIndex(-1) }, 150)}
      />
      {showList && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={label}
          className="absolute top-full left-0 right-0 z-20 mt-1 max-h-[240px] overflow-y-auto rounded-xl border-[1.5px] border-rose-border bg-surface-raised shadow-lg"
        >
          {suggestions.map((s, i) => {
            const active = i === activeIndex
            return (
              <li
                key={s.placeId}
                id={optionId(id, s.placeId)}
                role="option"
                aria-selected={active}
                onMouseDown={e => e.preventDefault()}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => void pick(s)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-2 text-[14px] text-ink cursor-pointer',
                  // Highlight is background + weight + a marker glyph, never colour alone.
                  active ? 'bg-oxblood-tint font-medium' : 'hover:bg-oxblood-tint-soft',
                )}
              >
                <span aria-hidden="true" className="w-3 text-oxblood">{active ? '›' : ''}</span>
                {s.text}
              </li>
            )
          })}
        </ul>
      )}
      {/* Announces arrivals for screen-reader users, who cannot see the list render. */}
      <div role="status" aria-live="polite" className="sr-only">
        {busy
          ? t('Looking up that address…', '正在查询地址…')
          : eligible
            ? suggestions.length > 0
              ? t(`${suggestions.length} suggestions available`, `找到 ${suggestions.length} 个建议地址`)
              : t('No suggestions found', '未找到建议地址')
            : ''}
      </div>
      {busy && <p className="text-[12px] text-rose-muted">{t('Looking up that address…', '正在查询地址…')}</p>}
    </div>
  )
}
