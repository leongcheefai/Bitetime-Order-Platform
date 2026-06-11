import { useState } from 'react';
import { signIn, resetPassword } from '../store';

export default function LoginView({ onShowRegister, onBack, lang = 'en', setLang }) {
  const t = (en, zh) => lang === 'zh' ? zh : en;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);

  async function handleLogin() {
    if (!email.trim() || !password) { setError(t('Please enter your email and password.', '请输入您的邮箱和密码。')); return; }
    setLoading(true);
    try {
      await signIn(email.trim().toLowerCase(), password);
      // App.jsx picks up the new session via onAuthChange — no callback needed
    } catch (err) {
      setError(err.message || t('Incorrect email or password.', '邮箱或密码不正确。'));
    } finally {
      setLoading(false);
    }
  }

  async function handleReset() {
    if (!email.trim() || !email.includes('@')) { setError(t('Please enter your email first.', '请先输入您的邮箱。')); return; }
    setLoading(true);
    setError('');
    try {
      await resetPassword(email.trim().toLowerCase());
      setInfo(t('Reset link sent! Check your email inbox.', '重设链接已发送！请查看您的邮箱。'));
    } catch (err) {
      setError(err.message || t('Failed to send reset email.', '发送重设邮件失败。'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-wrap">
      {setLang && (
        <div className="lang-switcher" style={{ marginBottom: '1rem' }}>
          <button className={'lang-btn' + (lang === 'en' ? ' active' : '')} onClick={() => setLang('en')}>🇬🇧 English</button>
          <button className={'lang-btn' + (lang === 'zh' ? ' active' : '')} onClick={() => setLang('zh')}>🇨🇳 中文</button>
        </div>
      )}
      <div className="brand" style={{ marginBottom: '1.75rem' }}>
        <h1>Bitetime &amp; Co.</h1>
        <div className="tagline">{t('Gift the Story, Keep the Feeling.', '送出故事，留住感动。')}</div>
      </div>
      <div className="auth-card">
        <div className="auth-title">{forgotMode ? t('Reset password', '重设密码') : t('Welcome back', '欢迎回来')}</div>
        <div className="auth-subtitle">
          {forgotMode
            ? t("Enter your email and we'll send you a reset link", '输入您的邮箱，我们会发送重设链接')
            : t('Sign in to your member account', '登录您的会员账户')}
        </div>
        {error && <div className="auth-error">{error}</div>}
        {info && <div className="auth-error" style={{ background: '#e6f7ec', color: '#1d7a3d' }}>{info}</div>}
        <div className="auth-fields">
          <div className="field">
            <label>{t('Email', '邮箱')}</label>
            <input type="email" placeholder="you@example.com" value={email} onChange={e => { setEmail(e.target.value); setError(''); }} onKeyDown={e => forgotMode && e.key === 'Enter' && handleReset()} />
          </div>
          {!forgotMode && (
            <div className="field">
              <label>{t('Password', '密码')}</label>
              <input type="password" placeholder={t('Your password', '您的密码')} value={password} onChange={e => { setPassword(e.target.value); setError(''); }} onKeyDown={e => e.key === 'Enter' && handleLogin()} />
            </div>
          )}
        </div>
        {forgotMode ? (
          <>
            <button className="auth-btn" onClick={handleReset} disabled={loading}>{loading ? t('Sending…', '发送中…') : t('Send reset link', '发送重设链接')}</button>
            <div className="auth-switch"><a onClick={() => { setForgotMode(false); setError(''); setInfo(''); }}>{t('← Back to sign in', '← 返回登录')}</a></div>
          </>
        ) : (
          <>
            <button className="auth-btn" onClick={handleLogin} disabled={loading}>{loading ? t('Signing in…', '登录中…') : t('Sign in', '登录')}</button>
            <div className="auth-switch" style={{ marginTop: '0.5rem' }}>
              <a onClick={() => { setForgotMode(true); setError(''); }}>{t('Forgot password?', '忘记密码？')}</a>
            </div>
            <div className="auth-switch">{t("Don't have an account?", '还没有账户？')} <a onClick={onShowRegister}>{t('Create one', '注册一个')}</a></div>
          </>
        )}
        {onBack && (
          <div className="auth-switch" style={{ marginTop: '0.75rem' }}>
            <a onClick={onBack}>{t('← Continue as guest (order without account)', '← 以访客身份下单（无需账户）')}</a>
          </div>
        )}
      </div>
    </div>
  );
}
