import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchOrderCount } from '../store'
import { useEnterTransition } from '../motion'
import { useDynamicDocumentTitle } from '../documentMeta'
import { LayoutDashboard, ReceiptText, Cake, LayoutList, Ticket, Users, Settings } from 'lucide-react'
import DashboardShell, { type NavItem } from '../components/DashboardShell'
import BrandTheme from '../components/BrandTheme'
import BillingBanner from './BillingBanner'
import VerifyEmailBanner from './VerifyEmailBanner'
import FulfilmentDatesBanner from './FulfilmentDatesBanner'
import TrialFeedbackPrompt from './TrialFeedbackPrompt'
import OnboardingChecklist from './OnboardingChecklist'
import { SkeletonText } from '../components/Loaders'
import FeedbackFab from './FeedbackFab'
import SupportLinks from './SupportLinks'
import { NavGuardProvider, useNavGuard } from './NavGuard'
import { UpgradeNavProvider } from './UpgradeNav'
import { useDashboardSection, useDashboardSubsection } from '../useDashboardSection'
import type { ShopCustomerSegment } from '../types'
import { usePoll } from '../usePoll'

// Each section is its own chunk. Statically imported, the seven of them shipped as ONE
// 418KB file plus a 464KB table chunk — so a merchant opening Overview downloaded the
// drag-and-drop arranger, the day-picker and the full table stack before a single number
// painted. Recharts, the table stack and dnd-kit are named vendor chunks in vite.config.ts,
// so the sections that share one still download it once.
const Overview = lazy(() => import('./Overview'))
const OrdersView = lazy(() => import('./OrdersView'))
const ProductsManager = lazy(() => import('./ProductsManager'))
const StorefrontArranger = lazy(() => import('./StorefrontArranger'))
const VouchersManager = lazy(() => import('./VouchersManager'))
const CustomersView = lazy(() => import('./CustomersView'))
const ShopSettings = lazy(() => import('./ShopSettings'))

const ICON = { size: 18, strokeWidth: 1.75 }
const CUSTOMER_SEGMENTS: { key: ShopCustomerSegment; en: string; zh: string }[] = [
  { key: 'all',     en: 'All customers', zh: '全部顾客' },
  { key: 'members', en: 'Members',       zh: '会员' },
]
const SECTIONS = [
  { key: 'overview',  en: 'Overview',  zh: '概览',  icon: <LayoutDashboard {...ICON} /> },
  { key: 'orders',    en: 'Orders',    zh: '订单',  icon: <ReceiptText {...ICON} /> },
  { key: 'products',  en: 'Products',  zh: '产品',  icon: <Cake {...ICON} /> },
  // Arranging the menu is its own screen, next to the one that fills it: the products table
  // answers "find this product", and this answers "what does a customer see first".
  { key: 'storefront', en: 'Storefront', zh: '店面', icon: <LayoutList {...ICON} /> },
  { key: 'vouchers',  en: 'Vouchers',  zh: '优惠券', icon: <Ticket {...ICON} /> },
  // A group, not a page (#269): its two children are one screen asked two questions. The child
  // keys are the `segment` the customers endpoint takes, so one word names the thing end to end
  // — sidebar child, hash sub-segment, query parameter.
  { key: 'customers', en: 'Customers', zh: '顾客',  icon: <Users {...ICON} />, children: CUSTOMER_SEGMENTS },
  { key: 'settings',  en: 'Settings',  zh: '设置',  icon: <Settings {...ICON} /> },
]

export default function Dashboard() {
  return (
    <NavGuardProvider>
      <DashboardInner />
    </NavGuardProvider>
  )
}

