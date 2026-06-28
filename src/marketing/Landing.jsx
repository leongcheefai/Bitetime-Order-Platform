import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '../SessionContext'
import { signOut } from '../store'

export default function Landing() {
  const { t, lang, setLang, account, role, loading } = useSession()
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
        t('Telegram + email alerts', 'Telegram + 邮件通知'),
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
    <div className="mm-land">
      {/* ── Nav bar ── */}
      <nav className="mm-land-nav">
        <span className="mm-land-wordmark">BiteTime</span>
        <div className="mm-land-nav-right">
          <a href="#pricing" className="mm-land-login-link mm-land-nav-pricing">
            {t('Pricing', '价格')}
          </a>
          <div className="lang-switcher mm-land-lang">
            <button
              className={`lang-btn${lang === 'en' ? ' active' : ''}`}
              aria-pressed={lang === 'en'}
              onClick={() => setLang('en')}
            >EN</button>
            <button
              className={`lang-btn${lang === 'zh' ? ' active' : ''}`}
              aria-pressed={lang === 'zh'}
              onClick={() => setLang('zh')}
            >中文</button>
          </div>
          {loading ? null : account ? (
            <div className="mm-land-account">
              <button
                type="button"
                className="cust-account-btn"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(o => !o)}
              >
                {account.email}
              </button>
              {menuOpen && (
                <>
                  <div className="mm-menu-overlay" onClick={() => setMenuOpen(false)} />
                  <div className="mm-account-menu" role="menu">
                    {portal && (
                      <Link to={portal.to} className="mm-account-menu-item" role="menuitem" onClick={() => setMenuOpen(false)}>
                        {portal.label}
                      </Link>
                    )}
                    <button
                      type="button"
                      className="mm-account-menu-item"
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
            <Link to="/merchant/login" className="mm-land-login-link">
              {t('Merchant log in', '商家登录')}
            </Link>
          )}
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="mm-land-hero">
        <p className="mm-land-eyebrow">
          {t('Your own online shop, in minutes.', '几分钟内，拥有属于你的网店。')}
        </p>
        <h1 className="mm-land-headline">
          {t('Run your bakery online — beautifully.', '让你的烘焙小店，在线开业。')}
        </h1>
        <p className="mm-land-subhead">
          {t(
            'BiteTime gives home cooks and small food businesses a branded storefront, product catalog, and order management — all in one link you can share with anyone.',
            'BiteTime 为家厨与小型食品业者提供专属店面链接、产品目录与订单管理，一个链接搞定一切。'
          )}
        </p>
        <div className="mm-land-ctas">
          <Link to="/merchant/signup" className="mm-land-cta-primary">
            {t('Start your shop', '开始建店')}
          </Link>
          <Link to="/merchant/login" className="mm-land-cta-ghost">
            {t('Merchant log in', '商家登录')}
          </Link>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="mm-land-steps">
        <h2 className="mm-land-steps-title">
          {t('Three steps to your first order', '三步收到第一笔订单')}
        </h2>
        <ol className="mm-land-step-list">
          <li>
            <span className="mm-land-step-num">01</span>
            <div>
              <strong>{t('Create your shop', '创建你的店铺')}</strong>
              <span>{t(' — pick a name, describe what you bake.', '——取个名字，介绍你的产品。')}</span>
            </div>
          </li>
          <li>
            <span className="mm-land-step-num">02</span>
            <div>
              <strong>{t('Add your products', '添加产品')}</strong>
              <span>{t(' — set names, prices and delivery windows.', '——设置名称、价格与交货时间。')}</span>
            </div>
          </li>
          <li>
            <span className="mm-land-step-num">03</span>
            <div>
              <strong>{t('Share your link', '分享专属链接')}</strong>
              <span>{t(' — send /s/yourshop to customers; orders come straight to you.', '——将 /s/yourshop 发给顾客，订单直达你。')}</span>
            </div>
          </li>
        </ol>
      </section>

      {/* ── Value props ── */}
      <section className="mm-land-values">
        <dl className="mm-land-value-list">
          <div className="mm-land-value-item">
            <dt>{t('Your own storefront link', '专属店面链接')}</dt>
            <dd>{t('Share a clean, branded URL — no marketplace fees, no listing competition.', '干净的品牌网址，无平台抽成，无竞争对手。')}</dd>
          </div>
          <div className="mm-land-value-item">
            <dt>{t('Simple order management', '简洁订单管理')}</dt>
            <dd>{t('See every order at a glance. Update statuses and send tracking numbers with one tap.', '一目了然查看所有订单，一键更新状态与物流号。')}</dd>
          </div>
          <div className="mm-land-value-item">
            <dt>{t('Bilingual, out of the box', '中英双语，开箱即用')}</dt>
            <dd>{t('Your storefront speaks both English and Chinese — perfect for Malaysian food businesses.', '店面自动支持中英文，专为马来西亚小食企业设计。')}</dd>
          </div>
        </dl>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" className="mm-land-pricing">
        <h2 className="mm-land-steps-title">
          {t('Simple, honest pricing', '简单透明的价格')}
        </h2>
        <p className="mm-land-pricing-sub">
          {t('Start free. Upgrade when your shop grows.', '免费开始，店铺成长后再升级。')}
        </p>

        <div className="mm-land-pricing-toggle" role="group" aria-label={t('Billing period', '付费周期')}>
          <button
            type="button"
            className={`mm-land-pricing-toggle-btn${billing === 'monthly' ? ' is-active' : ''}`}
            aria-pressed={billing === 'monthly'}
            onClick={() => setBilling('monthly')}
          >
            {t('Monthly', '按月')}
          </button>
          <button
            type="button"
            className={`mm-land-pricing-toggle-btn${billing === 'yearly' ? ' is-active' : ''}`}
            aria-pressed={billing === 'yearly'}
            onClick={() => setBilling('yearly')}
          >
            {t('Yearly', '按年')}
            <span className="mm-land-pricing-save">{t('Save ~17%', '省约17%')}</span>
          </button>
        </div>

        <div className="mm-land-pricing-grid">
          {tiers.map(tier => {
            const price = (billing === 'yearly' ? tier.yearly / 12 : tier.monthly).toFixed(2)
            return (
              <div
                key={tier.id}
                className={`mm-land-pricing-card${tier.highlight ? ' is-highlight' : ''}`}
              >
                {tier.badge && <span className="mm-land-pricing-badge">{tier.badge}</span>}
                <h3 className="mm-land-pricing-name">{tier.name}</h3>
                <div className="mm-land-pricing-price-row">
                  <span className="mm-land-pricing-price">RM {price}</span>
                  <span className="mm-land-pricing-per">{t('/mo', '/月')}</span>
                </div>
                <p className="mm-land-pricing-note">
                  {billing === 'yearly' && price > 0
                    ? t('billed yearly', '按年付费')
                    : ' '}
                </p>
                <p className="mm-land-pricing-blurb">{tier.blurb}</p>
                <ul className="mm-land-pricing-features">
                  {tier.features.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
                <Link
                  to={tier.to}
                  className={tier.highlight ? 'mm-land-cta-primary' : 'mm-land-cta-ghost'}
                >
                  {tier.cta}
                </Link>
              </div>
            )
          })}
        </div>
      </section>

      {/* ── Footer CTA ── */}
      <section className="mm-land-foot-cta">
        <p className="mm-land-foot-line">
          {t('Ready to take your first order?', '准备好接收你的第一笔订单了吗？')}
        </p>
        <Link to="/merchant/signup" className="mm-land-cta-primary">
          {t('Start your shop — it\'s free', '立即建店，免费开始')}
        </Link>
      </section>

      {/* ── Footer ── */}
      <footer className="mm-land-footer">
        <span className="mm-land-footer-brand">BiteTime</span>
        <span className="mm-land-footer-sep">·</span>
        <span>{t('Built for Malaysian food businesses', '专为马来西亚食品业者打造')}</span>
      </footer>
    </div>
  )
}
