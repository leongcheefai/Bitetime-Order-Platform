import { useState } from 'react';
import { getUsers, setSession } from '../store';

export default function LoginView({ onLogin, onShowRegister }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  function handleLogin() {
    const users = getUsers();
    const user = users.find(u => u.email === email.trim().toLowerCase() && u.password === password);
    if (!user) { setError('Incorrect email or password.'); return; }
    setSession(user.email);
    onLogin(user.email);
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
        <button className="auth-btn" onClick={handleLogin}>Sign in</button>
        <div className="auth-switch">Don't have an account? <a onClick={onShowRegister}>Create one</a></div>
      </div>
    </div>
  );
}
