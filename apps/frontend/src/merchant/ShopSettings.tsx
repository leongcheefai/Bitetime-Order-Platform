import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { updateMerchantConfig, fetchMerchantSecret, upsertMerchantSecret } from '../store'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'

export default function ShopSettings() {
  const { t, merchant, refreshMerchant } = useSession()
  const [wm, setWm] = useState(merchant!.shipping?.WM ?? 8)
  const [em, setEm] = useState(merchant!.shipping?.EM ?? 18)
  const [bank, setBank] = useState(merchant!.payment_bank ?? '')
  const [note, setNote] = useState(merchant!.payment_note ?? '')
  const [tgToken, setTgToken] = useState('')
  const [tgChat, setTgChat] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchMerchantSecret(merchant!.id).then((s: any) => {
      if (s) { setTgToken(s.tg_token ?? ''); setTgChat(s.tg_chat_id ?? '') }
    })
  }, [merchant!.id])

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMsg('')
    try {
      await updateMerchantConfig(merchant!.id, {
        shipping: { WM: Number(wm) || 0, EM: Number(em) || 0 },
        payment_bank: bank, payment_note: note,
      })
      await upsertMerchantSecret(merchant!.id, { tg_token: tgToken, tg_chat_id: tgChat })
      await refreshMerchant()
      setMsg(t('Saved.', '已保存。'))
    } catch (err: any) { setMsg(err.message || t('Save failed', '保存失败')) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={save}>
      <div className="admin-panel">
        <h3 className="font-heading text-[15px] font-medium text-oxblood mb-4 flex items-center gap-2">
          {t('Shipping rates', '运费')}
        </h3>
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-1">{t('West Malaysia (RM)', '西马运费 (RM)')}</Label>
            <Input id="shop-1" type="number" step="0.01" value={wm} onChange={e => setWm(e.target.value)} variant="compact" />
          </div>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-2">{t('East Malaysia (RM)', '东马运费 (RM)')}</Label>
            <Input id="shop-2" type="number" step="0.01" value={em} onChange={e => setEm(e.target.value)} variant="compact" />
          </div>
        </div>
      </div>

      <div className="admin-panel">
        <h3 className="font-heading text-[15px] font-medium text-oxblood mb-4 flex items-center gap-2">
          {t('Payment', '付款')}
        </h3>
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-3">{t('Bank / payment details', '银行/付款信息')}</Label>
            <Input id="shop-3" value={bank} onChange={e => setBank(e.target.value)} variant="compact" />
          </div>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-4">{t('Payment note (shown to customers)', '付款备注（顾客可见）')}</Label>
            <Input id="shop-4" value={note} onChange={e => setNote(e.target.value)} variant="compact" />
          </div>
        </div>
      </div>

      <div className="admin-panel">
        <h3 className="font-heading text-[15px] font-medium text-oxblood mb-4 flex items-center gap-2">
          {t('Order notifications', '订单通知')}
        </h3>
        <p className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em] mb-3">Telegram</p>
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-5">{t('Bot token', '机器人令牌')}</Label>
            <Input id="shop-5" value={tgToken} onChange={e => setTgToken(e.target.value)} variant="compact" />
          </div>
          <div className="flex flex-col gap-[6px]">
            <Label htmlFor="shop-6">{t('Chat ID', '聊天 ID')}</Label>
            <Input id="shop-6" value={tgChat} onChange={e => setTgChat(e.target.value)} variant="compact" />
          </div>
        </div>
      </div>

      <Button type="submit" size="md" className="mt-1" disabled={busy}>
        {busy ? t('Saving…', '保存中…') : t('Save settings', '保存设置')}
      </Button>
      {msg && <p className="text-[13px] text-oxblood font-medium text-center mt-2 min-h-[18px]">{msg}</p>}
    </form>
  )
}
