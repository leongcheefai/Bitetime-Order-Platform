import { useState, useEffect } from 'react';
import './App.css';
import { loadSettings, loadSettingsFromDB, onAuthChange, signOut, loadDeliveryAddress, updatePassword } from './store';
import { useSession } from './SessionContext';
import LoginView from './components/LoginView';
import RegisterView from './components/RegisterView';
import AdminPanel from './components/AdminPanel';
import CustomerList from './components/CustomerList';
import OrderForm from './components/OrderForm';
import CustomerSettings from './components/CustomerSettings';
import VoucherPanel from './components/VoucherPanel';
import OrderList from './components/OrderList';
import SalesDashboard from './components/SalesDashboard';
import Notifications from './components/Notifications';

const USER_NAV = [
  { key: 'home',      icon: '', label: 'Home',             labelZh: '主页' },
  { key: 'orders',    icon: '', label: 'Orders',           labelZh: '订单' },
  { key: 'analytics', icon: '', label: 'Analytics',        labelZh: '数据分析' },
  { key: 'menupage',  icon: '', label: 'Menu',             labelZh: '菜单' },
  { key: 'customers', icon: '', label: 'Customers',        labelZh: '顾客' },
  { key: 'events',    icon: '', label: 'Promos & Events',  labelZh: '活动专区' },
  { key: 'menu',      icon: '', label: 'Settings',  labelZh: '设置' },
  { key: 'preview',   icon: '', label: 'Customer View',    labelZh: '顾客视图' },
];

