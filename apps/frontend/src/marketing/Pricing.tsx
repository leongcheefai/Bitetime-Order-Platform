// /pricing — the plan in full.
//
// A page of its own rather than a section of the landing page (#169). The landing page keeps a
// summary and links here; this page owns the detail, so the two are not two URLs answering the
// same query. Its `<title>` and `<meta name="description">` come from ROUTE_META and are baked
// into dist/pricing.html by scripts/prerender.tsx — which is the whole mechanism: a sitelink's
// label IS the target page's title, and until this route existed the site had exactly one.
//
// NO FAQ HERE, on purpose. /faq's accordion answers the billing questions already and carries the
// FAQPage markup (its own split off the landing page, same #169); repeating those answers here
// would be the duplication this split exists to avoid. The prose below is written for this page
// and appears on no other.

import { Link } from 'react-router-dom'
import { useSession } from '../SessionContext'
import { MarketingNav, MarketingFooter } from './MarketingChrome'
import { useTopOnRouteChange } from './useTopOnRouteChange'
import PricingCards from './PricingCards'
import { INCLUDED_GROUPS } from './pricingTiers'
import { ctaPrimary, sectionTitle } from './ctaStyles'
import { Reveal } from './LandingMotion'

export default function Pricing() {
  const { t } = useSession()
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
          {t(
            'One flat price. No commission on a single order.',
            '固定价格。订单一分钱都不抽成。',
          )}
        </h1>
        <p className="text-base leading-[1.75] text-ink-700 max-w-[580px] mx-auto mb-4">
          {t(
            'You pay a subscription and nothing else — the month your shop does well is the month you keep the difference. Every shop starts with seven free days, and we ask for no card to begin.',
            '你只需支付订阅费，不再有其他费用——生意好的那个月，多出来的部分全归你。每家店铺都有七天免费期，开始时无需信用卡。',
          )}
        </p>
      </section>

      {/* ── The plan ── */}
      <section className="px-8 pb-16 max-w-[1000px] mx-auto w-full max-[600px]:px-5 max-[600px]:pb-10">
        <PricingCards />
      </section>

      {/* ── What is included ── */}
      {/* The detail the landing summary does not carry, and the reason a visitor clicks through.
          Rows come from pricingTiers.ts, where each one is checked against what the product
          actually does — a line here the software does not do is a refund request. */}
      <section className="border-t border-border px-8 py-16 max-w-[860px] mx-auto w-full max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
          <h2 className={sectionTitle}>
            {t('What is included', '包含什么')}
          </h2>
          {/* One panel on bg-card, not rows laid straight on the page. This list is a spec sheet —
              a single object a reader scans top to bottom — and on the page's own ground it had no
              edges to say where it started or stopped. bg-card is the surface the plan card above
              already uses, so the two read as the same kind of thing. */}
          <div className="flex flex-col gap-8 mt-2 rounded-xl bg-card border-[0.5px] border-border p-8 shadow-[0_6px_24px_rgba(122,16,40,0.06)] max-[600px]:p-5 max-[600px]:gap-7">
            {INCLUDED_GROUPS.map(group => (
              <div key={group.id}>
                <h3 className="font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-3">
                  {t(group.label.en, group.label.zh)}
                </h3>
                <ul className="flex flex-col gap-2.5 list-none m-0 p-0">
                  {group.rows.map(row => (
                    // last:border-b-0 — a rule under the final row of a group is a line with
                    // nothing under it, which read as the group having lost a row.
                    <li
                      key={row.id}
                      className="flex items-baseline gap-2 border-b border-border pb-2.5 last:border-b-0 last:pb-0 text-sm leading-[1.55]"
                    >
                      {/* aria-hidden and paired with nothing: every row in this list is included,
                          so the glyph is decoration and a screen reader announcing "included"
                          fifteen times would be noise, not information. */}
                      <span aria-hidden="true" className="text-primary font-semibold shrink-0">✓</span>
                      <span className="text-foreground">{t(row.label.en, row.label.zh)}</span>
                      {row.detail && (
                        <span className="ml-auto pl-4 text-right text-ink-700">
                          {t(row.detail.en, row.detail.zh)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      {/* ── How billing works ── */}
      {/* Prose, not cards: this is one explanation in four moves, and every claim here is enforced
          somewhere real — the trial in signup, the proration rule in the subscription
          handling, the currency in the platform pricing endpoint. */}
      <section className="border-t border-border px-8 py-16 max-w-[720px] mx-auto w-full max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
          <h2 className={sectionTitle}>
            {t('How billing works', '扣款方式')}
          </h2>
          <div className="flex flex-col gap-5 text-[15px] leading-[1.75] text-ink-700">
            <p className="m-0">
              {t(
                'Every shop starts with seven free days and we ask for no card. The clock starts when you sign up, and your shop is open from that moment. We remind you before it ends. If you decide not to continue, it stops on its own and you are never charged.',
                '每家店铺都有七天免费期，且无需绑定信用卡。计时从你注册那一刻开始，店铺也同时开放。结束前我们会提醒你。若决定不继续，试用期结束即自动停止，不会产生任何费用。',
              )}
            </p>
            <p className="m-0">
              {t(
                'Yearly is billed once at ten months\' worth, so two months are free, and the price shown above is what that works out to per month. Monthly and yearly buy exactly the same thing; the only difference is when you pay for it.',
                '年付一次收取相当于十个月的费用，等于免费两个月，上方显示的价格即为折算后的月费。月付与年付买到的功能完全相同，差别只在付款时机。',
              )}
            </p>
            <p className="m-0">
              {t(
                'Cancel any time from your dashboard. Your shop keeps working to the end of the period you have already paid for and is not billed again. We do not refund part of a period, so the tidy time to cancel is just before your billing date.',
                '随时可在仪表板取消。已付费的周期内店铺照常运作，之后不再扣款。我们不退还周期内的部分费用，因此最划算的取消时机是扣款日之前。',
              )}
            </p>
          </div>
        </Reveal>
      </section>

      {/* ── What we do not charge for ── */}
      {/* The competitive argument, stated once and only here. The landing page's "what it replaces"
          section makes the same point about marketplaces in passing; this is the version a visitor
          comparing two prices came to read. */}
      <section className="border-t border-border px-8 py-16 max-w-[720px] mx-auto w-full max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
          <h2 className={sectionTitle}>
            {t('What we do not charge for', '我们不收费的部分')}
          </h2>
          <div className="flex flex-col gap-5 text-[15px] leading-[1.75] text-ink-700">
            <p className="m-0">
              {t(
                'No commission, on any order, ever. A marketplace takes a percentage of every sale for as long as you use it, which means the better your shop does the more it costs you. Your subscription here is the same number whether you take four orders this month or four hundred.',
                '任何订单都不抽佣金，永远如此。外卖平台只要你还在用，就会从每一笔销售抽成——生意越好，付得越多。在这里，无论这个月是四张单还是四百张单，订阅费都是同一个数字。',
              )}
            </p>
            <p className="m-0">
              {t(
                'No payment fees from us, because the money never comes to us. Your customers pay you directly — you show your bank details or payment instructions on your storefront and the amount lands in your account. The subscription is the only thing you pay TinyOrder.',
                '我们不收取任何支付手续费，因为货款根本不经我们的手。顾客直接付款给你——你在店面页面展示银行账号或付款说明，款项直接进你的账户。你付给 TinyOrder 的只有订阅费。',
              )}
            </p>
            <p className="m-0">
              {t(
                'No setup fee, no per-product fee, no charge for a second language. Prices are billed in Malaysian ringgit wherever you are; if your currency is different we show an approximate conversion next to the price so you know roughly what your bank will take.',
                '没有开通费、没有单品费用，第二语言也不额外收费。无论你在哪里，都以马币计价；若你使用其他货币，我们会在价格旁附上约略换算，让你大致知道银行会扣多少。',
              )}
            </p>
          </div>
        </Reveal>
      </section>

      {/* ── Closing CTA ── */}
      <section className="border-t border-border px-8 py-16 text-center bg-brand-100 max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
          <h2 className="font-heading italic text-[18px] text-foreground mb-6 max-w-[520px] mx-auto">
            {t(
              'Seven days, no card, and your own shop at the end of it.',
              '七天免费，无需信用卡，结束时你已经有了自己的店。',
            )}
          </h2>
          <Link to="/merchant/signup" className={ctaPrimary} data-cta="pricing-page">
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
