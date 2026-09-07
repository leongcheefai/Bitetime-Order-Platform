// /sample-shops — browse real shops built with TinyOrder.
//
// Reached only by clicking the hero's "See sample shops" button (Landing.tsx) — a page of its
// own, not a landing-page section, so a visitor asking to see shops gets the full list rather
// than a teaser row competing with the rest of the homepage for scroll depth.
//
// PRERENDERED, but only down to the chrome. The shop list is read in an effect and
// renderToStaticMarkup runs none, so the carousel slot is empty in the built file and the page a
// crawler downloads is the heading, the intro line, the nav and the footer. That is thin, and it
// is the honest ceiling: baking the list would mean a database read at build time, and a build
// that could not reach the database would ship a page stating this shop has no shops. What the
// prerender buys is the head — a canonical, an og:url, and a title and description of this page
// rather than the homepage's. See docs/superpowers/specs/2026-08-04-sample-shops-carousel-design.md.
import { useSession } from '../SessionContext'
import { MarketingNav, MarketingFooter } from './MarketingChrome'
import { useTopOnRouteChange } from './useTopOnRouteChange'
import { useSampleShops } from '../useSampleShops'
import { Reveal } from './LandingMotion'
import { sectionTitle } from './ctaStyles'
import SampleShopsCarousel from './SampleShopsCarousel'

export default function SampleShopsPage() {
  const { t } = useSession()
  const { shops, loading } = useSampleShops()
  useTopOnRouteChange()

  return (
    <div className="mm-land relative isolate flex flex-col items-stretch min-h-dvh font-sans text-foreground bg-background">

      <MarketingNav />
      <main className="flex-1 flex flex-col items-stretch">

      <section className="px-8 pt-16 pb-16 max-[600px]:px-5 max-[600px]:pt-10 max-[600px]:pb-10">
        {/* The h1 stays OUTSIDE the reveal, as on every other marketing page: it is prerendered,
            and a heading whose visibility waits on JS and an IntersectionObserver is the one that
            ships blank to a crawler and to a paused tab. */}
        <h1 className={sectionTitle}>
          {t('Real shops on TinyOrder', 'TinyOrder 上的真实店铺')}
        </h1>
        <Reveal>
          <p className="-mt-6 mb-10 text-[15px] leading-[1.7] text-ink-700 text-center max-w-[560px] mx-auto">
            {t(
              'A few real shops built with TinyOrder. Open one and place a real order — these are live storefronts, not pictures.',
              '看看用 TinyOrder 开的真实店铺。打开任何一间就可以真实下单 — 这些是营业中的店铺，不是图片。',
            )}
          </p>
          {shops.length > 0 ? (
            <SampleShopsCarousel shops={shops} />
          ) : !loading ? (
            <p className="text-center text-[14px] text-muted-foreground">
              {t('No sample shops yet — check back soon.', '暂无示例店铺，请稍后再来看看。')}
            </p>
          ) : null}
        </Reveal>
      </section>

      </main>
      <MarketingFooter />
    </div>
  )
}
