import { useState, useEffect } from 'react';
import './App.css';
import { loadSettings, loadSettingsFromDB, onAuthChange, signOut, loadDeliveryAddress } from './store';
import LoginView from './components/LoginView';
import RegisterView from './components/RegisterView';
import AdminPanel from './components/AdminPanel';
import CustomerList from './components/CustomerList';
import OrderForm from './components/OrderForm';
import CustomerSettings from './components/CustomerSettings';
import VoucherPanel from './components/VoucherPanel';
import OrderList from './components/OrderList';
import SalesDashboard from './components/SalesDashboard';

const USER_EMAIL = 'bitetimeandco@gmail.com';

const USER_NAV = [
  { key: 'home',      icon: '', label: 'Home',             labelZh: '主页' },
  { key: 'analytics', icon: '', label: 'Analytics',        labelZh: '数据分析' },
  { key: 'orders',    icon: '', label: 'Orders',           labelZh: '订单' },
  { key: 'menu',      icon: '', label: 'Menu & Settings',  labelZh: '菜单与设置' },
  { key: 'customers', icon: '', label: 'Customers',        labelZh: '顾客' },
  { key: 'vouchers',  icon: '', label: 'Vouchers',         labelZh: '优惠券' },
  { key: 'preview',   icon: '', label: 'Customer View',    labelZh: '顾客视图' },
];

