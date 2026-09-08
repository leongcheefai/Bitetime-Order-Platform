import { lazy, Suspense } from 'react'
import type { ReactNode } from 'react'
import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { PageTransition } from './motion'
import { SessionProvider, useSession } from './SessionContext'
import { TooltipProvider } from './components/ui/tooltip'
import { MerchantProvider, useMerchant } from './MerchantContext'
import BrandTheme from './components/BrandTheme'
import RequireRole from './RequireRole'
import { useCanonical } from './canonical'
import { useDocumentMeta, useDynamicDocumentTitle } from './documentMeta'
import { usePixels } from './pixels/usePixels'
import { ShopPixelsProvider } from './pixels/ShopPixels'
import { useAnalytics } from './analytics/useAnalytics'
import { Spinner } from './components/Loaders'
import Wordmark from './components/Wordmark'
// STATICALLY IMPORTED, and it is the one route that must be. `/` is prerendered into the HTML
// (scripts/prerender.tsx) so the page is on screen before any script runs — and behind a lazy()
// boundary React threw that page away on boot and put the route spinner in its place until the
// chunk arrived. Measured in a Lighthouse trace: #root went from the full 1350×940 viewport to an
// 86×470 spinner at t+254ms and back at t+595ms, two layout shifts of 0.468 each, a cumulative
// 0.934 and the entire desktop performance gap. Splitting a chunk the entry HTML already contains
// buys nothing and costs the paint we prerendered it for.
import Landing from './marketing/Landing'
// STATICALLY IMPORTED for the same reason and by the same rule: /pricing is prerendered too
// (dist/pricing.html), so a lazy() boundary would throw its markup away on boot and hand the
// visitor a spinner where a finished page already was. It shares nearly all of Landing's imports,
// so the entry chunk grows by this file and not by a second copy of the marketing chrome.
import Pricing from './marketing/Pricing'
// Same rule again: /features and /faq are prerendered (dist/features.html, dist/faq.html), so
// they stay out of the lazy() boundary too. See scripts/prerender.tsx.
import FeaturesPage from './marketing/FeaturesPage'
import FaqPage from './marketing/FaqPage'
// Same rule a fourth time: every /for/<slug> page is prerendered (dist/for/<slug>.html), so the
// template stays out of the lazy() boundary too. One component serves all four — see useCases.ts.
import UseCasePage from './marketing/UseCasePage'
import { USE_CASES, pathForUseCase } from './marketing/useCases'

// Route-level code splitting: every OTHER surface ships its own chunk, so a storefront
// customer never downloads merchant/admin/signup code (signup pulls in the heavy
// pinyin-pro dictionary — kept out of the customer path).
const AdminHome = lazy(() => import('./admin/AdminHome'))
const SignupScreen = lazy(() => import('./merchant/SignupScreen'))
const LoginScreen = lazy(() => import('./merchant/LoginScreen'))
const MerchantHome = lazy(() => import('./merchant/MerchantHome'))
const Storefront = lazy(() => import('./store/Storefront'))
const OrderHistory = lazy(() => import('./store/OrderHistory'))
const ResetPasswordPage = lazy(() => import('./ResetPasswordPage'))
const InvoicePage = lazy(() => import('./InvoicePage'))
const SampleShopsPage = lazy(() => import('./marketing/SampleShopsPage'))
const ReleaseNotes = lazy(() => import('./marketing/ReleaseNotes'))
const ReleasesIndex = lazy(() => import('./marketing/ReleasesIndex'))
const TermsPage = lazy(() => import('./legal/TermsPage'))
const PrivacyPage = lazy(() => import('./legal/PrivacyPage'))
const Toaster = lazy(() => import('./components/ui/sonner').then(m => ({ default: m.Toaster })))
// Lazy for the same reason the toaster is: the marketing entry chunk must not carry a component
// that most visits never render. It is only ever asked for after a visitor with a pixel
// configured reaches a marketing route without having answered.
const ConsentBanner = lazy(() => import('./pixels/ConsentBanner'))

