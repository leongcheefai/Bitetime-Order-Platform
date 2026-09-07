import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '../SessionContext'
import { usePlatformPricing } from '../usePlatformPricing'
import { formatMoney } from '../currency'
import { HandCoins, ListChecks, Languages } from 'lucide-react'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '../components/ui/accordion'
import { cn } from '../lib/utils'
import { FAQ } from './faq'
import { STEPS } from './steps'
import { VERTICALS } from './verticals'
import { PRICING_TIERS } from './pricingTiers'
import { MarketingNav, MarketingFooter } from './MarketingChrome'
import { useTopOnRouteChange } from './useTopOnRouteChange'
import { ctaPrimary, ctaGhost, sectionTitle } from './ctaStyles'
import {
  Reveal,
  HeroStagger,
  HeroItem,
  MagneticButton,
  RotatingWord,
  StorefrontPreview,
  StepClip,
} from './LandingMotion'

export default function Landing() {
  const { t, lang } = useSession()
  const { pricing } = usePlatformPricing()
  useTopOnRouteChange()

  // The hero's rotating word, resolved to the showing language. Memoised so a new array identity
  // does not defeat RotatingWord's memo on every Landing re-render (menu open…).
  const verticalWords = useMemo(
    () => VERTICALS.map((v) => (lang === 'zh' ? v.zh : v.en)),
    [lang]
  )

  return (
    // Keep mm-land class — body:has(.mm-land) in index.css resets body padding/alignment
    <div className="mm-land relative isolate flex flex-col items-stretch min-h-screen font-sans text-foreground bg-background">

      <MarketingNav />
      <main className="flex-1 flex flex-col items-stretch">

      {/* ── Hero ── */}
      <section className="max-w-[700px] mx-auto px-8 pt-20 pb-16 text-center max-[600px]:px-5 max-[600px]:pt-12 max-[600px]:pb-10">
        <HeroStagger>
          <HeroItem>
            <p className="font-heading italic text-[15px] text-muted-foreground mb-5">
              {t('We know what it\'s like to run a business out of your DMs.', '我们懂，用聊天窗口接单有多累。')}
            </p>
          </HeroItem>
          {/* `instant`: this is the page's LCP element and it is already in the prerendered HTML.
              Fading it in would move largest-contentful-paint to the end of the fade — 842ms of
              the measured 999ms. See HeroStagger in LandingMotion.tsx. */}
          <HeroItem instant>
            {/* aria-label carries the sentence as one static string: the visible word changes every
                2.6s, and a screen reader re-announcing the h1 that often is noise. It also
                overrides descendant content for the accessible name, so nothing inside needs
                aria-hidden. Keep it in sync with the visible halves below. */}
            <h1
              aria-label={t(
                'Sell your food online — your own shop, without the DM chaos.',
                '把美食搬到线上——你的专属店铺，告别聊天接单的混乱。'
              )}
              className="font-heading text-[clamp(2rem,5vw,3.5rem)] font-medium text-foreground leading-[1.18] tracking-[-0.01em] mb-5"
            >
              {/* Two blocks, not one flowing sentence: the rotating word's width changes as it
                  cycles, and confining it to its own line is what keeps that from rewrapping the
                  static half every 2.6 seconds. Each clause is short enough to hold one line down
                  to 375px. English needs nothing after the word; Chinese needs its verb phrase. */}
              <span className="block">
                {t('Sell your ', '把')}
                <RotatingWord words={verticalWords} />
                {t('', '搬到线上——')}
              </span>
              <span className="block">
                {/* The English half opens with a space that renders as nothing — a block start
                    collapses it — but survives into the markup, so a crawler concatenating the two
                    blocks reads "Sell your food online", not "foodonline". Chinese needs no space
                    and must not get one. */}
                {t(' online — your own shop, without the DM chaos.', '你的专属店铺，告别聊天接单的混乱。')}
              </span>
            </h1>
          </HeroItem>
          <HeroItem>
            <p className="text-base leading-[1.7] text-ink-700 max-w-[560px] mx-auto mb-9">
              {t(
                'Orders get lost across chats and screenshots. TinyOrder gives you one branded storefront link — so every order lands in one place and you look the part.',
                '订单散落在各种聊天和截图里。TinyOrder 给你一个专属店面链接——所有订单集中一处，让你更专业。'
              )}
            </p>
          </HeroItem>
          <HeroItem>
            <div className="flex gap-4 justify-center flex-wrap max-[600px]:flex-col max-[600px]:items-center">
              <MagneticButton to="/merchant/signup" className={ctaPrimary} cta="hero">
                {t('Start your shop', '开始建店')}
              </MagneticButton>
              {/* Points at a dedicated preview page (/sample-shops), never at a live storefront —
                  the old version of this button linked straight into `/s/bitetime-co` and
                  customers placed real orders on it (fcd0a57). See SampleShopsPage.tsx. */}
              <Link to="/sample-shops" className={ctaGhost}>
                {t('See sample shops', '看看示例店铺')}
              </Link>
            </div>
          </HeroItem>
          <HeroItem>
            <p className="mt-6 mb-12 text-[13px] text-muted-foreground">
              {t('Made for home-run and small businesses.', '专为家庭与小型生意打造。')}
            </p>
          </HeroItem>
          <HeroItem>
            <StorefrontPreview t={t} />
          </HeroItem>
        </HeroStagger>
      </section>

      {/* ── How it works ── */}
      <section className="bg-card border-y border-border px-8 py-16 max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
        <h2 className={sectionTitle}>
          {t('Three steps to start your shop and take your first order', '三步开店，收到第一笔订单')}
        </h2>
        {/* One row per step, image beside text, sides alternating. NOT three columns: these are
            screenshots of dense screens — a product table three-across is about 200px wide, which
            is unreadable, and an unreadable screenshot is decoration rather than proof.
            Below 820px the row stacks, text first, so a phone reads the step before it sees it.

            The column template FLIPS with the row, it does not just reorder. `order` moves the
            image across but leaves the track widths where they are, so on every second row the
            image landed in the narrower text column and rendered visibly smaller than its
            neighbours — three screenshots at two sizes, which reads as a mistake. The image keeps
            the wider track in both directions. */}
        <ol className="list-none max-w-[920px] mx-auto flex flex-col gap-14 p-0 m-0 max-[820px]:gap-10">
          {STEPS.map((step, i) => (
            <li
              key={step.n}
              className={cn(
                'grid items-center gap-10 max-[820px]:grid-cols-1 max-[820px]:gap-5',
                i % 2 === 1
                  ? 'grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]'
                  : 'grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)]',
              )}
            >
              <div className={cn(i % 2 === 1 && 'min-[821px]:order-2')}>
                <span className="font-heading text-[28px] font-medium text-border leading-none block mb-2">
                  {step.n}
                </span>
                <h3 className="font-heading text-[19px] font-semibold text-primary leading-[1.3] m-0 mb-2">
                  {t(step.title.en, step.title.zh)}
                </h3>
                <p className="text-[15px] leading-[1.6] text-ink-700 m-0">
                  {t(step.body.en, step.body.zh)}
                </p>
              </div>
              <StepClip
                src={`/images/steps/${step.file}-${lang}.mp4`}
                poster={`/images/steps/${step.file}-${lang}.webp`}
                label={t(step.alt.en, step.alt.zh)}
                className="block w-full h-auto rounded-2xl border-[0.5px] border-border shadow-elev-3"
              />
            </li>
          ))}
        </ol>
        </Reveal>
      </section>

      {/* ── Value props ── */}
      <section className="px-8 py-16 max-w-[860px] mx-auto w-full max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
        <h2 className={sectionTitle}>
          {t('Built for small businesses that sell direct', '专为直接面向顾客的小生意打造')}
        </h2>
        <p className="-mt-6 mb-10 text-[15px] leading-[1.75] text-ink-700 text-center max-w-[560px] mx-auto">
          {t(
            'TinyOrder is for people who make and sell their own things — no website, designer or developer needed. If you can share a link, you can take orders online.',
            'TinyOrder 是为自己做、自己卖的人打造的——不需要网站、设计师或工程师，只要会分享链接，就能在线接单。',
          )}
        </p>
        {/* The icons are decoration and every one is aria-hidden: the <dt> under it already says
            what it says, and a screen reader announcing "hand coins" before the heading is noise. */}
        <dl className="grid [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))] gap-x-12 gap-y-10 max-[600px]:[grid-template-columns:1fr] max-[600px]:gap-8">
          <div>
            <HandCoins size={22} strokeWidth={1.5} className="text-primary mb-3" aria-hidden />
            <dt className="font-heading text-[19px] font-semibold text-primary leading-[1.3] mb-2.5">{t('Keep what you earn', '赚的钱，都是你的')}</dt>
            <dd className="text-sm leading-[1.65] text-ink-700 m-0">{t('Your own link, your own customers — no marketplace cut, no competitor beside your listing.', '专属链接，专属顾客——没有平台抽成，也没有人在你旁边抢单。')}</dd>
          </div>
          <div>
            <ListChecks size={22} strokeWidth={1.5} className="text-primary mb-3" aria-hidden />
            <dt className="font-heading text-[19px] font-semibold text-primary leading-[1.3] mb-2.5">{t('Nothing slips through', '一单都不会漏')}</dt>
            <dd className="text-sm leading-[1.65] text-ink-700 m-0">{t('Every order in one list. Mark it done in one tap — no scrolling through chats.', '所有订单集中一处。一键标记完成，不必再翻聊天记录。')}</dd>
          </div>
          <div>
            <Languages size={22} strokeWidth={1.5} className="text-primary mb-3" aria-hidden />
            <dt className="font-heading text-[19px] font-semibold text-primary leading-[1.3] mb-2.5">{t('Your customers read it in their own language', '顾客用自己的语言下单')}</dt>
            <dd className="text-sm leading-[1.65] text-ink-700 m-0">{t('Your shop shows in English or Chinese, whichever your customer prefers — write it once.', '店铺自动以中文或英文呈现，你只需写一次。')}</dd>
          </div>
        </dl>
        {/* The link out to /features, which used to close a separate "What you get" section below
            this one. That section re-argued what these three items already argue — it listed
            FEATURES.slice(0, 3) under a heading meaning the same thing as this one — so it is
            gone and its one load-bearing part, the internal link, moved here. */}
        <p className="mt-10 mb-0 text-center text-[13px] text-muted-foreground">
          <Link to="/features" className="underline underline-offset-4 hover:text-primary">
            {t('See all features', '查看全部功能')}
          </Link>
        </p>
        </Reveal>
      </section>

      {/* ── Pricing summary ── */}
      {/* A SUMMARY, and the full card + billing toggle stay on /pricing (#169). Both pages showing
          the same card would be two URLs answering "what does TinyOrder cost" — they compete with
          each other and split whatever authority either has, which is the argument canonicalPath()
          already makes about the signup CTAs.

          The PRICE stays here even so. It is the objection this section exists to answer, and a
          pricing section that makes you click to see a number is the pattern every visitor has
          learned means "expensive".

          Three things this section carries that the pre-#222 version did not, all of them fallout
          from the second plan going away:

          NO BOX. A bordered card is a comparison device; with one plan there is nothing on the
          other side of it, so the box was a 320px column of decoration inside a 720px section. The
          section's own border-t frames it.

          FOUR FEATURES, sliced from the shared tier — never retyped here, or the landing page and
          /pricing quietly disagree about what a shop gets (see pricingTiers.ts). Four is the
          summary; the remaining three and the full list are the reason to click through. Without
          them the section claimed "everything included" twice and named nothing.

          A CTA. The reader who has just accepted the price is the readiest reader on the page, and
          until now the only thing to click was a link to a different page. */}
      {/* bg-card, the same band as "How it works" — the page ran three plain sections deep here
          ("What you get", pricing, FAQ) and the conversion section was the one carrying the least
          weight of the three. Not bg-brand-100: that tint belongs to the footer CTA, and a second
          one this close stops the closing CTA reading as the end. No bottom border either — the
          FAQ's own border-t closes the band, and two adjacent hairlines render as a 2px line.

          The band is full-bleed and the measure sits in a wrapper inside it, the same shape as
          "How it works": the section carries the ground, the content carries its own width. */}
      <section id="pricing" className="bg-card border-t border-border px-8 py-16 max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
        <div className="max-w-[720px] mx-auto w-full text-center">
        <h2 className={sectionTitle}>
          {t('Simple, honest pricing — start free', '简单透明的价格——免费开始')}
        </h2>
        {/* The trial is NOT repeated here — it sits at the click, under the button, where it is
            risk reversal instead of a claim. This line carries the other objection instead. */}
        <p className="-mt-7 mb-9 text-[15px] leading-[1.6] text-ink-700">
          {t('One plan, everything included — and no commission on your orders.', '一个方案，功能全包含——而且不抽订单佣金。')}
        </p>

        <div className="flex items-baseline justify-center gap-[0.35rem]">
          <span className="font-heading text-[42px] font-semibold text-primary leading-none max-[600px]:text-[36px]">
            {formatMoney(pricing.prices.pro.monthly, pricing.currency)}
          </span>
          <span className="text-sm text-muted-foreground">{t('/mo', '/月')}</span>
        </div>
        {pricing.estimate && (
          <p className="mt-2 mb-0 text-xs text-muted-foreground">
            ≈ {formatMoney(pricing.prices.pro.monthly * pricing.estimate.rate, pricing.estimate.currency)}{t('/mo', '/月')}
          </p>
        )}
        {/* The yearly deal as the amount, not as arithmetic the reader has to do. Both halves come
            off the same fetched pricing, so nothing here can drift from Stripe. */}
        <p className="mt-2 mb-0 text-[13px] text-muted-foreground">
          {t(
            `or ${formatMoney(pricing.prices.pro.yearly, pricing.currency)} a year — two months free`,
            `或 ${formatMoney(pricing.prices.pro.yearly, pricing.currency)}/年——免费两个月`,
          )}
        </p>

        <ul className="list-none max-w-[380px] mx-auto mt-8 mb-8 p-0 flex flex-col gap-[0.6rem] text-left">
          {PRICING_TIERS[0].features.slice(0, 4).map((f, i) => (
            <li
              key={i}
              className="relative pl-6 text-sm leading-[1.5] text-foreground before:content-['✓'] before:absolute before:left-0 before:text-primary before:font-semibold"
            >
              {t(f.en, f.zh)}
            </li>
          ))}
        </ul>

        <MagneticButton to="/merchant/signup" className={ctaPrimary} cta="pricing-section">
          {t(PRICING_TIERS[0].cta.en, PRICING_TIERS[0].cta.zh)}
        </MagneticButton>
        <p className="mt-2.5 mb-0 text-xs text-muted-foreground">
          {t(PRICING_TIERS[0].note.en, PRICING_TIERS[0].note.zh)}
        </p>

        <p className="mt-8 mb-0 text-[13px] text-muted-foreground">
          <Link to="/pricing" className="underline underline-offset-4 hover:text-primary">
            {t('See everything that is included', '查看包含的全部功能')}
          </Link>
        </p>
        <p className="mt-2 mb-0 text-[13px] text-muted-foreground">
          {t('Cancel anytime — no contracts, no lock-in.', '随时取消——无合约，不绑定。')}
        </p>
        </div>
        </Reveal>
      </section>

      {/* ── FAQ ── */}
      {/* After pricing and before the closing CTA: a reader who has just seen a price is
          exactly the reader with objections. The full accordion, same as /faq (#169) — a teaser
          with no answers on it wasn't doing its job of handling objections right where they come
          up. The FAQPage structured data stays exclusive to /faq (structuredData.ts) so this
          section carries the same words without a second, competing copy of the schema. */}
      <section id="faq" className="border-t border-border px-8 py-16 max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
          <h2 className="font-heading text-[26px] text-primary text-center mb-2 max-[600px]:text-[22px]">
            {t('Questions from shop owners, answered', '店主常见问题')}
          </h2>
          <p className="text-sm text-muted-foreground text-center mb-9 max-w-[460px] mx-auto">
            {t(
              'The things shop owners ask us before they sign up.',
              '店主在注册前最常问我们的问题。',
            )}
          </p>
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

      {/* ── Footer CTA ── */}
      <section className="border-t border-border px-8 py-16 text-center bg-brand-100 max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
        {/* The section's thesis line, so it is the section's heading — a closing CTA with no
            heading is a hole in the outline, not a style choice. Styling is unchanged. */}
        <h2 className="text-sm leading-[1.6] font-sans font-normal text-muted-foreground mb-3">
          {t('Every order lost in a chat thread is a sale you\'ll never see.', '每一笔淹没在聊天里的订单，都是流失的生意。')}
        </h2>
        <p className="font-heading italic text-[18px] text-foreground mb-6 max-w-[520px] mx-auto">
          {t('Become a real, professional business — orders in one place, more time to make.', '成为真正专业的生意——订单集中一处，专注做好产品。')}
        </p>
        <MagneticButton to="/merchant/signup" className={ctaPrimary} cta="closing">
          {t('Start your shop', '开始建店')}
        </MagneticButton>
        </Reveal>
      </section>

      </main>
      <MarketingFooter />
    </div>
  )
}
