import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '../SessionContext'
import { signOut } from '../store'
import { usePlatformPricing } from '../usePlatformPricing'
import { formatMoney } from '../currency'
import LanguageSelect from '../components/LanguageSelect'
import Wordmark from '../components/Wordmark'
import { Button } from '../components/ui/button'
import { cn } from '../lib/utils'
import {
  GrainOverlay,
  Reveal,
  HeroStagger,
  HeroItem,
  MagneticButton,
  StorefrontPreview,
} from './LandingMotion'

// Transitional (low-commitment) CTA target: a real storefront a hesitant
// merchant can preview before signing up. Swap the slug to change the demo shop.
const SAMPLE_SHOP_SLUG = 'bitetime'

// ── CTA class strings (reused across hero, pricing cards, footer) ─────────
const ctaPrimary =
  'inline-block py-[13px] px-7 bg-oxblood text-cream rounded-md text-[15px] font-medium font-sans no-underline [transition:background_0.15s,transform_0.15s] hover:bg-oxblood-deep hover:-translate-y-px'

const ctaGhost =
  'inline-block py-3 px-[26px] border-[1.5px] border-clay-border rounded-md text-[15px] font-medium font-sans text-ink-soft no-underline [transition:border-color_0.15s,color_0.15s] hover:border-oxblood hover:text-oxblood'

// Inside a flex-col card: push to bottom and centre text
const cardCtaPrimary = cn(ctaPrimary, 'mt-auto text-center')
const cardCtaGhost   = cn(ctaGhost,   'mt-auto text-center')

// Shared nav-link style (Pricing anchor + Merchant log in)
const navLink =
  'text-[13px] text-rose-muted no-underline font-medium [transition:color_0.15s] hover:text-oxblood'

// Account dropdown menu-item (Link or button)
const menuItem =
  'block w-full box-border text-left py-[9px] px-3 border-0 rounded-sm bg-transparent text-rose-muted text-[13px] font-sans font-medium no-underline cursor-pointer [transition:all_0.15s] hover:bg-oxblood-tint hover:text-oxblood'

// Section-heading (Steps + Pricing share the same style)
const sectionTitle =
  'font-heading text-2xl font-medium text-ink text-center mb-10'

