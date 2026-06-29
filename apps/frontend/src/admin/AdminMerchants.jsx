import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchAllMerchants, setMerchantStatus } from '../store'
import { useSession } from '../SessionContext'

export default function AdminMerchants() {
  const { t } = useSession()
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(null)

  async function load() { setRows(await fetchAllMerchants()) }
  useEffect(() => { fetchAllMerchants().then(setRows) }, [])

  async function act(id, status) {
    setBusy(id)
    try { await setMerchantStatus(id, status); await load() }
    finally { setBusy(null) }
  }

  if (!rows) return (
    <div className="form-wrap">
      <p className="empty-msg" style={{ paddingTop: '2rem', textAlign: 'center' }}>
        {t('Loading…', '加载中…')}
      </p>
    </div>
  )

  return (
    <div className="form-wrap form-wrap--wide">
      <div className="brand">
        <h1>{t('Merchants', '商家')}</h1>
        <p className="tagline">{t('Platform admin', '平台管理')}</p>
      </div>
      <div className="admin-panel">
        {rows.length === 0 ? (
          <p className="empty-msg">{t('No merchants yet.', '暂无商家。')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mm-table">
              <thead>
                <tr>
                  <th>{t('Shop', '店铺')}</th>
                  <th>{t('Slug', '网址')}</th>
                  <th>{t('Status', '状态')}</th>
                  <th>{t('Open', '打开')}</th>
                  <th className="mm-table-actions">{t('Actions', '操作')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(m => (
                  <tr key={m.id}>
                    <td style={{ fontWeight: 500 }}>{m.name}</td>
                    <td>
                      <a href={`/s/${m.slug}`} target="_blank" rel="noopener noreferrer" className="mm-store-url mm-store-url--link">/s/{m.slug}</a>
                    </td>
                    <td>
                      <span className={`mm-badge mm-badge--${m.status}`}>{m.status}</span>
                    </td>
                    <td>
                      <span className="mm-open-links">
                        <Link to={`/merchant/${m.slug}`} className="mm-open-link">{t('Dashboard', '后台')}</Link>
                      </span>
                    </td>
                    <td className="mm-table-actions">
                      {m.status === 'pending' && <>
                        <button
                          className="mm-act-btn mm-act-btn--primary"
                          disabled={busy === m.id}
                          onClick={() => act(m.id, 'active')}
                        >{t('Approve', '批准')}</button>
                        <button
                          className="mm-act-btn"
                          disabled={busy === m.id}
                          onClick={() => act(m.id, 'suspended')}
                        >{t('Reject', '拒绝')}</button>
                      </>}
                      {m.status === 'active' && (
                        <button
                          className="mm-act-btn"
                          disabled={busy === m.id}
                          onClick={() => act(m.id, 'suspended')}
                        >{t('Suspend', '暂停')}</button>
                      )}
                      {m.status === 'suspended' && (
                        <button
                          className="mm-act-btn mm-act-btn--primary"
                          disabled={busy === m.id}
                          onClick={() => act(m.id, 'active')}
                        >{t('Reactivate', '恢复')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
