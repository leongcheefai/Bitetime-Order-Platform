import { useState, useEffect } from 'react';
import './App.css';
import { loadSettings, loadSettingsFromDB, onAuthChange, signOut } from './store';
import LoginView from './components/LoginView';
import RegisterView from './components/RegisterView';
import AdminPanel from './components/AdminPanel';
import OrderForm from './components/OrderForm';

const OWNER_EMAIL = 'esthertan0716@gmail.com';

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = loading
  const [lang, setLang] = useState('en');
  const [settings, setSettings] = useState(loadSettings);
  const [adminOpen, setAdminOpen] = useState(false);
  const [orderDone, setOrderDone] = useState(false);
  const [view, setView] = useState('login');

  const t = (en, zh) => lang === 'zh' ? zh : en;

  useEffect(() => {
    const unsubscribe = onAuthChange(u => setUser(u));
    return unsubscribe;
  }, []);

  // Load settings from Supabase on mount
  useEffect(() => {
    loadSettingsFromDB().then(dbSettings => {
      if (dbSettings) setSettings(dbSettings);
    });
  }, []);

  function handleLogout() {
    signOut();
    setOrderDone(false);
    setAdminOpen(false);
  }

  const isOwner = user?.email === OWNER_EMAIL;
  const userName = user?.user_metadata?.name || user?.email || '';

  // Still checking auth
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

  return (
    <div className="form-wrap">
      {/* GREETING */}
      <div className="auth-greeting">
        Hi, <span>{userName}</span>&nbsp;
        <a onClick={handleLogout}>Sign out</a>
      </div>

      {/* LANG SWITCHER */}
      <div className="lang-switcher">
        <button className={'lang-btn' + (lang === 'en' ? ' active' : '')} onClick={() => setLang('en')}>🇬🇧 English</button>
        <button className={'lang-btn' + (lang === 'zh' ? ' active' : '')} onClick={() => setLang('zh')}>🇨🇳 中文</button>
      </div>

      {/* BRAND */}
      <div className="brand">
        <h1>Bitetime &amp; Co.</h1>
        <div className="tagline">{t('Gift the Story, Keep the Feeling.', '送出故事，留住感动。')}</div>
        <div className="subtitle">{t("Place your order below — we'll confirm via WhatsApp!", '请在下方下单 — 我们将通过 WhatsApp 确认您的订单！')}</div>
      </div>

      {/* ADMIN TOGGLE — owner only */}
      {isOwner && (
        <div className="admin-toggle">
          <button onClick={() => setAdminOpen(o => !o)}>{t('⚙️ Edit menu & settings', '⚙️ 编辑菜单与设置')}</button>
        </div>
      )}

      {isOwner && adminOpen && (
        <AdminPanel
          settings={settings}
          lang={lang}
          onSave={newSettings => { setSettings(newSettings); setOrderDone(false); }}
        />
      )}

      {/* ORDER FORM / SUCCESS */}
      {orderDone ? (
        <div className="success-box">
          <h2>{t('Order placed! 🍪', '订单已提交！🍪')}</h2>
          <p>{t("Thank you! Your order has been sent to us. We'll reach out to you shortly to confirm.", '谢谢！您的订单已发送给我们，我们将尽快与您确认。')}</p>
          <span className="reset-link" onClick={() => setOrderDone(false)}>{t('← Place another order', '← 再下一单')}</span>
        </div>
      ) : (
        <OrderForm key={JSON.stringify(settings.products)} settings={settings} lang={lang} user={user} onSuccess={() => setOrderDone(true)} />
      )}
    </div>
  );
}
