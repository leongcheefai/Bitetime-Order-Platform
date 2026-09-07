// The signup card that appears once a reader reaches the end of a marketing page.
//
// One card, mounted by MarketingFooter, so every marketing page has it and no page can be
// forgotten — the footer is the one thing all six of them render.
//
// NOTHING IS REMEMBERED — no storage, no cookie, no flag. Closing the card closes it for the page
// being read and no longer; the next marketing page mounts a new footer and asks again, and so does
// the next visit. That is deliberate: the one thing that stops the card is having an account, which
// is the thing it is asking for. A visitor who has not signed up has not answered it yet.
//
// THE TRIGGER IS A MEASUREMENT OF A SENTINEL ABOVE THE FOOTER, taken at three moments: at mount,
// once more when the page has settled, and on scroll. Each covers a case the others miss, and the
// effect below says which. What they have in common is that every one of them reads the SENTINEL'S
// OWN BOX rather than scroll arithmetic, so the answer does not depend on having witnessed the
// scrolling that got the reader there — which is the bug a bare scroll listener has: a reader who
// scrolls while the route chunk is still arriving moves the page past the end, the events land on
// nobody, and the card never appears on that visit at all.
//
// An IntersectionObserver was tried here and reverted. It answers the same question more neatly,
// but it delivers NOTHING while a tab is not being rendered and does not always deliver its first
// record on the way back — so the card's arrival became dependent on how the tab had been used.
// A measurement is a measurement whenever it is taken.
//
// IT RENDERS NO CARD UNTIL A CHECK PASSES, and that is what keeps it out of the prerendered markup:
// scripts/prerender.tsx renders these routes with renderToStaticMarkup, which fires no effects, so
// the card is absent from the HTML a crawler downloads and the pages it measures are byte-identical
// to what they were. The sentinel itself is an empty, zero-height div.

import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { X } from 'lucide-react'
import { useSession } from '../SessionContext'
import { trackEvent } from '../analytics/events'
import { platformPixelIds, hasAnyPixel } from '../pixels/ids'
import { isMarketingPath } from '../pixels/marketingPaths'
import { readConsent, PLATFORM_CONSENT_SCOPE } from '../pixels/consent'
import { pixelDecision } from '../pixels/decision'
import { ctaPrimary } from './ctaStyles'
import { cn } from '../lib/utils'

// Read once at module scope: the pixel ids are inlined at build time and cannot change while the
// app runs. Same reason usePixels.ts reads them there.
const PIXEL_IDS = platformPixelIds()
const PIXELS_CONFIGURED = hasAnyPixel(PIXEL_IDS)

/**
 * Is the advertising-consent banner on screen right now?
 *
 * It is `fixed inset-x-0 bottom-0 z-sticky`, so a card in the same corner would sit under it. Asked
 * through the SAME decision function usePixels asks, rather than a second copy of the rule — this
 * has to be the banner's real answer, including the routes (/for/<slug>) where it never appears.
 *
 * Read at the moment the card wants to show rather than once at mount: the visitor may answer the
 * banner while reading, and the next scroll then finds the corner free.
 */
function consentBannerOpen(pathname: string): boolean {
  return pixelDecision({
    configured: PIXELS_CONFIGURED,
    inScope: isMarketingPath(pathname),
    choice: readConsent(PLATFORM_CONSENT_SCOPE),
  }).banner
}

