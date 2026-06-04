import { useState, useEffect } from 'react';
import './App.css';
import { loadSettings, loadSettingsFromDB, onAuthChange, signOut, loadDeliveryAddressLocal } from './store';
import LoginView from './components/LoginView';
import RegisterView from './components/RegisterView';
import AdminPanel from './components/AdminPanel';
import UserList from './components/UserList';
import OrderForm from './components/OrderForm';
import CustomerSettings from './components/CustomerSettings';
import VoucherPanel from './components/VoucherPanel';

const OWNER_EMAIL = 'esthertan0716@gmail.com';

const OWNER_NAV = [
  { key: 'home',     icon: '🏠', label: 'Home',               labelZh: '主页' },
  { key: 'menu',     icon: '⚙️', label: 'Menu & Settings',    labelZh: '菜单与设置' },
  { key: 'users',    icon: '👥', label: 'Users',               labelZh: '用户' },
  { key: 'vouchers', icon: '🎟️', label: 'Vouchers',            labelZh: '优惠券' },
  { key: 'preview',  icon: '👁️', label: 'Customer View',      labelZh: '顾客视图' },
];

export default function App() {
  const [user, setUser] = useState(undefined);
  const [lang, setLang] = useState('en');
  const [settings, setSettings] = useState(loadSettings);
  const [orderDone, setOrderDone] = useState(false);
  const [view, setView] = useState('login');
  const [ownerPage, setOwnerPage] = useState('home');
  const [customerTab, setCustomerTab] = useState('order');
  const [savedAddress, setSavedAddress] = useState(null);

  const t = (en, zh) => lang === 'zh' ? zh : en;

  useEffect(() => {
    const unsubscribe = onAuthChange(u => {
      setUser(u);
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
    setOwnerPage('home');
  }

  const isOwner = user?.email === OWNER_EMAIL;
  const userName = user?.user_metadata?.name || user?.email || '';

  if (user === undefined) {
    return (
      <div className="form-wrap" style={{ textAlign: 'center', paddingTop: '4rem', color: '#aaa' }}>
        Loading…
      </div>
    );
  }

  if (!user) {
    if (view === 'register') return <RegisterView onLogin={() => setView('login')} onShowLogin={() => setView('login')} />;
    return <LoginView onLogin={() => {}} onShowRegister={() => setView('register')} />;
  }

  // ── Owner: Customer View (full-width, sidebar hidden) ──────────────────────
  if (isOwner && ownerPage === 'preview') {
    return (
      <div className="form-wrap" style={{ position: 'relative' }}>
        <div className="preview-back-pill" onClick={() => { setOwnerPage('home'); setCustomerTab('order'); setOrderDone(false); }}>
          ← {t('Back to Owner View', '返回店主视图')}
        </div>

        <div className="cust-topbar">
          <div className="lang-switcher">
            <button className={'lang-btn' + (lang === 'en' ? ' active' : '')} onClick={() => setLang('en')}>🇬🇧 English</button>
            <button className={'lang-btn' + (lang === 'zh' ? ' active' : '')} onClick={() => setLang('zh')}>🇨🇳 中文</button>
          </div>
          <button className={'cust-account-btn' + (customerTab === 'account' ? ' active' : '')} onClick={() => setCustomerTab(customerTab === 'account' ? 'order' : 'account')}>
            👤 {t('My Account', '我的账户')}
          </button>
        </div>

        {customerTab === 'order' && (
          <>
            <div className="brand">
              <h1>Bitetime &amp; Co.</h1>
              <div className="tagline">{t('Gift the Story, Keep the Feeling.', '送出故事，留住感动。')}</div>
              <div className="subtitle">{t("Place your order below — we'll confirm via WhatsApp!", '请在下方下单 — 我们将通过 WhatsApp 确认您的订单！')}</div>
            </div>
            {orderDone ? (
              <div className="success-box">
                <h2>{t('Order placed! 🍪', '订单已提交！🍪')}</h2>
                <p>{t("Thank you! Your order has been sent to us. We'll reach out to you shortly to confirm.", '谢谢！您的订单已发送给我们，我们将尽快与您确认。')}</p>
                <span className="reset-link" onClick={() => setOrderDone(false)}>{t('← Place another order', '← 再下一单')}</span>
              </div>
            ) : (
              <OrderForm key={JSON.stringify(settings.products) + JSON.stringify(savedAddress)} settings={settings} lang={lang} user={user} savedAddress={savedAddress} onSuccess={() => setOrderDone(true)} />
            )}
          </>
        )}

        {customerTab === 'account' && (
          <CustomerSettings user={user} lang={lang} onAddressSaved={addr => setSavedAddress(addr)} />
        )}
      </div>
    );
  }

  // ── Owner layout ────────────────────────────────────────────────────────────
  if (isOwner) {
    return (
      <div className="owner-layout">
        {/* SIDEBAR */}
        <aside className="owner-sidebar">
          <div className="sidebar-brand">
            <div className="sidebar-logo">B&amp;C</div>
            <div className="sidebar-title">Bitetime</div>
            <div className="sidebar-role">{t('Owner', '店主')}</div>
          </div>

          <nav className="sidebar-nav">
            {OWNER_NAV.map(item => (
              <button
                key={item.key}
                className={'sidebar-nav-item' + (ownerPage === item.key ? ' active' : '')}
                onClick={() => { setOwnerPage(item.key); setOrderDone(false); }}
              >
                <span className="sidebar-nav-icon">{item.icon}</span>
                <span>{t(item.label, item.labelZh)}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-footer">
            <div className="sidebar-user-name">{userName}</div>
            <button className="sidebar-signout" onClick={handleLogout}>{t('Sign out', '退出')}</button>
          </div>
        </aside>

        {/* MAIN CONTENT */}
        <main className="owner-main">
          {/* Lang switcher */}
          <div className="lang-switcher">
            <button className={'lang-btn' + (lang === 'en' ? ' active' : '')} onClick={() => setLang('en')}>🇬🇧 English</button>
            <button className={'lang-btn' + (lang === 'zh' ? ' active' : '')} onClick={() => setLang('zh')}>🇨🇳 中文</button>
          </div>

          {ownerPage === 'home' && (
            <>
              <div className="brand">
                <h1>Bitetime &amp; Co.</h1>
                <div className="tagline">{t('Gift the Story, Keep the Feeling.', '送出故事，留住感动。')}</div>
                <div className="subtitle">{t("Place your order below — we'll confirm via WhatsApp!", '请在下方下单 — 我们将通过 WhatsApp 确认您的订单！')}</div>
              </div>
              {orderDone ? (
                <div className="success-box">
                  <h2>{t('Order placed! 🍪', '订单已提交！🍪')}</h2>
                  <p>{t("Thank you! Your order has been sent to us. We'll reach out to you shortly to confirm.", '谢谢！您的订单已发送给我们，我们将尽快与您确认。')}</p>
                  <span className="reset-link" onClick={() => setOrderDone(false)}>{t('← Place another order', '← 再下一单')}</span>
                </div>
              ) : (
                <OrderForm key={JSON.stringify(settings.products)} settings={settings} lang={lang} user={user} onSuccess={() => setOrderDone(true)} />
              )}
            </>
          )}

          {ownerPage === 'menu' && (
            <AdminPanel
              settings={settings}
              lang={lang}
              onSave={newSettings => setSettings(newSettings)}
            />
          )}

          {ownerPage === 'users' && <UserList lang={lang} />}
          {ownerPage === 'vouchers' && <VoucherPanel lang={lang} />}
        </main>
      </div>
    );
  }

  // ── Regular user layout ─────────────────────────────────────────────────────
  return (
    <div className="form-wrap">
      <div className="auth-greeting">
        Hi, <span>{userName}</span>&nbsp;
        <a onClick={handleLogout}>{t('Sign out', '退出')}</a>
      </div>

      <div className="cust-topbar">
        <div className="lang-switcher">
          <button className={'lang-btn' + (lang === 'en' ? ' active' : '')} onClick={() => setLang('en')}>🇬🇧 English</button>
          <button className={'lang-btn' + (lang === 'zh' ? ' active' : '')} onClick={() => setLang('zh')}>🇨🇳 中文</button>
        </div>
        <button className={'cust-account-btn' + (customerTab === 'account' ? ' active' : '')} onClick={() => setCustomerTab(customerTab === 'account' ? 'order' : 'account')}>
          👤 {t('My Account', '我的账户')}
        </button>
      </div>

      {customerTab === 'order' && (
        <>
          <div className="brand">
            <h1>Bitetime &amp; Co.</h1>
            <div className="tagline">{t('Gift the Story, Keep the Feeling.', '送出故事，留住感动。')}</div>
            <div className="subtitle">{t("Place your order below — we'll confirm via WhatsApp!", '请在下方下单 — 我们将通过 WhatsApp 确认您的订单！')}</div>
          </div>

          {orderDone ? (
            <div className="success-box">
              <h2>{t('Order placed! 🍪', '订单已提交！🍪')}</h2>
              <p>{t("Thank you! Your order has been sent to us. We'll reach out to you shortly to confirm.", '谢谢！您的订单已发送给我们，我们将尽快与您确认。')}</p>
              <span className="reset-link" onClick={() => setOrderDone(false)}>{t('← Place another order', '← 再下一单')}</span>
            </div>
          ) : (
            <OrderForm
              key={JSON.stringify(settings.products) + JSON.stringify(savedAddress)}
              settings={settings}
              lang={lang}
              user={user}
              savedAddress={savedAddress}
              onSuccess={() => setOrderDone(true)}
            />
          )}
        </>
      )}

      {customerTab === 'account' && (
        <CustomerSettings
          user={user}
          lang={lang}
          onAddressSaved={addr => setSavedAddress(addr)}
        />
      )}
    </div>
  );
}
