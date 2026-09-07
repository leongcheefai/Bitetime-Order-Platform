// The plan card and the monthly/yearly toggle — the full treatment, which lives on /pricing.
//
// The landing page deliberately does NOT render this. It carries a short summary that links here
// instead, because two pages showing the same card are two URLs competing for the same query,
// which splits whatever authority either has — the same argument canonicalPath() makes about the
// signup CTAs (#169).

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '../SessionContext'
import { usePlatformPricing } from '../usePlatformPricing'
import { formatMoney } from '../currency'
import { PRICING_TIERS } from './pricingTiers'
import { cardCtaPrimary } from './ctaStyles'
import { cn } from '../lib/utils'
import { Reveal } from './LandingMotion'
import { Button } from '../components/ui/button'

export default function PricingCards() {
  const { t } = useSession()
  const { pricing } = usePlatformPricing()
  const [billing, setBilling] = useState<'monthly' | 'yearly'>('monthly')

  /* Geometry only — the fill comes from the variant (`default` when selected, `ghost` when
     not). The inactive text colour stays explicit because ghost's own muted-foreground is a
     step lighter than this control wants against the card it sits on. */
  const toggleButton = (value: 'monthly' | 'yearly') =>
    cn(
      'py-2 px-[18px] rounded-pill text-sm',
      billing === value ? '' : 'text-ink-700',
    )

  return (
    <div className="text-center">
      {/* Billing toggle */}
      <div
        className="inline-flex gap-1 p-1 border-[0.5px] border-border rounded-pill bg-card"
        role="group"
        aria-label={t('Billing period', '付费周期')}
      >
        <Button
          type="button"
          variant={billing === 'monthly' ? 'default' : 'ghost'}
          size="none"
          className={toggleButton('monthly')}
          aria-pressed={billing === 'monthly'}
          onClick={() => setBilling('monthly')}
        >
          {t('Monthly', '按月')}
        </Button>
        <Button
          type="button"
          variant={billing === 'yearly' ? 'default' : 'ghost'}
          size="none"
          className={toggleButton('yearly')}
          aria-pressed={billing === 'yearly'}
          onClick={() => setBilling('yearly')}
        >
          {t('Yearly', '按年')}
          <span
            className={cn(
              'text-[11px] font-medium py-[2px] px-2 rounded-pill',
              billing === 'yearly'
                ? 'bg-white/20 text-background'
                : 'bg-brand-100 text-primary'
            )}
          >
            {t('Save ~17%', '省约17%')}
          </span>
        </Button>
      </div>

      <Reveal>
        {/* One card, centred — the grid is gone with the second plan (#222). */}
        <div className="max-w-[420px] mx-auto mt-10 text-left">
          {PRICING_TIERS.map(tier => {
            const tierPrices = pricing.prices.pro
            // Yearly is billed at 10× monthly (2 months free) and shown as an effective /mo.
            const amount = billing === 'yearly' ? tierPrices.yearly / 12 : tierPrices.monthly
            return (
              <div
                key={tier.id}
                className="flex flex-col p-7 rounded-lg bg-card border-[0.5px] border-primary shadow-elev-3"
              >
                {tier.badge && (
                  <span className="self-start text-[11px] font-semibold py-[3px] px-[10px] mb-3 rounded-pill bg-primary text-primary-foreground">
                    {t(tier.badge.en, tier.badge.zh)}
                  </span>
                )}
                <h3 className="font-heading text-xl font-medium text-foreground m-0">
                  {t(tier.name.en, tier.name.zh)}
                </h3>
                <div className="flex items-baseline gap-[0.35rem] mt-3">
                  <span className="font-heading text-[34px] font-semibold text-primary leading-none">
                    {formatMoney(amount, pricing.currency)}
                  </span>
                  <span className="text-sm text-muted-foreground">{t('/mo', '/月')}</span>
                </div>
                {pricing.estimate && amount > 0 && (
                  <p className="text-xs text-muted-foreground mt-1 mb-0">
                    ≈ {formatMoney(amount * pricing.estimate.rate, pricing.estimate.currency)}{t('/mo', '/月')}
                  </p>
                )}
                <p className="min-h-[1.1em] text-xs text-muted-foreground mt-[0.35rem] mb-0">
                  {billing === 'yearly' && amount > 0 ? t('billed yearly', '按年付费') : ' '}
                </p>
                <p className="text-sm leading-[1.6] text-ink-700 mt-3 mb-5">
                  {t(tier.blurb.en, tier.blurb.zh)}
                </p>
                <ul className="list-none m-0 mb-7 p-0 flex flex-col gap-[0.6rem]">
                  {tier.features.map((f, i) => (
                    <li
                      key={i}
                      className="relative pl-6 text-sm leading-[1.5] text-foreground before:content-['✓'] before:absolute before:left-0 before:text-primary before:font-semibold"
                    >
                      {t(f.en, f.zh)}
                    </li>
                  ))}
                </ul>
                {/* A path segment, not `?billing=…`: this is the one CTA a crawler reads, and a
                    query string is what a link auditor and a human both score as an unfriendly
                    URL. It collapses to /merchant/signup in the canonical tag (canonical.ts), so
                    the form stays one indexed page. */}
                <Link to={`/merchant/signup/${billing}`} className={cardCtaPrimary} data-cta="pricing-card">
                  {t(tier.cta.en, tier.cta.zh)}
                </Link>
                {/* Risk reversal sits at the click, not at the foot of the section. */}
                <p className="mt-2.5 mb-0 text-center text-xs text-muted-foreground">
                  {t(tier.note.en, tier.note.zh)}
                </p>
              </div>
            )
          })}
        </div>
        <p className="mt-8 text-[13px] text-muted-foreground">
          {t('Cancel anytime — no contracts, no lock-in.', '随时取消——无合约，不绑定。')}
        </p>
      </Reveal>
    </div>
  )
}
