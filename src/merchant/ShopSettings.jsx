import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { updateMerchantConfig, fetchMerchantSecret, upsertMerchantSecret } from '../store'

export default function ShopSettings() {
  const { t, merchant, refreshMerchant } = useSession()
  const [wm, setWm] = useState(merchant.shipping?.WM ?? 8)
  const [em, setEm] = useState(merchant.shipping?.EM ?? 18)
  const [bank, setBank] = useState(merchant.payment_bank ?? '')
  const [note, setNote] = useState(merchant.payment_note ?? '')
  const [tgToken, setTgToken] = useState('')
  const [tgChat, setTgChat] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchMerchantSecret(merchant.id).then(s => {
      if (s) { setTgToken(s.tg_token ?? ''); setTgChat(s.tg_chat_id ?? '') }
    })
  }, [merchant.id])

  async function save(e) {
    e.preventDefault(); setBusy(true); setMsg('')
    try {
      await updateMerchantConfig(merchant.id, {
        shipping: { WM: Number(wm) || 0, EM: Number(em) || 0 },
        payment_bank: bank, payment_note: note,
      })
      await upsertMerchantSecret(merchant.id, { tg_token: tgToken, tg_chat_id: tgChat })
      await refreshMerchant()
      setMsg(t('Saved.', '已保存。'))
    } catch (err) { setMsg(err.message || t('Save failed', '保存失败')) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={save}>
      <div className="admin-panel">
        <h3 className="admin-title">{t('Shipping rates', '运费')}</h3>
        <div className="admin-fields">
          <div className="admin-field full">
            <label htmlFor="shop-1">{t('West Malaysia (RM)', '西马运费 (RM)')}</label>
            <input id="shop-1" type="number" step="0.01" value={wm} onChange={e => setWm(e.target.value)} />
          </div>
          <div className="admin-field full">
            <label htmlFor="shop-2">{t('East Malaysia (RM)', '东马运费 (RM)')}</label>
            <input id="shop-2" type="number" step="0.01" value={em} onChange={e => setEm(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="admin-panel">
        <h3 className="admin-title">{t('Payment', '付款')}</h3>
        <div className="admin-fields">
          <div className="admin-field full">
            <label htmlFor="shop-3">{t('Bank / payment details', '银行/付款信息')}</label>
            <input id="shop-3" value={bank} onChange={e => setBank(e.target.value)} />
          </div>
          <div className="admin-field full">
            <label htmlFor="shop-4">{t('Payment note (shown to customers)', '付款备注（顾客可见）')}</label>
            <input id="shop-4" value={note} onChange={e => setNote(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="admin-panel">
        <h3 className="admin-title">{t('Order notifications', '订单通知')}</h3>
        <p className="admin-section-label" style={{ marginBottom: '0.75rem' }}>Telegram</p>
        <div className="admin-fields">
          <div className="admin-field full">
            <label htmlFor="shop-5">{t('Bot token', '机器人令牌')}</label>
            <input id="shop-5" value={tgToken} onChange={e => setTgToken(e.target.value)} />
          </div>
          <div className="admin-field full">
            <label htmlFor="shop-6">{t('Chat ID', '聊天 ID')}</label>
            <input id="shop-6" value={tgChat} onChange={e => setTgChat(e.target.value)} />
          </div>
        </div>
      </div>

      <button type="submit" className="save-btn" disabled={busy}>
        {busy ? t('Saving…', '保存中…') : t('Save settings', '保存设置')}
      </button>
      {msg && <p className="mm-save-msg">{msg}</p>}
    </form>
  )
}
