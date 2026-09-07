import { useEffect, useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SettingsMenuItem<K extends string> { key: K; label: string }

interface SettingsMenuProps<K extends string> {
  heading: string
  items: readonly SettingsMenuItem<K>[]
  active: K
  onSelect: (key: K) => void
}

// The Settings section's own navigation column — a second, quieter sidebar sitting between the
// dashboard's nav and the active settings panel.
//
// It replaced a horizontal tab rail. Seven labels never fit one row in the dashboard column, so
// the rail wrapped onto two or three lines whose height changed with the language, and the
// panel below it moved with them. A vertical list has one item per row at every width, and the
// count can grow without the layout reflowing.
//
// Deliberately NOT the `Tabs` primitive in its vertical orientation: that renders a sunken pill
// track with an oxblood fill, which reads as a control sitting on top of the page. This is
// navigation, so it borrows `DashboardShell`'s nav idiom instead — flat rows, a tinted active
// row — one step quieter than the nav it sits beside, since it is one level down.
//
// On a phone the column becomes a full-width block above the panel, and there it COLLAPSES:
// seven rows plus a heading pushed the form most of a screen down, so a merchant opening
// Settings saw a menu and no setting. Collapsed, the trigger names the tab it would open —
// which is also why the panel's own heading is hidden at that width, rather than printing the
// same word twice a few pixels apart.
//
// The trigger is a labelled row, NOT a second hamburger. `DashboardShell` already puts one in
// the mobile top bar for the dashboard's nav, and two identical icons opening different menus
// on one screen is a guess the merchant has to make every time.
export default function SettingsMenu<K extends string>({ heading, items, active, onSelect }: SettingsMenuProps<K>) {
  // Mobile only. Desktop ignores it — the list there is always rendered.
  const [open, setOpen] = useState(false)
  const listId = useId()
  const activeLabel = items.find(i => i.key === active)?.label ?? heading

  // Escape closes it, matching the shell's drawer. No scroll lock and no backdrop: the list
  // pushes the page down rather than covering it, so there is nothing behind it to trap.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Closes on every pick, including one the unsaved-changes guard goes on to cancel. Leaving it
  // open would need the guard to report its outcome back; reopening a menu is one tap, and the
  // merchant is looking at the dialog either way.
  const select = (key: K) => { setOpen(false); onSelect(key) }

  return (
    <nav
      aria-label={heading}
      className={cn(
        'flex-shrink-0 w-[190px]',
        // Desktop: a column with a hairline against the panel.
        'border-0 [border-right:0.5px_solid_var(--color-border)] pr-3',
        // Mobile: the column becomes a full-width block stacked above the panel, so the
        // hairline moves to its underside.
        'max-sm:w-full max-sm:pr-0 max-sm:pb-4 max-sm:mb-5',
        'max-sm:[border-right:none] max-sm:[border-bottom:0.5px_solid_var(--color-border)]',
      )}
    >
      {/* An uppercase micro-label, not a 13px row like the items below it. Stacked on mobile the
          heading sits directly on top of the first item, and at the same size it read as one. */}
      <div className="px-3 mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {heading}
      </div>

      {/* Mobile trigger. Bordered, unlike the flat rows it opens, so it reads as a control. */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          'hidden max-sm:flex items-center justify-between w-full gap-2',
          'px-3 py-2.5 min-h-[44px] rounded-md',
          'border-[0.5px] border-border bg-card text-left',
          'text-[13px] font-sans font-semibold tracking-[0.01em] text-primary',
          'cursor-pointer transition-[background,color] duration-150',
          'hover:bg-ink-200',
          'focus-visible:outline-1 focus-visible:outline-primary focus-visible:outline-offset-1',
        )}
      >
        <span>{activeLabel}</span>
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          aria-hidden="true"
          className={cn('flex-shrink-0 transition-transform duration-150', open && 'rotate-180')}
        />
      </button>

      {/* Always rendered on desktop; on mobile only once the trigger is open. */}
      <div id={listId} className={cn('max-sm:mt-2', !open && 'max-sm:hidden')}>
        {items.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => select(key)}
            aria-current={active === key ? 'page' : undefined}
            className={cn(
              'flex items-center w-full px-3 py-2 rounded-md',
              '[@media(pointer:coarse)]:py-2.5',
              'border-0 bg-transparent text-left',
              'text-[13px] font-sans font-medium tracking-[0.01em] text-foreground-secondary',
              'cursor-pointer transition-[background,color] duration-150',
              'hover:bg-ink-200 hover:text-primary',
              'focus-visible:outline-1 focus-visible:outline-primary focus-visible:outline-offset-1',
              active === key && 'bg-brand-wash text-primary font-semibold',
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </nav>
  )
}
