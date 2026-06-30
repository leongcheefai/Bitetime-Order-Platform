import type { ReactNode } from 'react'
import { useSession } from '../SessionContext'
import { signOut } from '../store'
import LanguageSelect from './LanguageSelect'

export interface NavItem { key: string; label: string; icon: ReactNode }

interface DashboardShellProps {
  logo: string
  title?: string
  role?: string
  nav: NavItem[]
  active: string
  onSelect: (key: string) => void
  userName?: string
  children: ReactNode
}

// Shared sidebar app-shell for the merchant and admin dashboards. Reuses the
// existing `.user-sidebar` / `.sidebar-*` / `.user-main` styles (responsive,
// collapses to icons under 640px) — only the active section is swapped in.
export default function DashboardShell({ logo, title, role, nav, active, onSelect, userName, children }: DashboardShellProps) {
  const { t } = useSession()
  return (
    <div className="user-layout user-layout--flush">
      <aside className="user-sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-logo">{logo}</div>
          {title && <div className="sidebar-title">{title}</div>}
          {role && <div className="sidebar-role">{role}</div>}
        </div>
        <nav className="sidebar-nav">
          {nav.map(n => (
            <button
              key={n.key}
              type="button"
              className={`sidebar-nav-item${active === n.key ? ' active' : ''}`}
              onClick={() => onSelect(n.key)}
            >
              <span className="sidebar-nav-icon" aria-hidden="true">{n.icon}</span>
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          {userName && <div className="sidebar-user-name">{userName}</div>}
          <div className="sidebar-lang">
            <LanguageSelect className="w-full" />
          </div>
          <button type="button" className="sidebar-signout" onClick={() => signOut()}>{t('Log out', '登出')}</button>
        </div>
      </aside>
      <main className="user-main user-main--dash">{children}</main>
    </div>
  )
}
