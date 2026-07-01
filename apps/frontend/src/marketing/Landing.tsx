import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '../SessionContext'
import { signOut } from '../store'
import LanguageSelect from '../components/LanguageSelect'
import { Button } from '../components/ui/button'
import { cn } from '../lib/utils'

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
  const [menuOpen, setMenuOpen] = useState(false)
  const [billing, setBilling] = useState('monthly') // 'monthly' | 'yearly'

  // Where the signed-in user's portal lives, by role. Customers have no portal.
  const portal = role === 'superadmin'
    ? { to: '/admin', label: t('Admin', '管理后台') }
    : role === 'merchant'
      ? { to: '/merchant', label: t('My dashboard', '我的后台') }
      : null

  // Pricing tiers. yearly = 10× monthly (2 months free).
  const tiers = [
    {
      id: 'basic',
      name: t('Basic', '基础版'),
      monthly: 9.99,
      yearly: 99.90,
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
      monthly: 39.99,
      yearly: 399.90,
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
    <div className="mm-land flex flex-col items-stretch min-h-screen font-sans text-ink bg-cream">

      {/* ── Nav bar ── */}
      <nav className="flex items-center justify-between px-8 py-5 border-b border-clay-border max-[600px]:px-5 max-[600px]:py-4">
        <span className="font-heading text-[22px] font-medium text-oxblood tracking-[0.3px]">
          BiteTime
        </span>
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
        <p className="font-heading italic text-[15px] text-rose-muted mb-5 motion-safe:[animation:mm-fadein_0.6s_ease_both]">
          {t('Your own online shop, in minutes.', '几分钟内，拥有属于你的网店。')}
        </p>
        <h1 className="font-heading text-[clamp(2rem,5vw,3.5rem)] font-medium text-ink leading-[1.18] tracking-[-0.01em] mb-5 motion-safe:[animation:mm-fadein_0.6s_ease_0.1s_both]">
          {t('Run your bakery online — beautifully.', '让你的烘焙小店，在线开业。')}
        </h1>
        <p className="text-base leading-[1.7] text-ink-soft max-w-[560px] mx-auto mb-9 motion-safe:[animation:mm-fadein_0.6s_ease_0.2s_both]">
          {t(
            'BiteTime gives home cooks and small food businesses a branded storefront, product catalog, and order management — all in one link you can share with anyone.',
            'BiteTime 为家厨与小型食品业者提供专属店面链接、产品目录与订单管理，一个链接搞定一切。'
          )}
        </p>
        <div className="flex gap-4 justify-center flex-wrap max-[600px]:flex-col max-[600px]:items-center motion-safe:[animation:mm-fadein_0.6s_ease_0.3s_both]">
          <Link to="/merchant/signup" className={ctaPrimary}>
            {t('Start your shop', '开始建店')}
          </Link>
          <Link to="/merchant/login" className={ctaGhost}>
            {t('Merchant log in', '商家登录')}
          </Link>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="bg-surface-raised border-y border-clay-border px-8 py-16 max-[600px]:px-5 max-[600px]:py-10">
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
      </section>

      {/* ── Value props ── */}
      <section className="px-8 py-16 max-w-[860px] mx-auto w-full max-[600px]:px-5 max-[600px]:py-10">
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
            <dd className="text-sm leading-[1.65] text-ink-soft m-0">{t('Your storefront speaks both English and Chinese — perfect for Malaysian food businesses.', '店面自动支持中英文，专为马来西亚小食企业设计。')}</dd>
          </div>
        </dl>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" className="px-8 py-16 max-w-[1000px] mx-auto w-full text-center border-t border-clay-border">
        <h2 className={sectionTitle}>
          {t('Simple, honest pricing', '简单透明的价格')}
        </h2>
        <p className="-mt-7 mb-8 text-[15px] leading-[1.6] text-ink-soft">
          {t('Start free. Upgrade when your shop grows.', '免费开始，店铺成长后再升级。')}
        </p>

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
        <div className="grid [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))] gap-6 mt-10 text-left">
          {tiers.map(tier => {
            const price = (billing === 'yearly' ? tier.yearly / 12 : tier.monthly).toFixed(2)
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
                  <span className="font-heading text-[34px] font-semibold text-oxblood leading-none">USD {price}</span>
                  <span className="text-sm text-rose-muted">{t('/mo', '/月')}</span>
                </div>
                <p className="min-h-[1.1em] text-xs text-rose-muted mt-[0.35rem] mb-0">
                  {billing === 'yearly' && Number(price) > 0
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
      </section>

      {/* ── Footer CTA ── */}
      <section className="border-t border-clay-border px-8 py-16 text-center bg-oxblood-tint max-[600px]:px-5 max-[600px]:py-10">
        <p className="font-heading italic text-[18px] text-ink mb-6">
          {t('Ready to take your first order?', '准备好接收你的第一笔订单了吗？')}
        </p>
        <Link to="/merchant/signup" className={ctaPrimary}>
          {t('Start your shop — it\'s free', '立即建店，免费开始')}
        </Link>
      </section>

      {/* ── Footer ── */}
      <footer className="mt-auto px-8 py-6 border-t border-clay-border flex items-center justify-center gap-3 text-[13px] text-text-tertiary">
        <span className="font-heading text-oxblood font-medium">BiteTime</span>
        <span className="text-clay-border">·</span>
        <span>{t('Built for Malaysian food businesses', '专为马来西亚食品业者打造')}</span>
      </footer>
    </div>
  )
}
