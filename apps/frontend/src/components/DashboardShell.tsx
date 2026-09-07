import { useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ChevronRight, Menu } from 'lucide-react'
import { useSession } from '../SessionContext'
import { signOut } from '../store'
import LanguageSelect from './LanguageSelect'
import ReleasesBell from './ReleasesBell'
import Wordmark from './Wordmark'
import { Button } from './ui/button'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  useSidebar,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

// `badge` is a count — today only the pending-order count on the Orders section.
//
// `children` makes the item a GROUP: a collapsible trigger with the children drawn indented
// beneath it (shadcn's `SidebarMenuSub`). A group is not a page — clicking it only opens or
// closes the group, and only a child can be the active one. A child's `key` is its sub-section,
// reported through `onSelect(parent.key, child.key)`; a child carries no icon and no badge.
export interface NavItem {
  key: string
  label: string
  icon: ReactNode
  badge?: number
  children?: NavSubItem[]
}
export interface NavSubItem { key: string; label: string }

interface DashboardShellProps {
  title?: string
  role?: string
  nav: NavItem[]
  /** The active section — a top-level `NavItem.key`. */
  active: string
  /** The active child of that section, when the section is a group. */
  activeSub?: string
  onSelect: (key: string, sub?: string) => void
  backTo?: { href: string; label: string }
  // Extra content for the sidebar footer, above Log out. The merchant dashboard puts its
  // support links here; /admin passes nothing, since a superadmin needs no link to themselves.
  // A prop rather than a nav item because a nav key selects a SECTION, and contacting support
  // is not one.
  footerExtra?: ReactNode
  children: ReactNode
}

// The rail's width. shadcn's default is 16rem; 210px is what the hand-rolled rail measured,
// and every dashboard screen was laid out against it.
const SIDEBAR_WIDTH = '210px'

/**
 * Shared sidebar app-shell for the merchant and admin dashboards, on shadcn's `Sidebar`.
 *
 * Desktop (≥ 768px, shadcn's own breakpoint — the hand-rolled rail switched at 640px): a fixed
 * rail, always visible. It is PINNED open — `open` is controlled and never changes — because the
 * shell draws no trigger on desktop, so a rail that could collapse would have no way back. The
 * stock ⌘B toggle is removed from `ui/sidebar.tsx` for the same reason.
 * Mobile: the rail becomes an off-canvas sheet, opened by a hamburger in a slim fixed top bar,
 * and a selection closes it.
 *
 * `data-layout-flush` triggers `body:has([data-layout-flush])` in index.css (removes body
 * padding + stretches body flex to full viewport height).
 */
export default function DashboardShell(props: DashboardShellProps) {
  return (
    <SidebarProvider
      open
      onOpenChange={() => {}}
      data-layout-flush=""
      style={{ '--sidebar-width': SIDEBAR_WIDTH } as CSSProperties}
    >
      <Shell {...props} />
    </SidebarProvider>
  )
}

