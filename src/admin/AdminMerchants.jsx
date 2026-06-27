import { useEffect, useState } from 'react'
import { fetchAllMerchants, setMerchantStatus } from '../store'
import { useSession } from '../SessionContext'

export default function AdminMerchants() {
  const { t } = useSession()
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(null)

  async function load() { setRows(await fetchAllMerchants()) }
  useEffect(() => { load() }, [])

  async function act(id, status) {
    setBusy(id)
    try { await setMerchantStatus(id, status); await load() }
    finally { setBusy(null) }
  }

  if (!rows) return <div style={{ padding: 24 }}>{t('Loading…','加载中…')}</div>

  return (
    <div style={{ padding: 24, maxWidth: 760 }}>
      <h2>{t('Merchants','商家')}</h2>
      {rows.length === 0 && <p>{t('No merchants yet.','暂无商家。')}</p>}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={{ textAlign:'left' }}>{t('Shop','店铺')}</th>
          <th style={{ textAlign:'left' }}>{t('Slug','网址')}</th>
          <th style={{ textAlign:'left' }}>{t('Status','状态')}</th>
          <th>{t('Actions','操作')}</th>
        </tr></thead>
        <tbody>
          {rows.map(m => (
            <tr key={m.id} style={{ borderTop:'1px solid #eee' }}>
              <td>{m.name}</td>
              <td>/s/{m.slug}</td>
              <td>{m.status}</td>
              <td style={{ textAlign:'right' }}>
                {m.status === 'pending' && <>
                  <button disabled={busy===m.id} onClick={() => act(m.id,'active')}>{t('Approve','批准')}</button>{' '}
                  <button disabled={busy===m.id} onClick={() => act(m.id,'suspended')}>{t('Reject','拒绝')}</button>
                </>}
                {m.status === 'active' && <button disabled={busy===m.id} onClick={() => act(m.id,'suspended')}>{t('Suspend','暂停')}</button>}
                {m.status === 'suspended' && <button disabled={busy===m.id} onClick={() => act(m.id,'active')}>{t('Reactivate','恢复')}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
