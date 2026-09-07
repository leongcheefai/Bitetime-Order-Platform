// /faq — the full shop-owner FAQ.
//
// A page of its own rather than a section of the landing page (#169). The landing page keeps a
// short lead-in and links here; this page owns the accordion and the FAQPage structured data, so
// the two are not two URLs answering the same pre-purchase questions. Its `<title>` and
// `<meta name="description">` come from ROUTE_META and are baked into dist/faq.html by
// scripts/prerender.tsx.

import { Link } from 'react-router-dom'
import { useSession } from '../SessionContext'
import { MarketingNav, MarketingFooter } from './MarketingChrome'
import { useTopOnRouteChange } from './useTopOnRouteChange'
import { useFaqStructuredData } from './structuredData'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '../components/ui/accordion'
import { FAQ } from './faq'
import { ctaPrimary } from './ctaStyles'
import { Reveal } from './LandingMotion'

export default function FaqPage() {
  const { t, lang } = useSession()
  // Schema.org markup for this page only, in the language it is currently showing. See
  // structuredData.ts for why it is not a static block in index.html.
  useFaqStructuredData(lang)
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
          {t('Questions from shop owners, answered', '店主常见问题')}
        </h1>
        <p className="text-base leading-[1.75] text-ink-700 max-w-[580px] mx-auto mb-4">
          {t(
            'The things shop owners ask us before they sign up.',
            '店主在注册前最常问我们的问题。',
          )}
        </p>
      </section>

      {/* ── FAQ ── */}
      <section className="px-8 pb-16 max-[600px]:px-5 max-[600px]:pb-10">
        <Reveal>
          {/* First panel open by default. A collapsed accordion renders NO panel content at all —
              not hidden text, no text — so every answer here was invisible to a crawler and to the
              reader deciding whether to read on. Opening the first one puts a real answer on the
              page and shows the rest are openable.

              `hiddenUntilFound` is what gets the other eight into the HTML: the closed panels are
              rendered with `hidden="until-found"` instead of not being rendered, so the words are
              in the file a crawler downloads — which is the point on a page that is prerendered
              for exactly that reason — and find-in-page opens the panel it matched instead of
              scrolling past nothing. */}
          <Accordion className="max-w-[640px] mx-auto" defaultValue={[FAQ[0].id]} hiddenUntilFound>
            {FAQ.map(entry => (
              <AccordionItem key={entry.id} value={entry.id} className="border-border">
                <AccordionTrigger className="font-heading text-[15px] text-foreground text-left py-4">
                  {t(entry.q.en, entry.q.zh)}
                </AccordionTrigger>
                <AccordionContent className="text-[14px] leading-[1.7] text-muted-foreground pb-4">
                  {t(entry.a.en, entry.a.zh)}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Reveal>
      </section>

      {/* ── Closing CTA ── */}
      <section className="border-t border-border px-8 py-16 text-center bg-brand-100 max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
          <h2 className="font-heading italic text-[18px] text-foreground mb-6 max-w-[520px] mx-auto">
            {t('Seven days, no card, and your own shop at the end of it.', '七天免费，无需信用卡，结束时你已经有了自己的店。')}
          </h2>
          <Link to="/merchant/signup" className={ctaPrimary} data-cta="faq">
            {t('Start your shop', '开始建店')}
          </Link>
          {/* Back up the tree: a page whose only outbound links point deeper is a dead end to a
              crawler working out which pages belong to which. */}
          <p className="mt-6 mb-0 text-[13px] text-muted-foreground">
            <Link to="/" className="underline underline-offset-4 hover:text-primary">
              {t('See how TinyOrder works', '了解 TinyOrder 怎么运作')}
            </Link>
          </p>
        </Reveal>
      </section>

      </main>
      <MarketingFooter />
    </div>
  )
}
