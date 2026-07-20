import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Menu, X } from 'lucide-react'
import { useSession } from '../SessionContext'
import { signOut } from '../store'
import LanguageSelect from './LanguageSelect'
import Wordmark from './Wordmark'
import { cn } from '@/lib/utils'

export interface NavItem { key: string; label: string; icon: ReactNode }

interface DashboardShellProps {
  title?: string
  role?: string
  nav: NavItem[]
  active: string
  onSelect: (key: string) => void
  backTo?: { href: string; label: string }
  children: ReactNode
}

// Shared sidebar app-shell for the merchant and admin dashboards.
// Desktop (≥ 640px): fixed 210px sidebar always visible.
// Mobile (≤ 640px): sidebar collapses into an off-canvas drawer toggled by a
// hamburger in a slim top bar, so the full column width is free for content.
// data-layout-flush triggers body:has([data-layout-flush]) in index.css
// (removes body padding + stretches body flex to full viewport height).
export default function DashboardShell({ title, role, nav, active, onSelect, backTo, children }: DashboardShellProps) {
  const { t } = useSession()
  const [open, setOpen] = useState(false)

  // Close the mobile drawer on Escape, and lock background scroll while it's open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [open])

  // Selecting a nav item also dismisses the drawer on mobile.
  const handleSelect = (key: string) => { onSelect(key); setOpen(false) }

  return (
    <div data-layout-flush="" className="flex gap-0 min-h-screen w-full">
      {/* Mobile top bar — hamburger + brand. Hidden on desktop. */}
      <header className={cn(
        'hidden max-sm:flex fixed top-0 inset-x-0 z-30 h-14 items-center gap-3 px-4',
        'bg-surface-sunken border-b border-divider',
      )}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t('Open menu', '打开菜单')}
          aria-expanded={open}
          className={cn(
            'flex items-center justify-center -ml-1 p-2 rounded-md',
            'text-oxblood cursor-pointer transition-colors',
            'hover:bg-surface-sunken-hover',
          )}
        >
          <Menu size={22} strokeWidth={1.75} />
        </button>
        <Wordmark className="h-6" />
      </header>

      {/* Backdrop — only rendered on mobile while the drawer is open. */}
      {open && (
        <div
          className="hidden max-sm:block fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar ── 210px fixed on desktop; off-canvas drawer on mobile */}
      <aside className={cn(
        'flex flex-col flex-shrink-0 sticky top-0 h-screen overflow-hidden',
        'w-[210px]',
        'bg-surface-sunken',
        // Right-only 1.5px border (flush layout — no radius)
        'border-0 [border-right:1.5px_solid_var(--color-clay-border)]',
        'shadow-[2px_0_12px_rgba(122,16,40,0.06)]',
        // Mobile: fixed drawer that slides in from the left
        'max-sm:fixed max-sm:z-50 max-sm:w-[248px] max-sm:max-w-[82vw]',
        'max-sm:transition-transform max-sm:duration-200 max-sm:ease-out',
        open ? 'max-sm:translate-x-0' : 'max-sm:-translate-x-full',
      )}>

        {/* Brand block */}
        <div className="px-5 pt-7 pb-5 border-b border-divider relative max-sm:pt-5">
          <Wordmark className="h-7" />
          {/* Shop / app title */}
          {title && (
            <div className="font-heading text-[13px] text-rose-muted mt-0.5">
              {title}
            </div>
          )}
          {/* Role label */}
          {role && (
            <div className="text-[10px] font-medium text-text-tertiary uppercase tracking-[0.12em] mt-1">
              {role}
            </div>
          )}
          {/* Close button — mobile drawer only */}
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t('Close menu', '关闭菜单')}
            className={cn(
              'hidden max-sm:flex items-center justify-center absolute top-4 right-3 p-1.5 rounded-md',
              'text-rose-muted cursor-pointer transition-colors hover:bg-surface-sunken-hover hover:text-oxblood',
            )}
          >
            <X size={20} strokeWidth={1.75} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 flex flex-col overflow-y-auto min-h-0 overscroll-contain">
          {backTo && (
            <Link
              to={backTo.href}
              title={backTo.label}
              onClick={() => setOpen(false)}
              className={cn(
                'group relative flex items-center gap-[10px] w-full',
                'px-5 py-[13px] mb-1',
                '[@media(pointer:coarse)]:py-3.5',
                'border-0 rounded-none bg-transparent text-left no-underline',
                'text-[13px] font-sans font-medium tracking-[0.01em] text-rose-muted',
                'cursor-pointer transition-[background,color] duration-150',
                'hover:bg-surface-sunken-hover hover:text-oxblood',
              )}
            >
              <span className="flex-shrink-0 w-5 flex items-center justify-center" aria-hidden="true">
                <ArrowLeft size={18} strokeWidth={1.75} />
              </span>
              <span>{backTo.label}</span>
            </Link>
          )}
          {nav.map(n => (
            <button
              key={n.key}
              type="button"
              onClick={() => handleSelect(n.key)}
              className={cn(
                // Layout
                'group relative flex items-center gap-[10px] w-full',
                'px-5 py-[13px]',
                '[@media(pointer:coarse)]:py-3.5',
                // Reset
                'border-0 rounded-none bg-transparent text-left',
                // Typography
                'text-[13px] font-sans font-medium tracking-[0.01em] text-ink-soft',
                // Interaction
                'cursor-pointer transition-[background,color] duration-150',
                'hover:bg-surface-sunken-hover hover:text-oxblood',
                // Active state
                active === n.key && 'bg-oxblood-tint text-oxblood font-semibold',
              )}
            >
              {/* Indicator bar — left-edge vertical stripe (replaces ::before) */}
              <span
                aria-hidden="true"
                className={cn(
                  'absolute left-0 top-[20%] bottom-[20%] w-[3px]',
                  'bg-oxblood rounded-[0_2px_2px_0]',
                  'transition-transform duration-150',
                  'scale-y-0 group-hover:scale-y-100',
                  active === n.key && 'scale-y-100',
                )}
              />
              {/* Icon */}
              <span className="flex-shrink-0 w-5 flex items-center justify-center" aria-hidden="true">
                {n.icon}
              </span>
              {/* Label */}
              <span>{n.label}</span>
            </button>
          ))}
        </nav>

        {/* Footer — language selector, sign-out */}
        <div className="px-5 pt-4 pb-6 border-t border-divider">
          {/* Language select */}
          <div className="mb-2">
            <LanguageSelect className="w-full" />
          </div>
          {/* Sign out */}
          <button
            type="button"
            onClick={() => signOut()}
            className={cn(
              'bg-transparent border border-clay-border rounded-sm',
              'text-rose-muted text-[12px] font-sans',
              'px-3 py-1.5 w-full cursor-pointer',
              'transition-all duration-150',
              'hover:bg-surface-sunken-hover hover:text-ink hover:border-clay-muted',
              '[@media(pointer:coarse)]:min-h-[44px]',
            )}
          >
            {t('Log out', '登出')}
          </button>
        </div>
      </aside>

      {/* Main content — capped + centered so it doesn't stretch empty on wide screens.
          On mobile the top bar is fixed, so pad the content down to clear it. */}
      <main className="flex-1 min-w-0 pt-7 px-8 pb-16 max-sm:px-4 max-sm:pt-[72px] max-sm:pb-12">
        <div className="w-full max-w-5xl">
          {children}
        </div>
      </main>
    </div>
  )
}
