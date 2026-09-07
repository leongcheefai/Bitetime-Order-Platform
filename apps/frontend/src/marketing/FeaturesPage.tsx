// /features — everything the shop gives a merchant, in full.
//
// A page of its own rather than a section of the landing page (#169). The landing page keeps a
// three-item highlight and links here; this page owns the full list from features.ts, so the two
// are not two URLs answering "what does TinyOrder do". Its `<title>` and `<meta name="description">`
// come from ROUTE_META and are baked into dist/features.html by scripts/prerender.tsx.

import { Link } from 'react-router-dom'
import { useSession } from '../SessionContext'
import { MarketingNav, MarketingFooter } from './MarketingChrome'
import { useTopOnRouteChange } from './useTopOnRouteChange'
import { FEATURES } from './features'
import { ctaPrimary, sectionTitle } from './ctaStyles'
import { Reveal } from './LandingMotion'

export default function FeaturesPage() {
  const { t } = useSession()
  useTopOnRouteChange()
  // No useCanonical / useDocumentMeta here: both are mounted once in AppRouter and keyed on the
  // pathname, so every route gets them and none can be forgotten. See canonical.ts, documentMeta.ts.

  return (
    // Keep mm-land class — body:has(.mm-land) in index.css resets body padding/alignment
    <div className="mm-land relative isolate flex flex-col items-stretch min-h-dvh font-sans text-foreground bg-background">
      <MarketingNav />
      <main className="flex-1 flex flex-col items-stretch">

      {/* ── Header ── */}
      <section className="max-w-[720px] mx-auto px-8 pt-16 pb-4 text-center max-[600px]:px-5 max-[600px]:pt-10">
        <h1 className="font-heading text-[clamp(1.9rem,4vw,2.75rem)] font-medium text-foreground leading-[1.2] tracking-[-0.01em] mb-5">
          {t('Everything you need to take orders online', '在线接单所需的一切')}
        </h1>
        <p className="text-base leading-[1.75] text-foreground-secondary max-w-[580px] mx-auto mb-4">
          {t(
            'A shop page, delivery fees that match how you deliver, orders that arrive numbered and complete, and a customer list that builds itself. No website, no designer, no developer.',
            '店铺页面、贴合你配送方式的运费、送达时已编号且资料齐全的订单，以及会自动累积的顾客名单。不需要网站、设计师或工程师。',
          )}
        </p>
      </section>

      {/* ── Full feature list ── */}
      <section className="px-8 pb-16 max-w-[900px] mx-auto w-full max-[600px]:px-5 max-[600px]:pb-10">
        <Reveal>
          <div className="grid [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))] gap-x-12 gap-y-9 max-[600px]:[grid-template-columns:1fr] max-[600px]:gap-7">
            {FEATURES.map(f => (
              <div key={f.id}>
                <h2 className="font-heading text-[17px] font-semibold text-primary leading-[1.35] mb-2">
                  {t(f.title.en, f.title.zh)}
                </h2>
                <p className="text-sm leading-[1.7] text-foreground-secondary m-0">
                  {t(f.body.en, f.body.zh)}
                </p>
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      {/* ── Closing CTA ── */}
      <section className="border-t border-border px-8 py-16 text-center bg-brand-wash max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
          <h2 className={sectionTitle}>
            {t('Every one of these is included, free for seven days', '以上功能全包含，免费试用七天')}
          </h2>
          <Link to="/merchant/signup" className={ctaPrimary} data-cta="features">
            {t('Start your shop', '开始建店')}
          </Link>
          {/* Back up the tree: a page whose only outbound links point deeper is a dead end to a
              crawler working out which pages belong to which. */}
          <p className="mt-6 mb-0 text-[13px] text-muted-foreground">
            <Link to="/pricing" className="underline underline-offset-4 hover:text-primary">
              {t('See the price', '查看价格')}
            </Link>
          </p>
        </Reveal>
      </section>

      </main>
      <MarketingFooter />
    </div>
  )
}