export default function App() {
  const [account, setAccount] = useState(undefined);
  const [lang, setLang] = useState('en');
  const [settings, setSettings] = useState(loadSettings);
  const [orderDone, setOrderDone] = useState(false);
  const [lastOrderNumber, setLastOrderNumber] = useState('');
  const [lastOrder, setLastOrder] = useState(null);
  const [view, setView] = useState('login');
  const [userPage, setUserPage] = useState('home');
  const [ordersKey, setOrdersKey] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuExpanded, setMenuExpanded] = useState(false);
  const [menuTab, setMenuTab] = useState('menu');
  const [accountSection, setAccountSection] = useState(null);
  const [savedAddress, setSavedAddress] = useState(null);
  const [orderCount, setOrderCount] = useState(0);

  const t = (en, zh) => lang === 'zh' ? zh : en;

  useEffect(() => {
    const unsubscribe = onAuthChange(u => {
      setAccount(u);
      // Local cache first (sync inside loadDeliveryAddress), falls back to DB so a new device still gets the saved address
      if (u) loadDeliveryAddress(u.id).then(addr => { if (addr) setSavedAddress(addr); });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    loadSettingsFromDB().then(dbSettings => {
      if (dbSettings) setSettings(dbSettings);
    });
  }, []);

  function handleLogout() {
    signOut();
    setOrderDone(false);
    setUserPage('home');
    setDrawerOpen(false);
  }

  const isUser = account?.email === USER_EMAIL;
  const accountName = account?.user_metadata?.name || account?.email || '';

  if (account === undefined) {
    return (
      <div className="form-wrap" style={{ textAlign: 'center', paddingTop: '4rem', color: '#aaa' }}>
        Loading…
      </div>
    );
  }

  if (!account) {
    if (view === 'register') return <RegisterView onShowLogin={() => setView('login')} />;
    return <LoginView onShowRegister={() => setView('register')} />;
  }

  const drawerNavItems = [
    { key: 'details',  label: t('Personal Details', '个人信息') },
    { key: 'vouchers', label: t('Vouchers', '优惠券') },
    { key: 'history',  label: t('Order History', '历史订单') },
  ];

  function openSection(key) {
    setAccountSection(key);
    setDrawerOpen(false);
  }

  function renderSuccessBox(onViewHistory) {
    return (
      <div className="success-box">
        <h2>{t('Order placed! 🍪', '订单已提交！🍪')}</h2>
        {lastOrderNumber && <p className="order-number-display">{t('Order No.', '订单号码')} <strong>{lastOrderNumber}</strong></p>}
        {lastOrder && lastOrder.items?.length > 0 && (
          <div className="success-summary">
            {lastOrder.items.map((it, i) => (
              <div key={i} className="summary-row"><span>{it.name} × {it.qty}</span><span>RM {it.price * it.qty}</span></div>
            ))}
            {lastOrder.shippingFee > 0 && (
              <div className="summary-row"><span>{lastOrder.mode === 'sameday' ? `${t('Same-day delivery', '当天配送')}${lastOrder.slot ? ` (${lastOrder.slot})` : ''}` : t('Delivery', '送货')}</span><span>RM {lastOrder.shippingFee}</span></div>
            )}
            <div className="summary-row total"><span>{t('Total', '总计')}</span><span>RM {lastOrder.total}</span></div>
          </div>
        )}
        {lastOrder?.mode === 'pickup' && (settings.pickup?.address || settings.pickup?.hours) && (
          <div className="success-info-box">
            <div className="success-info-title">📍 {t('Pickup location', '取货地点')}</div>
            {settings.pickup.address && <div>{settings.pickup.address}</div>}
            {settings.pickup.hours && <div>🕐 {settings.pickup.hours}</div>}
          </div>
        )}
        {settings.paymentNote && (
          <div className="success-info-box">
            <div className="success-info-title">💳 {t('Payment', '付款方式')}</div>
            <div style={{ whiteSpace: 'pre-line' }}>{settings.paymentNote}</div>
          </div>
        )}
        <p>{t("Thank you! Your order has been sent to us. We'll reach out to you shortly to confirm.", '谢谢！您的订单已发送给我们，我们将尽快与您确认。')}</p>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', flexWrap: 'wrap' }}>
          <span className="reset-link" onClick={() => setOrderDone(false)}>{t('← Place another order', '← 再下一单')}</span>
          {onViewHistory && <span className="reset-link" onClick={onViewHistory}>{t('View order history →', '查看历史订单 →')}</span>}
        </div>
      </div>
    );
  }

  const sideDrawer = (
    <>
      {drawerOpen && <div className="drawer-overlay" onClick={() => setDrawerOpen(false)} />}
      <div className={'side-drawer' + (drawerOpen ? ' open' : '')}>
        <div className="drawer-header">
          <div>
            <div className="drawer-brand-name">Bitetime &amp; Co.</div>
          </div>
          <button className="drawer-close" onClick={() => setDrawerOpen(false)}>✕</button>
        </div>
        <div className="drawer-user">
          <div className="drawer-user-greeting">{t('Welcome back,', '欢迎回来，')}</div>
          <div className="drawer-user-name">{accountName}</div>
        </div>
        <nav className="drawer-nav">
          {isUser && userPage !== 'preview' ? USER_NAV.map(({ key, label, labelZh }) => (
            key === 'menu' ? (
              <div key="menu">
                <button
                  className={'drawer-nav-btn drawer-nav-btn--expand' + (userPage === 'menu' ? ' active' : '')}
                  onClick={() => setMenuExpanded(e => !e)}
                >
                  <span>{t(label, labelZh)}</span>
                  <span style={{ fontSize: '10px', opacity: 0.7 }}>{menuExpanded ? '▲' : '▼'}</span>
                </button>
                {menuExpanded && (
                  <>
                    <button
                      className={'drawer-nav-btn drawer-nav-sub' + (userPage === 'menu' && menuTab === 'menu' ? ' active' : '')}
                      onClick={() => { setUserPage('menu'); setMenuTab('menu'); setDrawerOpen(false); setOrderDone(false); }}
                    >
                      {t('Menu', '菜单')}
                    </button>
                    <button
                      className={'drawer-nav-btn drawer-nav-sub' + (userPage === 'menu' && menuTab === 'delivery' ? ' active' : '')}
                      onClick={() => { setUserPage('menu'); setMenuTab('delivery'); setDrawerOpen(false); setOrderDone(false); }}
                    >
                      {t('Delivery', '送货费')}
                    </button>
                    <button
                      className={'drawer-nav-btn drawer-nav-sub' + (userPage === 'menu' && menuTab === 'bot' ? ' active' : '')}
                      onClick={() => { setUserPage('menu'); setMenuTab('bot'); setDrawerOpen(false); setOrderDone(false); }}
                    >
                      {t('Bot', '机器人')}
                    </button>
                    <button
                      className={'drawer-nav-btn drawer-nav-sub' + (userPage === 'menu' && menuTab === 'email' ? ' active' : '')}
                      onClick={() => { setUserPage('menu'); setMenuTab('email'); setDrawerOpen(false); setOrderDone(false); }}
                    >
                      {t('Email', '邮件')}
                    </button>
                  </>
                )}
              </div>
            ) : (
            <button
              key={key}
              className={'drawer-nav-btn' + (userPage === key ? ' active' : '')}
              onClick={() => { setUserPage(key); setDrawerOpen(false); setOrderDone(false); if (key === 'orders') setOrdersKey(k => k + 1); }}
            >
              {t(label, labelZh)}
            </button>
            )
          )) : drawerNavItems.map(({ key, label }) => (
            <button
              key={key}
              className={'drawer-nav-btn' + (accountSection === key ? ' active' : '')}
              onClick={() => openSection(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="drawer-footer">
          <button className="drawer-signout" onClick={handleLogout}>{t('Sign out', '退出登录')}</button>
        </div>
      </div>
    </>
  );

  // ── User (owner) layout ────────────────────────────────────────────────────
  if (isUser) {
    return (
      <>
        <div className="form-wrap form-wrap--owner">
          {userPage === 'preview' && (
            <div className="preview-back-pill" onClick={() => { setUserPage('home'); setDrawerOpen(false); setOrderDone(false); }}>
              ← {t('Back to User View', '返回用户视图')}
            </div>
          )}

          <div className="cust-topbar">
            <button className="hamburger-btn" onClick={() => setDrawerOpen(true)} aria-label="Navigation">
              <span /><span /><span />
            </button>
            <div className="lang-switcher">
              <button className={'lang-btn' + (lang === 'en' ? ' active' : '')} onClick={() => setLang('en')}>🇬🇧 English</button>
              <button className={'lang-btn' + (lang === 'zh' ? ' active' : '')} onClick={() => setLang('zh')}>🇨🇳 中文</button>
            </div>
          </div>

          {(userPage === 'home' || userPage === 'preview') && (
            <>
              {userPage === 'preview' && accountSection ? (
                <>
                  <span className="reset-link" style={{ display: 'inline-block', marginBottom: '1.25rem' }} onClick={() => setAccountSection(null)}>
                    {t('← Back to Order', '← 返回订单')}
                  </span>
                  <CustomerSettings user={account} lang={lang} onAddressSaved={addr => setSavedAddress(addr)} refreshKey={orderCount} section={accountSection} />
                </>
              ) : (
                <>
                  <div className="brand">
                    <h1>Bitetime &amp; Co.</h1>
                    <div className="tagline">{t('Gift the Story, Keep the Feeling.', '送出故事，留住感动。')}</div>
                    <div className="subtitle">{t("Place your order below — we'll confirm via WhatsApp!", '请在下方下单 — 我们将通过 WhatsApp 确认您的订单！')}</div>
                  </div>
                  {orderDone ? (
                    renderSuccessBox(userPage === 'preview'
                      ? () => { setOrderDone(false); setAccountSection('history'); }
                      : () => { setOrderDone(false); setUserPage('orders'); setOrdersKey(k => k + 1); })
                  ) : (
                    <OrderForm key={JSON.stringify(settings.products) + JSON.stringify(savedAddress)} settings={settings} lang={lang} user={account} savedAddress={savedAddress} onSuccess={(num, info) => { setLastOrderNumber(num); setLastOrder(info); setOrderDone(true); setOrderCount(c => c + 1); }} />
                  )}
                </>
              )}
            </>
          )}

          {userPage === 'menu' && (
            <AdminPanel settings={settings} lang={lang} onSave={newSettings => setSettings(newSettings)} tab={menuTab} />
          )}

          {userPage === 'analytics' && <SalesDashboard lang={lang} />}
          {userPage === 'orders' && <OrderList key={ordersKey} lang={lang} settings={settings} user={account} />}
          {userPage === 'customers' && <CustomerList lang={lang} />}
          {userPage === 'vouchers' && <VoucherPanel lang={lang} />}
        </div>
        {sideDrawer}
      </>
    );
  }

  // ── Customer layout ─────────────────────────────────────────────────────────
  return (
    <>
      <div className={`form-wrap${accountSection ? ' form-wrap--wide' : ''}`}>
        <div className="auth-greeting">
          Hi, <span>{accountName}</span>&nbsp;
          <a onClick={handleLogout}>{t('Sign out', '退出')}</a>
        </div>

        <div className="cust-topbar">
          <button className="hamburger-btn" onClick={() => setDrawerOpen(true)} aria-label="My Account">
            <span /><span /><span />
          </button>
          <div className="lang-switcher">
            <button className={'lang-btn' + (lang === 'en' ? ' active' : '')} onClick={() => setLang('en')}>🇬🇧 English</button>
            <button className={'lang-btn' + (lang === 'zh' ? ' active' : '')} onClick={() => setLang('zh')}>🇨🇳 中文</button>
          </div>
        </div>

        {accountSection ? (
          <>
            <span className="reset-link" style={{ display: 'inline-block', marginBottom: '1.25rem' }} onClick={() => setAccountSection(null)}>
              {t('← Back to Order', '← 返回订单')}
            </span>
            <CustomerSettings user={account} lang={lang} onAddressSaved={addr => setSavedAddress(addr)} refreshKey={orderCount} section={accountSection} />
          </>
        ) : (
          <>
            <div className="brand">
              <h1>Bitetime &amp; Co.</h1>
              <div className="tagline">{t('Gift the Story, Keep the Feeling.', '送出故事，留住感动。')}</div>
              <div className="subtitle">{t("Place your order below — we'll confirm via WhatsApp!", '请在下方下单 — 我们将通过 WhatsApp 确认您的订单！')}</div>
            </div>
            {orderDone ? (
              renderSuccessBox(() => { setOrderDone(false); setAccountSection('history'); })
            ) : (
              <OrderForm
                key={JSON.stringify(settings.products) + JSON.stringify(savedAddress)}
                settings={settings}
                lang={lang}
                user={account}
                savedAddress={savedAddress}
                onSuccess={(num, info) => { setLastOrderNumber(num); setLastOrder(info); setOrderDone(true); setOrderCount(c => c + 1); }}
              />
            )}
          </>
        )}
      </div>
      {sideDrawer}
    </>
  );
}
