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
  // The query that `fetched` is the answer to. State (not a ref) because the live region below
  // reads it during render, and tracked explicitly rather than inferred from `fetched.length` so
  // a reopen with the same text can tell "these results still apply" from "no fetch has run yet"
  // — see the debounce effect and the live region below.
  const [fetchedFor, setFetchedFor] = useState<string | null>(null)
  // Bumped once a composed IME entry commits, to nudge the debounce effect below to run even
  // though `value` itself didn't change on this render (see the composition handlers on <Input>).
  const [composeTick, setComposeTick] = useState(0)
  // One token per burst of typing, reset after a pick: it is what makes a burst of keystrokes
  // bill as a single lookup. Lazy init — a plain `useRef(newPlaceSession())` would call
  // `crypto.randomUUID()` on every render and throw away all but the first.
  const session = useRef<string | undefined>(undefined)
  if (session.current === undefined) session.current = newPlaceSession()
  // True while an IME composition (e.g. pinyin) is in progress. A ref, not state: it must be
  // readable synchronously inside the debounce effect without itself being a reactive trigger.
  const composing = useRef(false)
  // Synchronous, unlike `busy`: guards `pick()` itself against a second invocation landing before
  // React has re-rendered with `busy = true` (state updates aren't visible to a still-in-flight
  // closure the instant they're scheduled).
  const picking = useRef(false)
  const listboxId = `${id}-listbox`

  // The text of the last CONFIRMED pick — state, not a ref, because it is read during render
  // (React's compiler refuses a ref read there) and only ever written from an event handler, so
  // there is no synchronous-within-an-async-closure need the way `requestedPlaceIdRef`-style refs
  // elsewhere in this flow have. Set below whenever a pick lands, and seeded here (lazily, once)
  // from whatever `value` arrives already filled: a returning customer's saved address, or a
  // merchant's saved origin, is exactly as settled as a pick made a moment ago in this session.
  // `null` the instant a keystroke lands (`onChange` below), because typing is what un-confirms it.
  const [confirmedText, setConfirmedText] = useState<string | null>(() => value.trim() || null)

  const query = value.trim()
  const eligible = open && query.length >= 3
  // The field's current text already has a known-good answer sitting in it — a prior pick, or a
  // prefill nobody has touched yet. Focusing (or reopening) that field must not spend a fresh
  // Places request just to re-derive an answer already on screen (#101 review, Finding 4): tabbing
  // through a prefilled saved address, or clicking into a saved origin, cost a real lookup with no
  // keystroke at all.
  const settled = query.length > 0 && query === confirmedText
  const suggestions = eligible && !settled ? fetched : []
  // True the instant a query becomes eligible and stays true until a fetch actually resolves FOR
  // THAT query — this is what keeps the live region from ever announcing "no suggestions" before
  // a search for the current text has actually run (see the live region below). A settled query
  // has nothing left to search for, so it is never "searching".
  const searching = eligible && !settled && fetchedFor !== query

  useEffect(() => {
    if (!eligible) return
    // The query's answer is already settled (see `settled` above) — opening the list here must
    // not re-fetch it.
    if (settled) return
    // Reopening a list whose query hasn't changed (e.g. Escape then ArrowDown) means the held
    // results are still the correct answer — refetching would both spend a request the platform
    // pays for and, worse, resolve mid-navigation and stomp a highlight the user just set with no
    // keystroke of theirs causing it.
    if (query === fetchedFor) return
    // Suppress paid lookups on intermediate IME fragments; onCompositionEnd below bumps
    // `composeTick` to re-run this effect once the composed text is final.
    if (composing.current) return
    // Debounced: every keystroke that reaches the proxy is a request the platform pays for.
    let live = true
    const timer = setTimeout(async () => {
      const hits = await suggestPlaces(query, session.current!)
      if (!live) return
      setFetched(hits)
      setFetchedFor(query)
      setActiveIndex(-1)
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [query, eligible, composeTick, fetchedFor, settled])

  async function pick(s: PlaceSuggestion) {
    // A pick already in flight wins. Without this the listbox stays clickable across the await,
    // so a second click starts a second `placeDetail` on the SAME session token — billed as a
    // second lookup — and both calls reach `onPick`, leaving the caller holding whichever
    // address happened to resolve last.
    if (picking.current) return
    picking.current = true
    setBusy(true)
    // Cleared in the SAME render that hides the list. `busy` unmounts the listbox, so an
    // `activeIndex` left pointing at a gone option would leave `aria-activedescendant` naming an
    // id that no longer exists — an ARIA-invalid state a screen reader reads mid-selection.
    setActiveIndex(-1)
    // The SAME session token as the suggests — that is what closes the billable session.
    let detail: PlaceDetail | null
    try {
      detail = await placeDetail(s.placeId, session.current!)
    } finally {
      // `finally`, not a bare assignment: this guard is the only thing standing between a second
      // click and a second billed session, and `placeDetail`'s never-throw contract is the only
      // reason a bare assignment would do. If that contract is ever loosened, a latched `true`
      // here disables every future pick for the life of the component, recoverable only by
      // remounting — the customer simply cannot choose an address any more.
      picking.current = false
    }
    setBusy(false)
    setOpen(false)
    setFetched([])
    setFetchedFor(null)
    session.current = newPlaceSession()
    // A details call that failed must NOT be turned into an address: the caller would then hold
    // a place the fee cannot be measured to.
    if (detail) {
      // This pick's text is the new settled answer — refocusing the field before it is touched
      // again must not re-fetch (see `settled` above).
      setConfirmedText(detail.formatted.trim())
      onPick(detail)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (query.length < 3) return // nothing to open or navigate — leave the key alone
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
  // Hidden (not just visually, but from the DOM) while a pick is in flight, so the options are
  // not clickable across the await — the other half of the concurrent-pick guard above.
  const showList = open && !busy && suggestions.length > 0

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
        onChange={e => { setConfirmedText(null); setOpen(true); onTextChange?.(e.target.value) }}
        onKeyDown={onKeyDown}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => { composing.current = false; setComposeTick(v => v + 1) }}
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
      {/* Announces state for screen-reader users, who cannot see the list render. Three real
          states, not two: searching must be its own case, or "no suggestions" gets announced
          during every debounce window (the instant a 3rd character lands) and then contradicted
          ~300ms later — which is worse than saying nothing. "No suggestions" is only reachable
          once a fetch has actually completed for the CURRENT query (`fetchedFor === query`), and
          this doubles as the only busy indicator — a duplicate plain-text one was removed. */}
      <div role="status" aria-live="polite" className="sr-only">
        {busy
          ? t('Looking up that address…', '正在查询地址…')
          : !eligible
            ? ''
            : searching
              ? t('Searching for addresses…', '正在搜索地址…')
              : suggestions.length > 0
                ? t(`${suggestions.length} suggestions available`, `找到 ${suggestions.length} 个建议地址`)
                : t('No suggestions found', '未找到建议地址')}
      </div>
    </div>
  )
}
