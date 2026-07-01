import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useSession } from '../SessionContext'
import { signOut } from '../store'
import LanguageSelect from './LanguageSelect'
import { cn } from '@/lib/utils'

export interface NavItem { key: string; label: string; icon: ReactNode }

interface DashboardShellProps {
  logo: string
  title?: string
  role?: string
  nav: NavItem[]
  active: string
  onSelect: (key: string) => void
  userName?: string
  backTo?: { href: string; label: string }
  children: ReactNode
}

// Shared sidebar app-shell for the merchant and admin dashboards.
// Responsive: 210px sidebar on desktop, 64px icon-only on mobile (≤ 640px).
// data-layout-flush triggers body:has([data-layout-flush]) in index.css
// (removes body padding + stretches body flex to full viewport height).
export default function DashboardShell({ logo, title, role, nav, active, onSelect, userName, backTo, children }: DashboardShellProps) {
  const { t } = useSession()
  return (
    <div data-layout-flush="" className="flex gap-0 min-h-screen w-full">
      {/* Sidebar ── 210px desktop → 64px (icon-only) mobile */}
      <aside className={cn(
        'flex flex-col flex-shrink-0 sticky top-0 h-screen overflow-hidden',
        'w-[210px] max-sm:w-16',
        'bg-surface-sunken',
        // Right-only 1.5px border (flush layout — no radius)
        'border-0 [border-right:1.5px_solid_var(--color-clay-border)]',
        'shadow-[2px_0_12px_rgba(122,16,40,0.06)]',
      )}>

        {/* Brand block */}
        <div className={cn(
          'px-5 pt-7 pb-5 border-b border-divider',
          'max-sm:px-0 max-sm:pt-4 max-sm:pb-4 max-sm:text-center',
        )}>
          {/* Logo — Lora serif */}
          <div className="font-heading text-[22px] font-medium text-oxblood tracking-[0.5px] max-sm:text-base">
            {logo}
          </div>
          {/* Shop / app title */}
          {title && (
            <div className="font-heading text-[13px] text-rose-muted mt-0.5 max-sm:hidden">
              {title}
            </div>
          )}
          {/* Role label */}
          {role && (
            <div className="text-[10px] font-medium text-text-tertiary uppercase tracking-[0.12em] mt-1 max-sm:hidden">
              {role}
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className={cn(
          'flex-1 py-3 flex flex-col overflow-y-auto min-h-0 overscroll-contain',
          'max-sm:py-3 max-sm:px-2',
        )}>
          {backTo && (
            <Link
              to={backTo.href}
              title={backTo.label}
              className={cn(
                'group relative flex items-center gap-[10px] w-full',
                'px-5 py-[13px] mb-1',
                'max-sm:justify-center max-sm:px-[10px] max-sm:py-[10px] max-sm:gap-0',
                '[@media(pointer:coarse)]:py-3.5',
                'border-0 rounded-none bg-transparent text-left no-underline',
                'text-[13px] font-sans font-medium tracking-[0.01em] text-rose-muted',
                'cursor-pointer transition-[background,color] duration-150',
                'hover:bg-surface-sunken-hover hover:text-oxblood',
              )}
            >
              <span
                className="flex-shrink-0 w-5 flex items-center justify-center max-sm:w-auto max-sm:text-[18px]"
                aria-hidden="true"
              >
                <ArrowLeft size={18} strokeWidth={1.75} />
              </span>
              <span className="max-sm:hidden">{backTo.label}</span>
            </Link>
          )}
          {nav.map(n => (
            <button
              key={n.key}
              type="button"
              onClick={() => onSelect(n.key)}
              className={cn(
                // Layout
                'group relative flex items-center gap-[10px] w-full',
                'px-5 py-[13px]',
                'max-sm:justify-center max-sm:px-[10px] max-sm:py-[10px] max-sm:gap-0',
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
              <span
                className="flex-shrink-0 w-5 flex items-center justify-center max-sm:w-auto max-sm:text-[18px]"
                aria-hidden="true"
              >
                {n.icon}
              </span>
              {/* Label — hidden on mobile */}
              <span className="max-sm:hidden">{n.label}</span>
            </button>
          ))}
        </nav>

        {/* Footer — user name, language selector, sign-out */}
        <div className={cn(
          'px-5 pt-4 pb-6 border-t border-divider',
          'max-sm:px-2 max-sm:py-3',
        )}>
          {userName && (
            <div className="text-[12px] text-text-tertiary mb-1.5 whitespace-nowrap overflow-hidden text-ellipsis max-sm:hidden">
              {userName}
            </div>
          )}
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
              'max-sm:text-[10px] max-sm:px-1',
              '[@media(pointer:coarse)]:min-h-[44px]',
            )}
          >
            {t('Log out', '登出')}
          </button>
        </div>
      </aside>

      {/* Main content — capped + centered so it doesn't stretch empty on wide screens */}
      <main className="flex-1 min-w-0 pt-7 px-8 pb-16 max-sm:px-4 max-sm:pt-4 max-sm:pb-12">
        <div className="w-full max-w-5xl">
          {children}
        </div>
      </main>
    </div>
  )
}