function RouteFallback() {
  return (
    <div className="w-full min-h-[50vh] flex items-center justify-center">
      <Spinner label="Loading…" />
    </div>
  )
}

function StorefrontShell() {
  const { merchant, loading, notFound } = useMerchant()
  const { t } = useSession()
  // The tab is the SHOP's, not the platform's — "the shop is the hero" — so the name stands
  // alone, with no brand suffix. Null until the row lands, which leaves the served title alone.
  useDynamicDocumentTitle(merchant?.name ?? null)

  if (loading) return (
    <div className="w-full min-h-[50vh] flex items-center justify-center">
      <Spinner label="Loading shop…" />
    </div>
  )

  if (notFound) return (
    <div className="form-wrap text-center pt-8 pb-12">
      <div className="text-center mb-10">
        <h1><Wordmark className="h-8 mx-auto" /></h1>
        <p className="font-heading text-[13px] italic text-muted-foreground mt-[5px]">Shop not found</p>
      </div>
      <div className="bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border text-left">
        <p className="text-muted-foreground text-[14px] leading-[1.6] mt-1.5">
          This shop doesn't exist or may have moved.
        </p>
      </div>
    </div>
  )

  if (!merchant) return null

  if (merchant.status !== 'active') return (
    <div className="form-wrap text-center pt-8 pb-12">
      <div className="text-center mb-10">
        <h1><Wordmark className="h-8 mx-auto" /></h1>
        <p className="font-heading text-[13px] italic text-muted-foreground mt-[5px]">{merchant.name}</p>
      </div>
      <div className="bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border text-left">
        <p className="text-muted-foreground text-[14px] leading-[1.6] mt-1.5">
          {t('This shop is temporarily closed. Please check back later.', '本店暂时休息，请稍后再来。')}
        </p>
      </div>
    </div>
  )

  return (
    // The SHOP's own advertising pixels (#220), and TinyOrder's never — `pixelDecision` answers
    // no to every question off a marketing path, which a storefront is. Mounted here, below the
    // not-found and status gates, so the subtree existing IS the proof that this is an active
    // shop's storefront: the hook can then state `inScope: true` as a fact.
    // The shop's own colour, and only below the not-found and status gates: a merchant row is in
    // hand here, and the shell renders a spinner until it is, so nothing flashes the platform
    // accent first. Everything under /s/:slug is inside this — menu, checkout, order history.
    <BrandTheme color={merchant.brand_color}>
    <ShopPixelsProvider merchant={merchant}>
      <Routes>
        <Route index element={<Storefront />} />
        {/* A destination, not a dialog: deep-linkable and shareable. Signed out it renders the
            auth panel in place — deliberately NOT behind RequireRole, which bounces to the
            merchant login: wrong framing, wrong bundle, wrong destination for a customer. */}
        <Route path="orders" element={<OrderHistory />} />
      </Routes>
    </ShopPixelsProvider>
    </BrandTheme>
  )
}

// A merchant who is already signed in has no business on the login screen, and Back is exactly how
// they get there. Renders the form while the session is still resolving — `role` reads 'customer'
// until the shop lookup lands — so a signed-out visitor never waits behind a spinner; on a
// client-side Back the session is already resolved above this tree, so the bounce is immediate.
//
// Login only, NOT signup: the signup flow signs the merchant in halfway through and then hands a
// Pro shop off to Stripe Checkout. A bounce there would hijack the redirect and strand a shop that
// has never paid.
//
// Superadmins are left alone: /merchant is not their dashboard (MerchantHome sends them to /admin),
// so sending them there is a round trip through a screen that only redirects again.
function RedirectSignedInMerchant({ children }: { children: ReactNode }) {
  const { role } = useSession()
  if (role === 'merchant') return <Navigate to="/merchant" replace />
  return children
}