export default function App() {
  const { account, role, lang, setLang, t } = useSession();
  const [settings, setSettings] = useState(loadSettings);
  const [orderDone, setOrderDone] = useState(false);
  const [lastOrderNumber, setLastOrderNumber] = useState('');
  const [lastOrder, setLastOrder] = useState(null);
  const [view, setView] = useState('order'); // guests land on the menu; 'login'/'register' show auth pages
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPw, setNewPw] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [userPage, setUserPage] = useState('home');
  const [ordersKey, setOrdersKey] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuExpanded, setMenuExpanded] = useState(false);
  const [eventsExpanded, setEventsExpanded] = useState(false);
  const [menuTab, setMenuTab] = useState('menu');
  const [accountSection, setAccountSection] = useState(null);
  const [savedAddress, setSavedAddress] = useState(null);
  const [orderCount, setOrderCount] = useState(0);

  const money = (n) => Number(n || 0).toFixed(2);

  useEffect(() => {
    const unsubscribe = onAuthChange((u, event) => {
      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true);
      if (event === 'SIGNED_IN') setView('order');
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
    setAccountSection(null);
    setSavedAddress(null);
    setView('order');
  }

  const isAdmin = role === 'superadmin' || role === 'merchant';
  const accountName = account?.user_metadata?.name || account?.email || '';

  if (account === undefined) {
    return (
      <div className="form-wrap" style={{ textAlign: 'center', paddingTop: '4rem', color: '#aaa' }}>
        Loading…
      </div>
    );
  }

  // Password recovery: user arrived from a reset-password email link
  if (recoveryMode && account) {
    return (
      <div className="auth-wrap">
        <div className="brand" style={{ marginBottom: '1.75rem' }}>
          <h1>Bitetime &amp; Co.</h1>
        </div>
        <div className="auth-card">
          <div className="auth-title">{t('Set a new password', '设置新密码')}</div>
          {pwMsg && <div className="auth-error">{pwMsg}</div>}
          <div className="auth-fields">
            <div className="field">
              <label>{t('New password', '新密码')}</label>
              <input type="password" placeholder={t('At least 6 characters', '至少 6 个字符')} value={newPw} onChange={e => { setNewPw(e.target.value); setPwMsg(''); }} />
            </div>
          </div>
          <button className="auth-btn" onClick={async () => {
            if (newPw.length < 6) { setPwMsg(t('Password must be at least 6 characters.', '密码至少需要 6 个字符。')); return; }
            try {
              await updatePassword(newPw);
              setRecoveryMode(false);
              setNewPw('');
            } catch (err) {
              setPwMsg(err.message);
            }
          }}>{t('Save password', '保存密码')}</button>
        </div>
      </div>
    );
  }

  // Guests can browse and order; auth pages only when explicitly requested
  if (!account) {
    if (view === 'register') return <RegisterView onShowLogin={() => setView('login')} onBack={() => setView('order')} lang={lang} setLang={setLang} />;
    if (view === 'login') return <LoginView onShowRegister={() => setView('register')} onBack={() => setView('order')} lang={lang} setLang={setLang} />;
  }

  const drawerNavItems = [
    { key: 'details', label: t('Personal Details', '个人信息') },
    { key: 'promos',  label: t('Promos & Events', '活动专区') },
    { key: 'history', label: t('Order History', '历史订单') },
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
              <div key={i} className="summary-row"><span>{it.name} × {it.qty}</span><span>RM {money(it.price * it.qty)}</span></div>
            ))}
            {lastOrder.shippingFee > 0 && (
              <div className="summary-row"><span>{lastOrder.mode === 'sameday' ? `${t('Same-day delivery', '当天配送')}${lastOrder.slot ? ` (${lastOrder.slot})` : ''}` : t('Delivery', '送货')}</span><span>RM {money(lastOrder.shippingFee)}</span></div>
            )}
            <div className="summary-row total"><span>{t('Total', '总计')}</span><span>RM {money(lastOrder.total)}</span></div>
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
        {settings.igUrl && (
          <p>
            <a href={settings.igUrl} target="_blank" rel="noreferrer" style={{ color: '#d6336c', fontWeight: 600, textDecoration: 'none' }}>
              📸 {t('Follow us on Instagram for new flavours & promos →', '关注我们的 Instagram，获取新口味和优惠 →')}
            </a>
          </p>
        )}
        {!account && (
          <div className="success-info-box" style={{ textAlign: 'left' }}>
            <div className="success-info-title">⭐ {t('Create a member account?', '注册会员账户？')}</div>
            <ul style={{ margin: '6px 0 10px', paddingLeft: '18px', fontSize: '13px', lineHeight: 1.7 }}>
              <li>{t('Exclusive member vouchers & discounts', '专属会员优惠券和折扣')}</li>
              <li>{t('Order history — track all your orders', '历史订单 — 随时查看订单状态')}</li>
              <li>{t('Saved delivery address — faster checkout next time', '地址记忆 — 下次下单更快')}</li>
              <li>{t('Order confirmation sent to your email', '订单确认发送到您的邮箱')}</li>
            </ul>
            <p style={{ fontSize: '12px', color: '#888', margin: '0 0 10px' }}>
              {t('A valid email is required — we’ll send a confirmation link to activate your account.', '需要有效的邮箱 — 我们会发送确认链接激活您的账户。')}
            </p>
            <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
              <button className="auth-btn" style={{ width: 'auto', padding: '8px 18px' }} onClick={() => setView('register')}>
                {t('Create account', '注册账户')}
              </button>
              <span className="reset-link" style={{ alignSelf: 'center' }} onClick={() => setOrderDone(false)}>
                {t('No thanks, continue as guest', '不用了，继续访客身份')}
              </span>
            </div>
          </div>
        )}
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
          {account ? (
            <>
              <div className="drawer-user-greeting">{t('Welcome back,', '欢迎回来，')}</div>
              <div className="drawer-user-name">{accountName}</div>
            </>
          ) : (
            <div className="drawer-user-greeting">{t('Ordering as guest', '访客下单中')}</div>
          )}
        </div>
        <nav className="drawer-nav">
          {isAdmin && userPage !== 'preview' ? USER_NAV.map(({ key, label, labelZh }) => (
            key === 'menu' ? (
              <div key="menu">
                <button
                  className={'drawer-nav-btn drawer-nav-btn--expand' + (userPage === 'menu' && menuTab !== 'menu' ? ' active' : '')}
                  onClick={() => setMenuExpanded(e => !e)}
                >
                  <span>{t(label, labelZh)}</span>
                  <span style={{ fontSize: '10px', opacity: 0.7 }}>{menuExpanded ? '▲' : '▼'}</span>
                </button>
                {menuExpanded && (
                  <>
                    <button
                      className={'drawer-nav-btn drawer-nav-sub' + (userPage === 'menu' && menuTab === 'shipping' ? ' active' : '')}
                      onClick={() => { setUserPage('menu'); setMenuTab('shipping'); setDrawerOpen(false); setOrderDone(false); }}
                    >
                      {t('Delivery & Shipping', '送货费用')}
                    </button>
                    <button
                      className={'drawer-nav-btn drawer-nav-sub' + (userPage === 'menu' && menuTab === 'pickup' ? ' active' : '')}
                      onClick={() => { setUserPage('menu'); setMenuTab('pickup'); setDrawerOpen(false); setOrderDone(false); }}
                    >
                      {t('Pickup & Payment', '自取与付款')}
                    </button>
                    <button
                      className={'drawer-nav-btn drawer-nav-sub' + (userPage === 'menu' && menuTab === 'schedule' ? ' active' : '')}
                      onClick={() => { setUserPage('menu'); setMenuTab('schedule'); setDrawerOpen(false); setOrderDone(false); }}
                    >
                      {t('Order Schedule', '下单日期')}
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
            ) : key === 'events' ? (
              <div key="events">
                <button
                  className={'drawer-nav-btn drawer-nav-btn--expand' + (userPage === 'events' || userPage === 'vouchers' ? ' active' : '')}
                  onClick={() => setEventsExpanded(e => !e)}
                >
                  <span>{t(label, labelZh)}</span>
                  <span style={{ fontSize: '10px', opacity: 0.7 }}>{eventsExpanded ? '▲' : '▼'}</span>
                </button>
                {eventsExpanded && (
                  <>
                    <button
                      className={'drawer-nav-btn drawer-nav-sub' + (userPage === 'events' ? ' active' : '')}
                      onClick={() => { setUserPage('events'); setDrawerOpen(false); setOrderDone(false); }}
                    >
                      {t('Events', '活动')}
                    </button>
                    <button
                      className={'drawer-nav-btn drawer-nav-sub' + (userPage === 'vouchers' ? ' active' : '')}
                      onClick={() => { setUserPage('vouchers'); setDrawerOpen(false); setOrderDone(false); }}
                    >
                      {t('Vouchers', '优惠券')}
                    </button>
                  </>
                )}
              </div>
            ) : key === 'menupage' ? (
              <button
                key={key}
                className={'drawer-nav-btn' + (userPage === 'menu' && menuTab === 'menu' ? ' active' : '')}
                onClick={() => { setUserPage('menu'); setMenuTab('menu'); setDrawerOpen(false); setOrderDone(false); }}
              >
                {t(label, labelZh)}
              </button>
            ) : (
            <button
              key={key}
              className={'drawer-nav-btn' + (userPage === key ? ' active' : '')}
              onClick={() => { setUserPage(key); setDrawerOpen(false); setOrderDone(false); if (key === 'orders') setOrdersKey(k => k + 1); }}
            >
              {t(label, labelZh)}
            </button>
            )
          )) : account ? drawerNavItems.map(({ key, label }) => (
            <button
              key={key}
              className={'drawer-nav-btn' + (accountSection === key ? ' active' : '')}
              onClick={() => openSection(key)}
            >
              {label}
            </button>
          )) : (
            <>
              <button className="drawer-nav-btn" onClick={() => { setView('login'); setDrawerOpen(false); }}>{t('Sign in', '登录')}</button>
              <button className="drawer-nav-btn" onClick={() => { setView('register'); setDrawerOpen(false); }}>{t('Create account', '注册账户')}</button>
            </>
          )}
        </nav>
        {account && (
          <div className="drawer-footer">
            <button className="drawer-signout" onClick={handleLogout}>{t('Sign out', '退出登录')}</button>
          </div>
        )}
      </div>
    </>
  );

  // ── User (owner) layout ────────────────────────────────────────────────────
  if (isAdmin) {
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
            <Notifications account={account} isOwner lang={lang} onOpen={() => { setUserPage('orders'); setOrderDone(false); setOrdersKey(k => k + 1); }} />
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
                  <CustomerSettings user={account} lang={lang} settings={settings} onAddressSaved={addr => setSavedAddress(addr)} refreshKey={orderCount} section={accountSection} />
                </>
              ) : (
                <>
                  <div className="brand">
                    <h1>Bitetime &amp; Co.</h1>
                    <div className="tagline">{t('Gift the Story, Keep the Feeling.', '送出故事，留住感动。')}</div>
                    {!orderDone && <div className="subtitle">{t("Place your order below — we'll confirm via WhatsApp!", '请在下方下单 — 我们将通过 WhatsApp 确认您的订单！')}</div>}
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
          {userPage === 'events' && <AdminPanel settings={settings} lang={lang} onSave={newSettings => setSettings(newSettings)} tab="events" />}
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
          {account ? (
            <>
              Hi, <span>{accountName}</span>&nbsp;
              <a onClick={handleLogout}>{t('Sign out', '退出')}</a>
            </>
          ) : (
            <a onClick={() => setView('login')}>{t('Member sign in / register', '会员登录 / 注册')}</a>
          )}
        </div>

        <div className="cust-topbar">
          <button className="hamburger-btn" onClick={() => setDrawerOpen(true)} aria-label="My Account">
            <span /><span /><span />
          </button>
          {account && <Notifications account={account} isOwner={false} lang={lang} onOpen={() => { setOrderDone(false); setAccountSection('history'); }} />}
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
            <CustomerSettings user={account} lang={lang} settings={settings} onAddressSaved={addr => setSavedAddress(addr)} refreshKey={orderCount} section={accountSection} />
          </>
        ) : (
          <>
            <div className="brand">
              <h1>Bitetime &amp; Co.</h1>
              <div className="tagline">{t('Gift the Story, Keep the Feeling.', '送出故事，留住感动。')}</div>
              {!orderDone && <div className="subtitle">{t("Place your order below — we'll confirm via WhatsApp!", '请在下方下单 — 我们将通过 WhatsApp 确认您的订单！')}</div>}
            </div>
            {orderDone ? (
              renderSuccessBox(account ? () => { setOrderDone(false); setAccountSection('history'); } : null)
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
        {(settings.waNumber || settings.igUrl) && (
          <div style={{ textAlign: 'center', marginTop: '2rem', paddingBottom: '1rem', display: 'flex', justifyContent: 'center', gap: '16px', flexWrap: 'wrap', fontSize: '14px' }}>
            {settings.waNumber && (
              <a href={`https://wa.me/${settings.waNumber}`} target="_blank" rel="noreferrer" style={{ color: '#1da851', fontWeight: 600, textDecoration: 'none' }}>
                💬 {t('WhatsApp us', 'WhatsApp 联系我们')}
              </a>
            )}
            {settings.igUrl && (
              <a href={settings.igUrl} target="_blank" rel="noreferrer" style={{ color: '#d6336c', fontWeight: 600, textDecoration: 'none' }}>
                📸 Instagram
              </a>
            )}
          </div>
        )}
      </div>
      {sideDrawer}
    </>
  );
}
