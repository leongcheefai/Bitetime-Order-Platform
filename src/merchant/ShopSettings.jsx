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
  const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false)

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
      setMsg(t('Saved.','已保存。'))
    } catch (err) { setMsg(err.message || t('Save failed','保存失败')) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={save} style={{ display:'grid', gap:8, maxWidth:440 }}>
      <h3>{t('Shop settings','店铺设置')}</h3>
      <label>{t('Shipping West Malaysia (RM)','西马运费 (RM)')}
        <input type="number" step="0.01" value={wm} onChange={e=>setWm(e.target.value)} /></label>
      <label>{t('Shipping East Malaysia (RM)','东马运费 (RM)')}
        <input type="number" step="0.01" value={em} onChange={e=>setEm(e.target.value)} /></label>
      <label>{t('Bank / payment details','银行/付款信息')}
        <input value={bank} onChange={e=>setBank(e.target.value)} /></label>
      <label>{t('Payment note (shown to customers)','付款备注（顾客可见）')}
        <input value={note} onChange={e=>setNote(e.target.value)} /></label>
      <h4>{t('Order notifications (Telegram)','订单通知（Telegram）')}</h4>
      <label>{t('Bot token','机器人令牌')}
        <input value={tgToken} onChange={e=>setTgToken(e.target.value)} /></label>
      <label>{t('Chat ID','聊天 ID')}
        <input value={tgChat} onChange={e=>setTgChat(e.target.value)} /></label>
      <button disabled={busy}>{busy ? t('Saving…','保存中…') : t('Save settings','保存设置')}</button>
      {msg && <p>{msg}</p>}
    </form>
  )
}
