import { useState } from 'react';
import { signIn } from '../store';

export default function LoginView({ onLogin, onShowRegister }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    if (!email.trim() || !password) { setError('Please enter your email and password.'); return; }
    setLoading(true);
    try {
      await signIn(email.trim().toLowerCase(), password);
      // App.jsx picks up the new session via onAuthChange — no callback needed
    } catch (err) {
      setError(err.message || 'Incorrect email or password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="brand" style={{ marginBottom: '1.75rem' }}>
        <h1>Bitetime &amp; Co.</h1>
        <div className="tagline">Gift the Story, Keep the Feeling.</div>
      </div>
      <div className="auth-card">
        <div className="auth-title">Welcome back</div>
        <div className="auth-subtitle">Sign in to place your order</div>
        {error && <div className="auth-error">{error}</div>}
        <div className="auth-fields">
          <div className="field">
            <label>Email</label>
            <input type="email" placeholder="you@example.com" value={email} onChange={e => { setEmail(e.target.value); setError(''); }} />
          </div>
          <div className="field">
            <label>Password</label>
            <input type="password" placeholder="Your password" value={password} onChange={e => { setPassword(e.target.value); setError(''); }} onKeyDown={e => e.key === 'Enter' && handleLogin()} />
          </div>
        </div>
        <button className="auth-btn" onClick={handleLogin} disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button>
        <div className="auth-switch">Don't have an account? <a onClick={onShowRegister}>Create one</a></div>
      </div>
    </div>
  );
}
