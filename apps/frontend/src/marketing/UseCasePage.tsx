// /for/<slug> — one business type, written for one reader.
//
// ONE component for all four verticals: the layout is shared, the sentences are not (useCases.ts).
// Four hand-written pages would be four places to fix a heading level and four chances for one of
// them to drift out of the language toggle.
//
// Its `<title>` and `<meta name="description">` come from ROUTE_META — the entries are spread in
// from useCases.ts — and are baked into dist/for/<slug>.html by scripts/prerender.tsx.

import { Link } from 'react-router-dom'
import { useSession } from '../SessionContext'
import { MarketingNav, MarketingFooter } from './MarketingChrome'
import { useTopOnRouteChange } from './useTopOnRouteChange'
import { useUseCaseStructuredData } from './structuredData'
import type { UseCase } from './useCases'
import { ctaPrimary } from './ctaStyles'
import { Reveal } from './LandingMotion'

export default function UseCasePage({ useCase }: { useCase: UseCase }) {
  const { t, lang } = useSession()
  // Schema.org markup for this page only, in the language it is currently showing. A distinct @id
  // per vertical — see structuredData.ts.
  useUseCaseStructuredData(useCase, lang)
  useTopOnRouteChange()
  // No useCanonical / useDocumentMeta here: both are mounted once in AppRouter and keyed on the
  // pathname, so every route gets them and none can be forgotten. See canonical.ts, documentMeta.ts.

  return (
    // Keep mm-land class — body:has(.mm-land) in index.css resets body padding/alignment
    <div className="mm-land relative isolate flex flex-col items-stretch min-h-screen font-sans text-foreground bg-background">
      <MarketingNav />
      <main className="flex-1 flex flex-col items-stretch">

      {/* ── Header ── */}
      <section className="max-w-[720px] mx-auto px-8 pt-16 pb-4 text-center max-[600px]:px-5 max-[600px]:pt-10">
        <h1 className="font-heading text-[clamp(1.9rem,4vw,2.75rem)] font-medium text-foreground leading-[1.2] tracking-[-0.01em] mb-5">
          {t(useCase.h1.en, useCase.h1.zh)}
        </h1>
        <p className="text-base leading-[1.75] text-ink-700 max-w-[580px] mx-auto mb-4">
          {t(useCase.intro.en, useCase.intro.zh)}
        </p>
      </section>

      {/* ── The trade's own story ── */}
      <section className="px-8 pb-16 max-w-[760px] mx-auto w-full max-[600px]:px-5 max-[600px]:pb-10">
        <Reveal>
          <div className="flex flex-col gap-10 max-[600px]:gap-8">
            {useCase.blocks.map(block => (
              <div key={block.id}>
                <h2 className="font-heading text-[19px] font-semibold text-primary leading-[1.35] mb-2 max-[600px]:text-[17px]">
                  {t(block.title.en, block.title.zh)}
                </h2>
                <p className="text-[15px] leading-[1.75] text-ink-700 m-0">
                  {t(block.body.en, block.body.zh)}
                </p>
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      {/* ── Questions this trade asks ── */}
      {/* A plain list, not the /faq accordion. A collapsed accordion renders no panel content at
          all, and these pages are prerendered precisely so the words are in the file a crawler
          downloads — the same argument FaqPage.tsx answers with `hiddenUntilFound`, answered here
          by there being nothing to open. Four questions do not need a control. */}
      <section className="border-t border-border px-8 py-14 max-w-[760px] mx-auto w-full max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
          <h2 className="font-heading text-2xl font-medium text-foreground mb-8 max-[600px]:text-xl">
            {t('Questions we get asked', '常被问到的问题')}
          </h2>
          <dl className="flex flex-col gap-7 m-0">
            {useCase.faq.map(entry => (
              <div key={entry.id}>
                <dt className="font-heading text-[16px] font-semibold text-foreground mb-2">
                  {t(entry.q.en, entry.q.zh)}
                </dt>
                <dd className="text-[14px] leading-[1.7] text-muted-foreground m-0">
                  {t(entry.a.en, entry.a.zh)}
                </dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </section>

      {/* ── Closing CTA ── */}
      <section className="border-t border-border px-8 py-16 text-center bg-brand-100 max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
          <h2 className="font-heading italic text-[18px] text-foreground mb-6 max-w-[520px] mx-auto">
            {t('Seven days free, no card, and your own shop at the end of it.', '七天免费，无需信用卡，结束时你已经有了自己的店。')}
          </h2>
          <Link to="/merchant/signup" className={ctaPrimary} data-cta="use-case">
            {t('Start your shop', '开始建店')}
          </Link>
          {/* Back up the tree: a page whose only outbound links point deeper is a dead end to a
              crawler working out which pages belong to which. */}
          <p className="mt-6 mb-0 text-[13px] text-muted-foreground flex flex-wrap justify-center gap-x-4 gap-y-2">
            <Link to="/features" className="underline underline-offset-4 hover:text-primary">
              {t('See everything TinyOrder does', '查看 TinyOrder 的所有功能')}
            </Link>
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