export default function ScrollCta() {
  const { t, account } = useSession()
  const { pathname } = useLocation()
  // The card's whole memory: whether it is up, whether it was closed, and WHICH PAGE that is about.
  //
  // The path is part of the state because an in-app navigation does not remount this component —
  // React reconciles the footer in place, since every marketing page renders the same one in the
  // same slot. Without the stamp, a card closed on /features stays closed on /pricing and on every
  // page after it, which is the persistence this feature deliberately does not have wearing a
  // different hat. State belonging to another path is ignored rather than reset in an effect,
  // which would be a second render for nothing.
  const [card, setCard] = useState({ path: pathname, shown: false, closed: false })
  const { shown, closed } = card.path === pathname ? card : { shown: false, closed: false }
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // SIGNED OUT ONLY. `account` is `undefined` while the session is still resolving and `null` when
  // there is nobody, so the test is against null rather than falsiness: anything else — a merchant,
  // a superadmin, a shop's customer, or a session not yet read — leaves the card off. Erring toward
  // silence is deliberate; the visitor this card is for is the one with no account at all, and a
  // card that flashes up while the session loads would be shown to exactly the wrong people.
  const signedOut = account === null

  useEffect(() => {
    if (shown || closed || !signedOut) return
    let settle: ReturnType<typeof setTimeout> | null = null
    let throttle: ReturnType<typeof setTimeout> | null = null

    // Has the reader reached the sentinel? Measured off its own box rather than off scroll
    // arithmetic: where the footer IS in the viewport is the question, and the element answers it
    // whatever the page's height turns out to be. 120px early, so the card arrives while the
    // closing section is still being read rather than after the reader has stopped.
    function reachedEnd(): boolean {
      const sentinel = sentinelRef.current
      if (!sentinel) return false
      return sentinel.getBoundingClientRect().top <= window.innerHeight + 120
    }

    function check(): void {
      throttle = null
      if (!reachedEnd()) return
      // Asked at the moment the card would appear, not once at mount: a reader who answers the
      // banner while reading leaves the corner free, and the next check is the one that finds it.
      if (consentBannerOpen(pathname)) return
      setCard({ path: pathname, shown: true, closed: false })
      trackEvent('scroll_cta_shown', { from: pathname })
    }

    // Three ways in, and each covers a case the others miss.
    //
    // NOW, because the reader may already be at the end — the browser restores the scroll position
    // of a page they are coming back to, and that arrival produces no event of its own.
    check()
    // AGAIN once the page has settled, because "now" can be too early to mean anything: a route
    // chunk still arriving leaves the document its final height has not been decided from, and a
    // reader who scrolls during that boot moves the page past the end while nothing is listening.
    // Without this the card would never appear on that visit at all.
    settle = setTimeout(check, 900)
    // And on scroll, which is the ordinary path. Throttled to one measurement per 120ms, trailing
    // edge, so the scroll that STOPS at the foot of the page is the one that counts.
    function onScroll(): void {
      if (!throttle) throttle = setTimeout(check, 120)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (settle) clearTimeout(settle)
      if (throttle) clearTimeout(throttle)
    }
  }, [shown, closed, signedOut, pathname])

  // The close is honoured for as long as this page is being read. `closed` and not merely "not
  // shown", so the next check cannot put the card straight back when the reader scrolls on. The
  // click needs no handler at all — following the link takes the reader off this page.
  function close(): void {
    setCard({ path: pathname, shown: false, closed: true })
    trackEvent('scroll_cta_dismissed', { from: pathname })
  }

  return (
    <>
      {/* The mark that gets measured, in the page's own flow directly above the footer. Empty and
          zero-height, so it changes no layout and adds nothing to the prerendered markup a crawler
          reads; it is rendered whether or not the card is, because it is what decides. */}
      <div ref={sentinelRef} aria-hidden="true" className="h-0" />
      {shown && (
        <div
          role="complementary"
          aria-label={t('Start your shop', '开始建店')}
          // z-notif-panel (50) keeps it under the consent banner (z-sticky, 90) and under every dialog; the banner is
          // suppressed above anyway, so the two can never share the corner.
          // The entry fade is the app's own `.page-enter` keyframe rather than a JS animation, for the
          // reason at the top of motion.tsx: the resting style is the visible one, so an animation
          // that never runs leaves a readable card instead of an invisible one. Reduced motion is
          // handled globally by index.css.
          // The width caps with a PERCENTAGE, never a `vw` unit: a fixed box's containing block IS the
          // viewport, so 100% is the same measurement without the failure src/layout.test.ts exists to
          // stop — an in-app browser that lays the page out off screen resolves `100vw` as 0.
          className={cn(
            'page-enter fixed z-notif-panel bottom-4 right-4 w-[360px] max-w-[calc(100%-2rem)]',
            'max-[600px]:left-4 max-[600px]:right-4 max-[600px]:w-auto',
            'rounded-lg border border-border bg-card p-5 pr-10',
            'shadow-elev-2',
          )}
        >
          <button
            type="button"
            onClick={close}
            aria-label={t('Close', '关闭')}
            className="absolute top-2.5 right-2.5 flex h-7 w-7 pointer-coarse:h-10 pointer-coarse:w-10 items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground [transition:color_0.15s,background_0.15s] hover:bg-brand-100 hover:text-primary"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
          <p className="font-heading text-[16px] font-medium text-foreground leading-[1.35] mb-2">
            {t('Ready to take your own orders?', '准备好自己收单了吗？')}
          </p>
          <p className="text-[13px] leading-[1.65] text-muted-foreground mb-4">
            {t(
              'Set up your shop in minutes. Seven days free, and no card to start.',
              '几分钟就能开好店。七天免费，无需信用卡。',
            )}
          </p>
          {/* `data-cta` is what the delegated listener in useAnalytics reports as `cta_click`, so the
              click half of this funnel needs no handler of its own — only the close does. */}
          <Link
            to="/merchant/signup"
            data-cta="scroll-end"
            className={cn(ctaPrimary, 'block w-full text-center')}
          >
            {t('Start your shop', '开始建店')}
          </Link>
        </div>
      )}
    </>
  )
}