// Split from the default export because `useSidebar` reads the provider's context — a
// selection on mobile has to dismiss the sheet, and only the context knows the sheet is open.
function Shell({ title, role, nav, active, activeSub, onSelect, backTo, footerExtra, children }: DashboardShellProps) {
  const { t } = useSession()
  const { setOpenMobile } = useSidebar()

  // Selecting a nav item also dismisses the sheet on mobile.
  const select = (key: string, sub?: string) => { onSelect(key, sub); setOpenMobile(false) }

  return (
    <>
      {/* Mobile top bar — hamburger + brand. Hidden on desktop. */}
      <header className={cn(
        'hidden max-md:flex fixed top-0 inset-x-0 z-sticky h-14 items-center gap-3 px-4',
        'bg-muted border-b border-border',
      )}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setOpenMobile(true)}
          aria-label={t('Open menu', '打开菜单')}
          className="-ml-1 size-auto p-2 text-primary hover:bg-ink-200 hover:text-primary"
        >
          <Menu size={22} strokeWidth={1.75} />
        </Button>
        <Wordmark className="h-6" />
      </header>

      <Sidebar
        collapsible="offcanvas"
        // The rail is the page's navigation landmark. Stock shadcn renders it as a bare div, so
        // the brand block, the rows and the footer sat outside every landmark on the page — axe's
        // "region" finding on every dashboard load. On mobile the same props reach the Sheet,
        // which is already a dialog; the role is harmless there.
        role="navigation"
        aria-label={t('Dashboard sections', '仪表板栏目')}
        // Right-only hairline (flush layout — no radius) and the rail's own elevation token.
        className="border-0 [border-right:0.5px_solid_var(--color-border)] shadow-elev-rail"
      >
        {/* Brand block */}
        <SidebarHeader className="px-5 pt-7 pb-5 border-b border-border gap-0">
          <Wordmark className="h-7" />
          {title && (
            <div className="font-heading text-[13px] text-muted-foreground mt-0.5">{title}</div>
          )}
          {role && (
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-[0.12em] mt-1">
              {role}
            </div>
          )}
        </SidebarHeader>

        <SidebarContent className="py-3 overscroll-contain">
          <SidebarMenu className="gap-0">
            {backTo && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link to={backTo.href} title={backTo.label} />}
                  onClick={() => setOpenMobile(false)}
                  className={cn(ROW, 'mb-1 text-muted-foreground no-underline')}
                >
                  <ArrowLeft size={18} strokeWidth={1.75} />
                  <span>{backTo.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            {nav.map(n => n.children ? (
              <NavGroup key={n.key} item={n} subs={n.children} isActive={active === n.key} activeSub={activeSub} onSelect={select} />
            ) : (
              <SidebarMenuItem key={n.key}>
                <SidebarMenuButton
                  isActive={active === n.key}
                  onClick={() => select(n.key)}
                  className={ROW}
                >
                  <NavRow item={n} />
                  {/* Count badge — e.g. pending "new" orders */}
                  {n.badge != null && n.badge > 0 && (
                    <Badge className="ml-auto tabular-nums">{n.badge > 99 ? '99+' : n.badge}</Badge>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarContent>

        {/* Footer — support links, language selector, sign-out */}
        <SidebarFooter className="px-5 pt-4 pb-6 border-t border-border gap-0">
          {footerExtra && <div className="mb-3">{footerExtra}</div>}
          <div className="mb-2 flex items-center gap-2">
            <LanguageSelect className="flex-1" />
            <ReleasesBell />
          </div>
          <Button
            type="button"
            variant="outline"
            size="none"
            onClick={() => signOut()}
            className={cn(
              'rounded-sm text-[12px] px-3 py-1.5 w-full',
              'hover:bg-ink-200 hover:text-foreground hover:border-ink-400',
              'pointer-coarse:min-h-[44px]',
            )}
          >
            {t('Log out', '登出')}
          </Button>
        </SidebarFooter>
      </Sidebar>

      {/* Main content — capped + centered so it doesn't stretch empty on wide screens.
          On mobile the top bar is fixed, so pad the content down to clear it. */}
      <SidebarInset className="min-w-0 pt-7 px-8 pb-16 max-md:px-4 max-md:pt-[72px] max-md:pb-12">
        <div className="w-full max-w-5xl">
          {/* The page's one h1, for the outline and nothing else: the sections open with their
              own visible h3s, and a sighted merchant already reads the active row in the rail.
              Without this the first heading a screen reader met was an h3 — no h1, no h2. */}
          <h1 className="sr-only">{activeLabel(nav, active, activeSub)}</h1>
          {children}
        </div>
      </SidebarInset>
    </>
  )
}

/** "Customers" or "Customers — Members": the active section, and its active child if the section is a group. */
function activeLabel(nav: NavItem[], active: string, activeSub: string | undefined): string {
  const item = nav.find(n => n.key === active)
  if (!item) return active
  const sub = activeSub ? item.children?.find(c => c.key === activeSub) : undefined
  return sub ? `${item.label} — ${sub.label}` : item.label
}

/**
 * A row's look, restated over shadcn's defaults: the type, an ink hover and a brand-wash active
 * state, shared by top-level rows and a group's children; then, for top-level rows only, the
 * full-bleed box and the left-edge indicator stripe — what the rail drew before it was shadcn's.
 * `hover:text-primary` and the stripe both read the accent, which is what lets a branded
 * dashboard tint them (BrandTheme).
 */
const ROW_TEXT = cn(
  'text-[13px] font-sans font-medium tracking-[0.01em] text-ink-700',
  'hover:text-primary data-active:bg-brand-100 data-active:text-primary data-active:font-semibold',
)
const ROW = cn(
  ROW_TEXT,
  'group relative h-auto w-full rounded-none px-5 py-[13px] gap-[10px] pointer-coarse:py-3.5',
  '[&_svg]:size-auto',
  // Indicator bar — left-edge vertical stripe, grown on hover and held on the active row.
  'before:absolute before:left-0 before:top-[20%] before:bottom-[20%] before:w-[3px]',
  'before:bg-primary before:rounded-[0_2px_2px_0] before:transition-transform before:duration-150',
  'before:scale-y-0 hover:before:scale-y-100 data-active:before:scale-y-100',
)

/**
 * A collapsible group of children. Open wherever the merchant is; closed elsewhere, so the rail
 * stays short.
 *
 * The open state is the merchant's — they may fold a group they are not in — but it is FORCED
 * open the moment the group's own section becomes active. `defaultOpen` alone is read once at
 * mount, so a merchant arriving by hash link or by the onboarding checklist, having mounted the
 * rail on Overview, found the active child inside a closed group with nothing on screen to say
 * so. Adjusted during render, the way React asks for state derived from a prop change.
 */
function NavGroup({ item, subs, isActive, activeSub, onSelect }: {
  item: NavItem
  /** Its children — not React's `children`, which is nodes; these are data. */
  subs: NavSubItem[]
  isActive: boolean
  activeSub: string | undefined
  onSelect: (key: string, sub: string) => void
}) {
  const [open, setOpen] = useState(isActive)
  const [wasActive, setWasActive] = useState(isActive)
  if (isActive !== wasActive) {
    setWasActive(isActive)
    if (isActive) setOpen(true)
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen} render={<SidebarMenuItem />}>
      <CollapsibleTrigger render={<SidebarMenuButton isActive={isActive} className={ROW} />}>
        <NavRow item={item} />
        <ChevronRight
          size={16}
          strokeWidth={1.75}
          aria-hidden="true"
          className="ml-auto text-muted-foreground transition-transform duration-150 in-data-panel-open:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SidebarMenuSub className="mx-0 ml-[30px] mr-3 px-0 pl-3 py-0 mb-1 gap-0 border-l-border">
          {subs.map(c => (
            <SidebarMenuSubItem key={c.key}>
              <SidebarMenuSubButton
                render={<button type="button" />}
                isActive={isActive && activeSub === c.key}
                onClick={() => onSelect(item.key, c.key)}
                className={cn(
                  ROW_TEXT,
                  'h-auto w-full rounded-none px-2 py-[9px] pointer-coarse:py-2.5',
                  // Stock sets `data-[size=md]:text-sm`, an attribute selector that outranks the
                  // plain `text-[13px]` in ROW_TEXT — the children drew a size up from their parent.
                  'data-[size=md]:text-[13px]',
                )}
              >
                <span>{c.label}</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      </CollapsibleContent>
    </Collapsible>
  )
}

function NavRow({ item }: { item: NavItem }) {
  return (
    <>
      <span className="flex-shrink-0 w-5 flex items-center justify-center" aria-hidden="true">
        {item.icon}
      </span>
      <span>{item.label}</span>
    </>
  )
}