export default function AppRouter() {
  return (
    <SessionProvider>
      {/* One provider for every tooltip in the app, so they share a delay instead of each
          usage inventing one. `delay={200}` is long enough that a pointer crossing the
          dashboard on its way somewhere else does not trail popups behind it. */}
      <TooltipProvider delay={200}>
        <AnimatedRoutes />
      </TooltipProvider>
      <RouteToaster />
      <PixelConsent />
      <PlatformAnalytics />
    </SessionProvider>
  )
}

// Sonner mounts by writing ~15kB of CSS into <head>, and on the landing route that one injection
// is the largest single difference between the HTML the server sends and the DOM the browser ends
// up with — larger than the whole body. That difference is measured: `/` is prerendered
// (scripts/prerender.tsx) precisely so crawlers that do not execute JavaScript can read the page
// out of the raw HTML, and a page that rewrites its own head on boot is scored as heavily rendered
// however complete its body is.
//
// The landing page fires no toasts — it has no action that can fail — so it mounts no toaster.
// Every other route keeps one. Lazy for the mirror-image reason: sonner leaves the entry chunk, so
// the marketing page no longer downloads a toast library it never uses.
//
// If a marketing route ever needs a toast, mount one there rather than deleting this gate — a
// `toast()` with no Toaster mounted is silent, and that failure is invisible in review.
const NO_TOASTER = new Set(['/'])

function RouteToaster() {
  const { pathname } = useLocation()
  if (NO_TOASTER.has(pathname)) return null
  return (
    <Suspense fallback={null}>
      <Toaster position="bottom-center" />
    </Suspense>
  )
}

// The advertising pixels and the question that gates them. Mounted here, beside RouteToaster and
// for the same reason: it is route-aware and app-wide, and it belongs outside AnimatedRoutes so a
// page transition does not animate it.
//
// The hook is called unconditionally — the pageview effects live inside it and must run whether or
// not the banner is on screen. Only the banner itself is conditional.
function PixelConsent() {
  const { t } = useSession()
  const { showBanner, accept, reject } = usePixels()
  if (!showBanner) return null
  return (
    <Suspense fallback={null}>
      <ConsentBanner
        onAccept={accept}
        onReject={reject}
        message={t(
          'We use advertising cookies on our own pages to measure our advertising. They load only if you accept, and never on a shop’s page.',
          '我们在自己的页面上使用广告 Cookie 来衡量广告效果。只有你接受后才会加载，店铺页面上永远不会使用。',
        )}
      />
    </Suspense>
  )
}

// TinyOrder's own measurement, mounted here for the reason PixelConsent is: route-aware, app-wide,
// and outside AnimatedRoutes so a page transition does not remount it. It renders nothing — the
// hook is all of it. Unlike the pixels above it asks nobody: it sets no cookie, it reports to our
// own systems only, and it never reports a storefront at all (analytics/scope.ts).
function PlatformAnalytics() {
  useAnalytics()
  return null
}

