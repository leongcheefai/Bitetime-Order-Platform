import { useState } from 'react';
import { signUp } from '../store';

export default function RegisterView({ onShowLogin, onBack, lang = 'en', setLang }) {
  const t = (en, zh) => lang === 'zh' ? zh : en;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleRegister() {
    if (!name.trim())                          { setError(t('Please enter your name.', '请输入您的姓名。')); return; }
    if (!email.trim() || !email.includes('@')) { setError(t('Please enter a valid email.', '请输入有效的邮箱。')); return; }
    if (password.length < 6)                   { setError(t('Password must be at least 6 characters.', '密码至少需要 6 个字符。')); return; }
    if (password !== confirm)                  { setError(t('Passwords do not match.', '两次输入的密码不一致。')); return; }
    setLoading(true);
    try {
      await signUp(name.trim(), email.trim().toLowerCase(), password);
      // If email confirmation is disabled in Supabase, onAuthChange fires and logs user in automatically.
      // If confirmation is required, show a prompt.
      setSuccess(true);
    } catch (err) {
      setError(err.message || t('Registration failed. Please try again.', '注册失败，请重试。'));
    } finally {
      setLoading(false);
    }
  }

  const langSwitcher = setLang && (
    <div className="lang-switcher" style={{ marginBottom: '1rem' }}>
      <button className={'lang-btn' + (lang === 'en' ? ' active' : '')} onClick={() => setLang('en')}>🇬🇧 English</button>
      <button className={'lang-btn' + (lang === 'zh' ? ' active' : '')} onClick={() => setLang('zh')}>🇨🇳 中文</button>
    </div>
  );

  if (success) {
    return (
      <div className="auth-wrap">
        {langSwitcher}
        <div className="brand" style={{ marginBottom: '1.75rem' }}>
          <h1>Bitetime &amp; Co.</h1>
          <div className="tagline">{t('Gift the Story, Keep the Feeling.', '送出故事，留住感动。')}</div>
        </div>
        <div className="auth-card">
          <div className="auth-title">{t('Check your email', '查看您的邮箱')}</div>
          <div className="auth-subtitle">{t('We sent a confirmation link to', '确认链接已发送至')} <strong>{email}</strong>{t('. Click it to activate your account, then sign in.', '。点击链接激活账户后即可登录。')}</div>
          <button className="auth-btn" onClick={onShowLogin} style={{ marginTop: '1.25rem' }}>{t('Back to sign in', '返回登录')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      {langSwitcher}
      <div className="brand" style={{ marginBottom: '1.75rem' }}>
        <h1>Bitetime &amp; Co.</h1>
        <div className="tagline">{t('Gift the Story, Keep the Feeling.', '送出故事，留住感动。')}</div>
      </div>
      <div className="auth-card">
        <div className="auth-title">{t('Create account', '注册账户')}</div>
        <div className="auth-subtitle">{t('Members get vouchers, saved addresses & order history 🍪', '会员享有优惠券、地址记忆和历史订单 🍪')}</div>
        {error && <div className="auth-error">{error}</div>}
        <div className="auth-fields">
          <div className="field">
            <label>{t('Full name', '姓名')}</label>
            <input type="text" placeholder={t('Your name', '您的姓名')} value={name} onChange={e => { setName(e.target.value); setError(''); }} />
          </div>
          <div className="field">
            <label>{t('Email', '邮箱')}</label>
            <input type="email" placeholder="you@example.com" value={email} onChange={e => { setEmail(e.target.value); setError(''); }} />
          </div>
          <div className="field">
            <label>{t('Password', '密码')}</label>
            <input type="password" placeholder={t('At least 6 characters', '至少 6 个字符')} value={password} onChange={e => { setPassword(e.target.value); setError(''); }} />
          </div>
          <div className="field">
            <label>{t('Confirm password', '确认密码')}</label>
            <input type="password" placeholder={t('Repeat your password', '再次输入密码')} value={confirm} onChange={e => { setConfirm(e.target.value); setError(''); }} onKeyDown={e => e.key === 'Enter' && handleRegister()} />
          </div>
        </div>
        <button className="auth-btn" onClick={handleRegister} disabled={loading}>{loading ? t('Creating…', '注册中…') : t('Create account', '注册账户')}</button>
        <div className="auth-switch">{t('Already have an account?', '已有账户？')} <a onClick={onShowLogin}>{t('Sign in', '登录')}</a></div>
        {onBack && (
          <div className="auth-switch" style={{ marginTop: '0.75rem' }}>
            <a onClick={onBack}>{t('← Continue as guest (order without account)', '← 以访客身份下单（无需账户）')}</a>
          </div>
        )}
      </div>
    </div>
  );
}
