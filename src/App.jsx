import { useState, useEffect } from 'react';
import './App.css';
import { loadSettings, loadSettingsFromDB, onAuthChange, signOut, loadDeliveryAddressLocal } from './store';
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
  const [view, setView] = useState('login');
  const [userPage, setUserPage] = useState('home');
  const [ordersKey, setOrdersKey] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accountSection, setAccountSection] = useState(null);
  const [savedAddress, setSavedAddress] = useState(null);
  const [orderCount, setOrderCount] = useState(0);

  const t = (en, zh) => lang === 'zh' ? zh : en;

  useEffect(() => {
    const unsubscribe = onAuthChange(u => {
      setAccount(u);
      if (u) setSavedAddress(loadDeliveryAddressLocal(u.id));
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
    if (view === 'register') return <RegisterView onLogin={() => setView('login')} onShowLogin={() => setView('login')} />;
    return <LoginView onLogin={() => {}} onShowRegister={() => setView('register')} />;
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
          {drawerNavItems.map(({ key, label }) => (
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

  // ── User: Customer View (full-width, sidebar hidden) ──────────────────────
  if (isUser && userPage === 'preview') {
    return (
      <>
        <div className={`form-wrap${accountSection ? ' form-wrap--wide' : ''}`} style={{ position: 'relative' }}>
          <div className="preview-back-pill" onClick={() => { setUserPage('home'); setDrawerOpen(false); setOrderDone(false); }}>
            ← {t('Back to User View', '返回用户视图')}
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
                <div className="success-box">
                  <h2>{t('Order placed! 🍪', '订单已提交！🍪')}</h2>
                  {lastOrderNumber && <p className="order-number-display">{t('Order No.', '订单号码')} <strong>{lastOrderNumber}</strong></p>}
                  <p>{t("Thank you! Your order has been sent to us. We'll reach out to you shortly to confirm.", '谢谢！您的订单已发送给我们，我们将尽快与您确认。')}</p>
                  <span className="reset-link" onClick={() => setOrderDone(false)}>{t('← Place another order', '← 再下一单')}</span>
                </div>
              ) : (
                <OrderForm key={JSON.stringify(settings.products) + JSON.stringify(savedAddress)} settings={settings} lang={lang} user={account} savedAddress={savedAddress} onSuccess={(num) => { setLastOrderNumber(num); setOrderDone(true); setOrderCount(c => c + 1); }} />
              )}
            </>
          )}
        </div>
        {sideDrawer}
      </>
    );
  }

  // ── User layout ────────────────────────────────────────────────────────────
  if (isUser) {
    return (
      <div className="user-layout">
        {/* SIDEBAR */}
        <aside className="user-sidebar">
          <div className="sidebar-brand">
            <div className="sidebar-logo">B&amp;C</div>
            <div className="sidebar-title">Bitetime</div>
            <div className="sidebar-role">{t('User', '用户')}</div>
          </div>

          <nav className="sidebar-nav">
            {USER_NAV.map(item => (
              <button
                key={item.key}
                className={'sidebar-nav-item' + (userPage === item.key ? ' active' : '')}
                onClick={() => { setUserPage(item.key); setOrderDone(false); if (item.key === 'orders') setOrdersKey(k => k + 1); }}
              >
                <span>{t(item.label, item.labelZh)}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-footer">
            <div className="sidebar-user-name">{accountName}</div>
            <button className="sidebar-signout" onClick={handleLogout}>{t('Sign out', '退出')}</button>
          </div>
        </aside>

        {/* MAIN CONTENT */}
        <main className="user-main">
          {/* Lang switcher */}
          <div className="lang-switcher">
            <button className={'lang-btn' + (lang === 'en' ? ' active' : '')} onClick={() => setLang('en')}>🇬🇧 English</button>
            <button className={'lang-btn' + (lang === 'zh' ? ' active' : '')} onClick={() => setLang('zh')}>🇨🇳 中文</button>
          </div>

          {userPage === 'home' && (
            <>
              <div className="brand">
                <h1>Bitetime &amp; Co.</h1>
                <div className="tagline">{t('Gift the Story, Keep the Feeling.', '送出故事，留住感动。')}</div>
                <div className="subtitle">{t("Place your order below — we'll confirm via WhatsApp!", '请在下方下单 — 我们将通过 WhatsApp 确认您的订单！')}</div>
              </div>
              {orderDone ? (
                <div className="success-box">
                  <h2>{t('Order placed! 🍪', '订单已提交！🍪')}</h2>
                  {lastOrderNumber && <p className="order-number-display">{t('Order No.', '订单号码')} <strong>{lastOrderNumber}</strong></p>}
                  <p>{t("Thank you! Your order has been sent to us. We'll reach out to you shortly to confirm.", '谢谢！您的订单已发送给我们，我们将尽快与您确认。')}</p>
                  <span className="reset-link" onClick={() => setOrderDone(false)}>{t('← Place another order', '← 再下一单')}</span>
                </div>
              ) : (
                <OrderForm key={JSON.stringify(settings.products)} settings={settings} lang={lang} user={account} onSuccess={(num) => { setLastOrderNumber(num); setOrderDone(true); setOrderCount(c => c + 1); }} />
              )}
            </>
          )}

          {userPage === 'menu' && (
            <AdminPanel
              settings={settings}
              lang={lang}
              onSave={newSettings => setSettings(newSettings)}
            />
          )}

          {userPage === 'analytics' && <SalesDashboard lang={lang} />}
          {userPage === 'orders' && <OrderList key={ordersKey} lang={lang} />}
          {userPage === 'customers' && <CustomerList lang={lang} />}
          {userPage === 'vouchers' && <VoucherPanel lang={lang} />}
        </main>
      </div>
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
              <div className="success-box">
                <h2>{t('Order placed! 🍪', '订单已提交！🍪')}</h2>
                {lastOrderNumber && <p className="order-number-display">{t('Order No.', '订单号码')} <strong>{lastOrderNumber}</strong></p>}
                <p>{t("Thank you! Your order has been sent to us. We'll reach out to you shortly to confirm.", '谢谢！您的订单已发送给我们，我们将尽快与您确认。')}</p>
                <span className="reset-link" onClick={() => setOrderDone(false)}>{t('← Place another order', '← 再下一单')}</span>
              </div>
            ) : (
              <OrderForm
                key={JSON.stringify(settings.products) + JSON.stringify(savedAddress)}
                settings={settings}
                lang={lang}
                user={account}
                savedAddress={savedAddress}
                onSuccess={(num) => { setLastOrderNumber(num); setOrderDone(true); setOrderCount(c => c + 1); }}
              />
            )}
          </>
        )}
      </div>
      {sideDrawer}
    </>
  );
}