export default function Landing() {
  const { t, account, role, loading } = useSession()
  const { pricing } = usePlatformPricing()
  const [menuOpen, setMenuOpen] = useState(false)
  const [billing, setBilling] = useState('monthly') // 'monthly' | 'yearly'

  // Where the signed-in user's portal lives, by role. Customers have no portal.
  const portal = role === 'superadmin'
    ? { to: '/admin', label: t('Admin', '管理后台') }
    : role === 'merchant'
      ? { to: '/merchant', label: t('My dashboard', '我的后台') }
      : null

  // Pricing tiers. Amounts come from the region-resolved backend pricing (`pricing`);
  // yearly is billed at 10× monthly (2 months free) and shown as an effective /mo.
  const tiers = [
    {
      id: 'basic',
      name: t('Basic', '基础版'),
      blurb: t('For getting started.', '适合刚起步的你。'),
      features: [
        t('1 shop', '1 间店铺'),
        t('Product catalog', '产品目录'),
        t('Order management', '订单管理'),
      ],
      cta: t('Start your shop', '开始建店'),
      to: '/merchant/signup',
      highlight: false,
    },
    {
      id: 'pro',
      name: 'Pro',
      blurb: t('For growing shops.', '为成长中的店铺打造。'),
      features: [
        t('Everything in Basic', '包含基础版所有功能'),
        t('Telegram + email alerts', 'Telegram + 邮件通知'),
        t('Vouchers & promotions', '优惠券与促销'),
        t('Custom shop link', '自定义店铺链接'),
        t('Multiple shops', '多间店铺'),
        t('Priority support', '优先客服支持'),
      ],
      cta: t('Start your shop', '开始建店'),
      to: '/merchant/signup',
      highlight: true,
      badge: t('Most popular', '最受欢迎'),
    },
  ]

  return (
    // Keep mm-land class — body:has(.mm-land) in index.css resets body padding/alignment
    <div className="mm-land relative isolate flex flex-col items-stretch min-h-screen font-sans text-ink bg-cream">
      <GrainOverlay />

      {/* ── Nav bar ── */}
      <nav className="flex items-center justify-between px-8 py-5 border-b border-clay-border max-[600px]:px-5 max-[600px]:py-4">
        <Wordmark className="h-7 max-[600px]:h-6" />
        <div className="flex items-center gap-5">
          <a href="#pricing" className={navLink}>
            {t('Pricing', '价格')}
          </a>
          <div className="flex justify-end gap-1.5">
            <LanguageSelect />
          </div>
          {loading ? null : account ? (
            <div className="relative">
              <Button
                type="button"
                variant="outline"
                size="pill"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(o => !o)}
              >
                {account.email}
              </Button>
              {menuOpen && (
                <>
                  {/* Transparent click-catcher overlay */}
                  <div
                    className="fixed inset-0 z-[var(--z-dropdown)]"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div
                    className="absolute top-[calc(100%+8px)] right-0 z-[var(--z-modal-popover)] min-w-[160px] bg-surface-high border-[1.5px] border-clay-border rounded-lg shadow-[0_8px_24px_rgba(43,10,16,0.16)] overflow-hidden p-1"
                    role="menu"
                  >
                    {portal && (
                      <Link
                        to={portal.to}
                        className={menuItem}
                        role="menuitem"
                        onClick={() => setMenuOpen(false)}
                      >
                        {portal.label}
                      </Link>
                    )}
                    <button
                      type="button"
                      className={menuItem}
                      role="menuitem"
                      onClick={async () => { setMenuOpen(false); await signOut() }}
                    >
                      {t('Sign out', '退出登录')}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <Link to="/merchant/login" className={navLink}>
              {t('Merchant log in', '商家登录')}
            </Link>
          )}
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="max-w-[700px] mx-auto px-8 pt-20 pb-16 text-center max-[600px]:px-5 max-[600px]:pt-12 max-[600px]:pb-10">
        <HeroStagger>
          <HeroItem>
            <p className="font-heading italic text-[15px] text-rose-muted mb-5">
              {t('We know what it\'s like to run a kitchen out of your DMs.', '我们懂，用聊天窗口接单有多累。')}
            </p>
          </HeroItem>
          <HeroItem>
            <h1 className="font-heading text-[clamp(2rem,5vw,3.5rem)] font-medium text-ink leading-[1.18] tracking-[-0.01em] mb-5">
              {t('Sell your food online — without the DM chaos.', '把美食搬到线上——告别聊天接单的混乱。')}
            </h1>
          </HeroItem>
          <HeroItem>
            <p className="text-base leading-[1.7] text-ink-soft max-w-[560px] mx-auto mb-9">
              {t(
                'Orders get lost across chats and screenshots. TinyOrder gives you one branded storefront link — so every order lands in one place and you look the part.',
                '订单散落在各种聊天和截图里。TinyOrder 给你一个专属店面链接——所有订单集中一处，让你更专业。'
              )}
            </p>
          </HeroItem>
          <HeroItem>
            <div className="flex gap-4 justify-center flex-wrap max-[600px]:flex-col max-[600px]:items-center">
              <MagneticButton to="/merchant/signup" className={ctaPrimary}>
                {t('Start your shop', '开始建店')}
              </MagneticButton>
              <Link to={`/s/${SAMPLE_SHOP_SLUG}`} className={ctaGhost}>
                {t('See a sample shop', '看看示例店铺')}
              </Link>
            </div>
          </HeroItem>
          <HeroItem>
            <p className="mt-6 mb-12 text-[13px] text-rose-muted">
              {t('Made for home kitchens and small food businesses.', '专为家厨与小型食品业者打造。')}
            </p>
          </HeroItem>
          <HeroItem>
            <StorefrontPreview t={t} />
          </HeroItem>
        </HeroStagger>
      </section>

      {/* ── How it works ── */}
      <section className="bg-surface-raised border-y border-clay-border px-8 py-16 max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
        <h2 className={sectionTitle}>
          {t('Three steps to your first order', '三步收到第一笔订单')}
        </h2>
        <ol className="list-none max-w-[620px] mx-auto flex flex-col gap-6 p-0 m-0">
          <li className="flex items-baseline gap-5 text-[15px] leading-[1.6] text-ink">
            <span className="font-heading text-[28px] font-medium text-clay-border leading-none shrink-0 w-9">01</span>
            <div>
              <strong className="text-oxblood font-semibold">{t('Create your shop', '创建你的店铺')}</strong>
              <span>{t(' — pick a name, describe what you bake.', '——取个名字，介绍你的产品。')}</span>
            </div>
          </li>
          <li className="flex items-baseline gap-5 text-[15px] leading-[1.6] text-ink">
            <span className="font-heading text-[28px] font-medium text-clay-border leading-none shrink-0 w-9">02</span>
            <div>
              <strong className="text-oxblood font-semibold">{t('Add your products', '添加产品')}</strong>
              <span>{t(' — set names, prices and delivery windows.', '——设置名称、价格与交货时间。')}</span>
            </div>
          </li>
          <li className="flex items-baseline gap-5 text-[15px] leading-[1.6] text-ink">
            <span className="font-heading text-[28px] font-medium text-clay-border leading-none shrink-0 w-9">03</span>
            <div>
              <strong className="text-oxblood font-semibold">{t('Share your link', '分享专属链接')}</strong>
              <span>{t(' — send /s/yourshop to customers; orders come straight to you.', '——将 /s/yourshop 发给顾客，订单直达你。')}</span>
            </div>
          </li>
        </ol>
        </Reveal>
      </section>

      {/* ── Value props ── */}
      <section className="px-8 py-16 max-w-[860px] mx-auto w-full max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
        <dl className="grid [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))] gap-x-12 gap-y-10 max-[600px]:[grid-template-columns:1fr] max-[600px]:gap-8">
          <div>
            <dt className="font-heading text-base font-medium text-ink mb-2">{t('Your own storefront link', '专属店面链接')}</dt>
            <dd className="text-sm leading-[1.65] text-ink-soft m-0">{t('Share a clean, branded URL — no marketplace fees, no listing competition.', '干净的品牌网址，无平台抽成，无竞争对手。')}</dd>
          </div>
          <div>
            <dt className="font-heading text-base font-medium text-ink mb-2">{t('Simple order management', '简洁订单管理')}</dt>
            <dd className="text-sm leading-[1.65] text-ink-soft m-0">{t('See every order at a glance. Update statuses and send tracking numbers with one tap.', '一目了然查看所有订单，一键更新状态与物流号。')}</dd>
          </div>
          <div>
            <dt className="font-heading text-base font-medium text-ink mb-2">{t('Bilingual, out of the box', '中英双语，开箱即用')}</dt>
            <dd className="text-sm leading-[1.65] text-ink-soft m-0">{t('Your storefront speaks both English and Chinese — perfect for bilingual food businesses.', '店面自动支持中英文，专为双语小食企业设计。')}</dd>
          </div>
        </dl>
        </Reveal>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" className="px-8 py-16 max-w-[1000px] mx-auto w-full text-center border-t border-clay-border">
        <Reveal>
        <h2 className={sectionTitle}>
          {t('Simple, honest pricing', '简单透明的价格')}
        </h2>
        <p className="-mt-7 mb-8 text-[15px] leading-[1.6] text-ink-soft">
          {t('Start with a 7-day free trial — no card required. Upgrade when your shop grows.', '7 天免费试用开始，无需信用卡，店铺成长后再升级。')}
        </p>
        </Reveal>

        {/* Billing toggle */}
        <div
          className="inline-flex gap-1 p-1 border-[1.5px] border-clay-border rounded-pill bg-surface-raised"
          role="group"
          aria-label={t('Billing period', '付费周期')}
        >
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-2 py-2 px-[18px] border-0 rounded-pill font-sans text-sm font-medium cursor-pointer [transition:background_0.15s,color_0.15s]',
              billing === 'monthly' ? 'bg-oxblood text-cream' : 'bg-transparent text-ink-soft'
            )}
            aria-pressed={billing === 'monthly'}
            onClick={() => setBilling('monthly')}
          >
            {t('Monthly', '按月')}
          </button>
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-2 py-2 px-[18px] border-0 rounded-pill font-sans text-sm font-medium cursor-pointer [transition:background_0.15s,color_0.15s]',
              billing === 'yearly' ? 'bg-oxblood text-cream' : 'bg-transparent text-ink-soft'
            )}
            aria-pressed={billing === 'yearly'}
            onClick={() => setBilling('yearly')}
          >
            {t('Yearly', '按年')}
            <span
              className={cn(
                'text-[11px] font-medium py-[2px] px-2 rounded-pill',
                billing === 'yearly'
                  ? 'bg-[rgba(255,255,255,0.2)] text-cream'
                  : 'bg-oxblood-tint text-oxblood'
              )}
            >
              {t('Save ~17%', '省约17%')}
            </span>
          </button>
        </div>

        {/* Pricing cards */}
        <Reveal>
        <div className="grid [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))] gap-6 mt-10 text-left">
          {tiers.map(tier => {
            const tierPrices = pricing.prices[tier.id as 'basic' | 'pro']
            const amount = billing === 'yearly' ? tierPrices.yearly / 12 : tierPrices.monthly
            return (
              <div
                key={tier.id}
                className={cn(
                  'flex flex-col p-7 rounded-lg bg-surface-raised',
                  tier.highlight
                    ? 'border-[1.5px] border-oxblood shadow-[0_6px_24px_rgba(122,16,40,0.12)]'
                    : 'border border-clay-border'
                )}
              >
                {tier.badge && (
                  <span className="self-start text-[11px] font-semibold py-[3px] px-[10px] mb-3 rounded-pill bg-oxblood text-cream">
                    {tier.badge}
                  </span>
                )}
                <h3 className="font-heading text-xl font-medium text-ink m-0">{tier.name}</h3>
                <div className="flex items-baseline gap-[0.35rem] mt-3">
                  <span className="font-heading text-[34px] font-semibold text-oxblood leading-none">{formatMoney(amount, pricing.currency)}</span>
                  <span className="text-sm text-rose-muted">{t('/mo', '/月')}</span>
                </div>
                {pricing.estimate && amount > 0 && (
                  <p className="text-xs text-rose-muted mt-1 mb-0">
                    ≈ {formatMoney(amount * pricing.estimate.rate, pricing.estimate.currency)}{t('/mo', '/月')}
                  </p>
                )}
                <p className="min-h-[1.1em] text-xs text-rose-muted mt-[0.35rem] mb-0">
                  {billing === 'yearly' && amount > 0
                    ? t('billed yearly', '按年付费')
                    : ' '}
                </p>
                <p className="text-sm leading-[1.6] text-ink-soft mt-3 mb-5">{tier.blurb}</p>
                <ul className="list-none m-0 mb-7 p-0 flex flex-col gap-[0.6rem]">
                  {tier.features.map((f, i) => (
                    <li
                      key={i}
                      className="relative pl-6 text-sm leading-[1.5] text-ink before:content-['✓'] before:absolute before:left-0 before:text-oxblood before:font-semibold"
                    >
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  to={`${tier.to}?plan=${tier.id}&billing=${billing}`}
                  className={tier.highlight ? cardCtaPrimary : cardCtaGhost}
                >
                  {tier.cta}
                </Link>
              </div>
            )
          })}
        </div>
        <p className="mt-8 text-[13px] text-rose-muted">
          {t('7-day free trial · No card required · Cancel anytime.', '7 天免费试用 · 无需信用卡 · 随时取消。')}
        </p>
        </Reveal>
      </section>

      {/* ── Footer CTA ── */}
      <section className="border-t border-clay-border px-8 py-16 text-center bg-oxblood-tint max-[600px]:px-5 max-[600px]:py-10">
        <Reveal>
        <p className="text-sm leading-[1.6] text-rose-muted mb-3">
          {t('Every order lost in a chat thread is a sale you\'ll never see.', '每一笔淹没在聊天里的订单，都是流失的生意。')}
        </p>
        <p className="font-heading italic text-[18px] text-ink mb-6 max-w-[520px] mx-auto">
          {t('Become a real, professional food business — orders in one place, more time to bake.', '成为真正专业的美食生意——订单集中一处，专注烘焙。')}
        </p>
        <MagneticButton to="/merchant/signup" className={ctaPrimary}>
          {t('Start your free trial', '开始免费试用')}
        </MagneticButton>
        </Reveal>
      </section>

      {/* ── Footer ── */}
      <footer className="mt-auto px-8 py-6 border-t border-clay-border flex items-center justify-center gap-3 text-[13px] text-text-tertiary">
        <Wordmark className="h-[18px]" />
        <span className="text-clay-border">·</span>
        <span>{t('Built for food businesses', '专为食品业者打造')}</span>
      </footer>
    </div>
  )
}