function AnimatedRoutes() {
  const location = useLocation()
  // Written per route, not in index.html: one HTML file serves every path, so a static tag would
  // declare every storefront to be the homepage. See canonical.ts.
  useCanonical()
  // Same argument, same place, for the title and description — a route with no entry of its own
  // gets the served document's back rather than keeping the last route's. See documentMeta.ts.
  useDocumentMeta(location.pathname)
  return (
    <Suspense fallback={<RouteFallback />}>
      {/* Keyed on the path so each route fades in, and NOT wrapped in AnimatePresence: an
          exit-gated swap never completes in a backgrounded tab, which froze the app on
          whatever route it was showing. See the rule at the top of motion.tsx. */}
      <PageTransition key={location.pathname}>
        <Routes location={location}>
          <Route path="/" element={<Landing />} />
          {/* A route, not the landing page's `#pricing` anchor. An anchor is the same URL to a
              crawler; this is a second page with its own <title> and description, which is what
              Google draws a sitelink label from (#169). Prerendered — see scripts/prerender.tsx. */}
          <Route path="/pricing" element={<Pricing />} />
          {/* Same argument as /pricing: real pages of their own, not landing anchors, each with
              its own <title> and description for Google to draw a sitelink from (#169).
              Prerendered — see scripts/prerender.tsx. */}
          <Route path="/features" element={<FeaturesPage />} />
          <Route path="/faq" element={<FaqPage />} />
          {/* One route per business type, all rendered by one template. Same argument as /pricing
              and /features: real pages of their own with their own <title> and description, and
              the page a visitor searching for their own trade actually lands on (#214).
              Prerendered — see scripts/prerender.tsx. */}
          {USE_CASES.map(useCase => (
            <Route
              key={useCase.slug}
              path={pathForUseCase(useCase.slug)}
              element={<UseCasePage useCase={useCase} />}
            />
          ))}
          {/* NOT prerendered, unlike the three routes above — the shop list is fetched
              client-side with no fallback data, so a prerendered shell would just be empty
              markup. See SampleShopsPage.tsx. */}
          <Route path="/sample-shops" element={<SampleShopsPage />} />
          {/* Public, no guard, opened in a new tab from the dashboard's "what's new" bell — the
              Claude-rewritten counterpart to a raw github.com release page. See
              docs/superpowers/specs/2026-08-05-github-release-notes-design.md. */}
          <Route path="/releases/:tag" element={<ReleaseNotes />} />
          {/* The full published history. The bell's popover shows only the three newest and
              links here, so an older release stays reachable. Not prerendered either. */}
          <Route path="/releases" element={<ReleasesIndex />} />
          {/* Top-level on purpose, NOT nested under /s/:slug: the storefront shell's status gate
              would swallow it, and a suspended shop must never lock a customer out of their own
              account. Role-blind — `?shop=` decides where they land afterwards. */}
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          {/* Top-level for the same reason, and for the same kind of person: a guest order is
              orphaned for ever (`user_id` null), so this door is the ONLY way that customer
              reaches their own invoice — and a shop being suspended must not close it. The shop
              rides in `?shop=`, because an order number is unique per shop only. */}
          <Route path="/invoice" element={<InvoicePage />} />
          {/* Top-level for the same reason, and it matters for the same kind of person: a
              customer of a SUSPENDED shop must still be able to read the notice describing data
              we already hold about them. A shop's status can never gate that. */}
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/s/:slug/*" element={<MerchantProvider><StorefrontShell /></MerchantProvider>} />
          {/* The optional segments preselect the billing cycle — `/merchant/signup/yearly` rather
              than `?billing=yearly`, because a query string is what a link auditor and a human
              both read as unfriendly. Optional, so the bare URL in sitemap.xml and a half-typed
              one still land on the form; collapsed to that bare URL by canonicalPath, so every
              CTA is one indexed page.

              TWO optional segments for ONE value, deliberately: the URL used to carry the plan
              first (`/merchant/signup/pro/yearly`), and those links are still in inboxes and in
              Stripe's own cancel_url history. A one-segment route would match none of them and
              render a blank page — SignupScreen reads whichever segment is a cycle. */}
          <Route path="/merchant/signup/:a?/:b?" element={<SignupScreen />} />
          <Route path="/merchant/login" element={<RedirectSignedInMerchant><LoginScreen /></RedirectSignedInMerchant>} />
          <Route path="/merchant" element={<RequireRole role="merchant"><MerchantHome /></RequireRole>} />
          <Route path="/merchant/:slug" element={<RequireRole role="superadmin"><MerchantHome /></RequireRole>} />
          <Route path="/admin/merchants" element={<RequireRole role="superadmin"><AdminHome /></RequireRole>} />
          <Route path="/admin" element={<RequireRole role="superadmin"><AdminHome /></RequireRole>} />
        </Routes>
      </PageTransition>
    </Suspense>
  )
}
