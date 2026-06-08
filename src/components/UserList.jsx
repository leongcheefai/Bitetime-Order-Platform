import { useState, useEffect } from 'react';
import { fetchAllProfiles } from '../store';

export default function UserList({ lang }) {
  const t = (en, zh) => lang === 'zh' ? zh : en;
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchAllProfiles()
      .then(setUsers)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="user-list-panel">
      <div className="admin-title">{t('Registered Users', '注册用户')}</div>
      {loading && <p className="user-list-status">{t('Loading…', '加载中…')}</p>}
      {error && <p className="user-list-status user-list-error">{t('Error: ', '错误：')}{error}</p>}
      {!loading && !error && users.length === 0 && (
        <p className="user-list-status">{t('No registered users yet.', '暂无注册用户。')}</p>
      )}
      {!loading && !error && users.length > 0 && (
        <>
          <div className="user-count">{users.length} {t('user(s)', '位用户')}</div>
          <div className="user-table-wrap">
            <table className="user-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('Name', '姓名')}</th>
                  <th>{t('Email', '邮箱')}</th>
                  <th>{t('Verified', '已验证')}</th>
                  <th>{t('Joined', '注册时间')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u, i) => (
                  <tr key={u.id}>
                    <td>{i + 1}</td>
                    <td>{u.name || '—'}</td>
                    <td>{u.email}</td>
                    <td>
                      {u.email_confirmed
                        ? <span className="order-status-badge status-pending">{t('Verified', '已验证')}</span>
                        : <span className="order-status-badge status-cancelled">{t('Unverified', '未验证')}</span>}
                    </td>
                    <td>{u.created_at ? new Date(u.created_at).toLocaleDateString('en-MY', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
