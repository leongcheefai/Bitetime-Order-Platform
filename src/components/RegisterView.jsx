import { useState } from 'react';
import { getUsers, saveUsers, setSession } from '../store';

export default function RegisterView({ onLogin, onShowLogin }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');

  function handleRegister() {
    if (!name.trim())                          { setError('Please enter your name.'); return; }
    if (!email.trim() || !email.includes('@')) { setError('Please enter a valid email.'); return; }
    if (password.length < 6)                   { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm)                  { setError('Passwords do not match.'); return; }
    const users = getUsers();
    if (users.find(u => u.email === email.trim().toLowerCase())) { setError('An account with this email already exists.'); return; }
    const newUser = { name: name.trim(), email: email.trim().toLowerCase(), password };
    saveUsers([...users, newUser]);
    setSession(newUser.email);
    onLogin(newUser.email);
  }

  return (
    <div className="auth-wrap">
      <div className="brand" style={{ marginBottom: '1.75rem' }}>
        <h1>Bitetime &amp; Co.</h1>
        <div className="tagline">Gift the Story, Keep the Feeling.</div>
      </div>
      <div className="auth-card">
        <div className="auth-title">Create account</div>
        <div className="auth-subtitle">Join us and start ordering your favourite cookies 🍪</div>
        {error && <div className="auth-error">{error}</div>}
        <div className="auth-fields">
          <div className="field">
            <label>Full name</label>
            <input type="text" placeholder="e.g. Sarah" value={name} onChange={e => { setName(e.target.value); setError(''); }} />
          </div>
          <div className="field">
            <label>Email</label>
            <input type="email" placeholder="you@example.com" value={email} onChange={e => { setEmail(e.target.value); setError(''); }} />
          </div>
          <div className="field">
            <label>Password</label>
            <input type="password" placeholder="At least 6 characters" value={password} onChange={e => { setPassword(e.target.value); setError(''); }} />
          </div>
          <div className="field">
            <label>Confirm password</label>
            <input type="password" placeholder="Repeat your password" value={confirm} onChange={e => { setConfirm(e.target.value); setError(''); }} onKeyDown={e => e.key === 'Enter' && handleRegister()} />
          </div>
        </div>
        <button className="auth-btn" onClick={handleRegister}>Create account</button>
        <div className="auth-switch">Already have an account? <a onClick={onShowLogin}>Sign in</a></div>
      </div>
    </div>
  );
}