function DashboardInner() {
  const { t, merchant, role } = useSession()
  const { guard } = useNavGuard()
  const [section, setSection] = useDashboardSection(SECTIONS.map(s => s.key), 'overview')
  // The Customers child. `all` is the fallback, so a bare `#customers` — a bookmark from before
  // the group existed — lands on the full list rather than nowhere.
  const [segment] = useDashboardSubsection('customers', CUSTOMER_SEGMENTS.map(s => s.key), 'all')
  const enter = useEnterTransition()
  // "Orders — Sunny Bakes | TinyOrder": section first, because it is what changes between a
  // merchant's tabs, then the shop, because a superadmin viewing as a shop has several open.
  const sectionLabel = SECTIONS.find(s => s.key === section)
  useDynamicDocumentTitle(
    `${sectionLabel ? t(sectionLabel.en, sectionLabel.zh) : section} — ${merchant!.name} | TinyOrder`,
  )

  // Count of pending "new" orders — surfaced as a badge on the Orders nav item.
  // Refetched whenever an order's status changes so the badge stays live.
  //
  // Counted by Postgres. This used to fetch every order the shop had ever taken and filter them
  // here, which made the badge wrong past the row cap (#144) and made the dashboard's heaviest
  // read run on a poll from every section — to produce one integer.
  const [newOrders, setNewOrders] = useState(0)
  const merchantId = merchant?.id
  const refreshNewOrders = useCallback(() => {
    if (!merchantId) return
    fetchOrderCount(merchantId, 'new').then(r => { if (r.ok) setNewOrders(r.data) })
  }, [merchantId])
  useEffect(() => { refreshNewOrders() }, [refreshNewOrders])

  // …and on its own besides, so an order arriving while the merchant is editing their menu still
  // shows up on the Orders nav item. It lives HERE rather than in OrdersView so the badge stays
  // live in every section, which is the whole point of a badge.
  usePoll(refreshNewOrders, { enabled: !!merchantId })

  const nav: NavItem[] = SECTIONS.map(s => ({
    key: s.key,
    label: t(s.en, s.zh),
    icon: s.icon,
    badge: s.key === 'orders' ? newOrders : undefined,
    children: s.children?.map(c => ({ key: c.key, label: t(c.en, c.zh) })),
  }))

  // Route sidebar section switches through the unsaved-changes guard so a dirty
  // Settings tab cannot be silently discarded by navigating away. `sub` is a group's child.
  const selectSection = useCallback(
    (key: string, sub?: string) => guard(() => setSection(key, sub)),
    [guard, setSection],
  )

  // Same guard, but aimed at a sub-tab (#112). Writing the hash is the whole request now that
  // ShopSettings reads its tab from the router — it used to need a remount key here, because the
  // hash was written outside the router and a mounted ShopSettings could not see the change.
  //
  // Inside `guard`, so a cancelled confirm neither navigates nor discards the merchant's edits.
  const goToSettingsTab = useCallback(
    (sub: string) => guard(() => setSection('settings', sub)),
    [guard, setSection],
  )

  return (
    // Pro locks anywhere below can ask for Settings → Subscription (#112); handing them the
    // GUARDED switch is what stops an upgrade CTA discarding a half-typed Shipping form.
    <UpgradeNavProvider navigate={goToSettingsTab}>
    {/* The shop's own colour, on the merchant's own dashboard. `merchant` here is the ACTIVE shop
        — the impersonated one where a superadmin is viewing as a shop, otherwise their own, which
        is what an admin looking at a shop should see. */}
    <BrandTheme color={merchant!.brand_color}>
    <DashboardShell
      title={merchant!.name}
      role={role === 'superadmin' ? t('Viewing as shop', '以店铺身份查看') : t('Merchant', '商家')}
      nav={nav}
      active={section}
      activeSub={section === 'customers' ? segment : undefined}
      onSelect={selectSection}
      backTo={role === 'superadmin' ? { href: '/admin/merchants', label: t('Back to admin', '返回管理') } : undefined}
      footerExtra={<SupportLinks />}
    >
      <BillingBanner />
      {/* Below billing: a shop about to shut outranks an address we cannot yet reach. */}
      <VerifyEmailBanner />
      {/* Same guarded move the Pro locks use, so a warning cannot discard a half-typed form. */}
      <FulfilmentDatesBanner onGoToFulfilment={() => goToSettingsTab('fulfilment')} />
      <TrialFeedbackPrompt />
      <OnboardingChecklist section={section} onNavigate={selectSection} />
      <div key={section} {...enter}>
        {/* The fallback is the same skeleton every section shows while its own data loads, so
            a chunk arriving a beat late reads as the section loading, not as a blank. */}
        <Suspense fallback={<SkeletonText lines={4} />}>
        {section === 'overview'  && <Overview />}
        {section === 'orders'    && <OrdersView onOrdersChanged={refreshNewOrders} />}
        {section === 'products'  && <ProductsManager />}
        {section === 'storefront' && <StorefrontArranger />}
        {section === 'vouchers'  && <VouchersManager />}
        {section === 'customers' && <CustomersView segment={segment} />}
        {section === 'settings'  && <ShopSettings />}
        </Suspense>
      </div>
      <FeedbackFab />
    </DashboardShell>
    </BrandTheme>
    </UpgradeNavProvider>
  )
}
