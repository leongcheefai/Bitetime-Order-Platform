import { useEffect, useState } from 'react'
import { Ticket } from 'lucide-react'
import { useSession } from '../SessionContext'
import { toast } from 'sonner'
import { fetchMerchantVouchers, createMerchantVoucher, deleteMerchantVoucher } from '../store'
import { formatMoney, currencyDef } from '../currency'
import { isRequiresPro } from '../plan'
import { SkeletonText } from '../components/Loaders'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '../components/ui/empty'
import type { Voucher } from '../types'

const BLANK = { code: '', kind: 'percent', amount: '', maxUses: '' }

// Unambiguous alphabet (no 0/O/1/I) so codes read cleanly aloud
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function randomChars(len: number) {
  let out = ''
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return out
}
// Per-merchant voucher code: <SLUG-PREFIX>-XXXXX — prefix keeps codes unique across shops
function voucherPrefix(slug: string) {
  const alnum = String(slug ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return alnum.slice(0, 4) || 'SHOP'
}
function generateVoucherCode(slug: string) {
  return `${voucherPrefix(slug)}-${randomChars(5)}`
}

// Self-contained select classes — pixel-match of .admin-field select in .admin-field.full context
const SELECT_CLS =
  'w-full py-[7px] pl-[10px] pr-[32px] border border-clay-border rounded-sm text-[13px] ' +
  'bg-cream text-ink font-sans appearance-none bg-no-repeat cursor-pointer ' +
  'focus:outline-none focus:border-oxblood focus:shadow-[0_0_0_2px_rgba(122,16,40,0.1)]'

// Chevron SVG data-URI — matches the one in .admin-field select
const CHEVRON_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%237A4F55' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`

export default function VouchersManager() {
  const { t, merchant } = useSession()
  const [rows, setRows] = useState<Voucher[] | null>(null)
  const [form, setForm] = useState<any>(BLANK)
  const [busy, setBusy] = useState(false)
  const currency = merchant?.currency
  const symbol = currencyDef(currency).symbol

  async function load() { setRows(await fetchMerchantVouchers(merchant!.id)) }
  useEffect(() => { fetchMerchantVouchers(merchant!.id).then(setRows) }, [merchant!.id])

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true)
    try {
      await createMerchantVoucher({
        merchantId: merchant!.id,
        code: form.code,
        kind: form.kind,
        amount: Number(form.amount) || 0,
        maxUses: form.maxUses === '' ? null : Number(form.maxUses),
      })
      setForm(BLANK); await load()
      toast.success(t('Voucher created', '优惠券已创建'))
    } catch (err) {
      // The whole section is replaced by an upgrade prompt for a basic shop, so this is the
      // fallback for a `plan` that changed under a long-open tab (#110).
      toast.error(isRequiresPro(err)
        ? t('Vouchers are a Pro feature. Upgrade to Pro to create one.', '优惠券是 Pro 功能。升级到 Pro 即可创建。')
        : t('Could not create voucher — is the code already used?', '无法创建优惠券 — 优惠码是否已存在？'))
    } finally { setBusy(false) }
  }

  async function remove(id: string) {
    try {
      await deleteMerchantVoucher(id, merchant!.id); await load()
      toast.success(t('Voucher deleted', '优惠券已删除'))
    } catch (err) {
      // Delete is gated too (#110) — the backend refuses the whole voucher mutation surface,
      // not just create. Without this the refusal would be an unhandled rejection and the row
      // would simply stay put with nothing said.
      toast.error(isRequiresPro(err)
        ? t('Vouchers are a Pro feature. Upgrade to Pro to manage them.', '优惠券是 Pro 功能。升级到 Pro 即可管理。')
        : t('Could not delete voucher', '无法删除优惠券'))
    }
  }

  function valueLabel(v: Voucher) {
    const value = (v as any).value
    return (v as any).type === 'percent' ? `${value}% off` : `${formatMoney(value, currency)} off`
  }
  function usesLabel(v: Voucher) {
    const used = Array.isArray(v.usedBy) ? v.usedBy.length : 0
    const cap = v.maxUses == null ? '∞' : v.maxUses
    return t(`${used} / ${cap} used`, `已用 ${used} / ${cap}`)
  }

  if (!rows) return (
    <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
      <SkeletonText lines={4} />
    </div>
  )

  return (
    <div>
      {/* Your vouchers panel */}
      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
        <h3 className="font-heading text-[15px] font-medium text-oxblood mb-4 flex items-center gap-2">
          {t('Your vouchers', '您的优惠券')}
        </h3>
        {rows.length === 0 ? (
          <Empty className="border-[1.5px] border-dashed border-clay-border bg-cream/50">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="bg-oxblood-tint text-oxblood">
                <Ticket />
              </EmptyMedia>
              <EmptyTitle className="text-oxblood">{t('No vouchers yet', '还没有优惠券')}</EmptyTitle>
              <EmptyDescription className="text-rose-muted">
                {t('Create your first voucher below to offer discounts at checkout.', '在下方创建第一张优惠券，为结账提供折扣。')}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((v: Voucher) => (
              <div
                key={(v as any).id}
                className="flex items-center gap-3 px-[14px] py-[10px] bg-cream border-[1.5px] border-clay-border rounded-lg transition-colors max-[480px]:flex-wrap"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-medium text-ink">{v.code}</div>
                  <div className="text-[12px] text-rose-muted mt-0.5">{valueLabel(v)} · {usesLabel(v)}</div>
                </div>
                <div className="flex gap-[6px] shrink-0 max-[480px]:w-full max-[480px]:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="none"
                    className="rounded-pill py-[5px] px-3 text-[12px] bg-surface-raised whitespace-nowrap hover:border-oxblood hover:text-oxblood hover:bg-oxblood-tint"
                    onClick={() => remove((v as any).id)}
                  >
                    {t('Delete', '删除')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create a voucher panel */}
      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
        <h3 className="font-heading text-[15px] font-medium text-oxblood mb-4 flex items-center gap-2">
          {t('Create a voucher', '创建优惠券')}
        </h3>
        <form onSubmit={save}>
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="vm-code">{t('Code', '优惠码')}</Label>
              <div className="flex gap-2">
                <Input
                  id="vm-code"
                  variant="compact"
                  className="flex-1"
                  value={form.code}
                  onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })}
                  required
                  placeholder={t('e.g. SAVE10', '如：SAVE10')}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="none"
                  className="shrink-0 rounded-sm px-3 text-[12px] bg-surface-raised whitespace-nowrap hover:border-oxblood hover:text-oxblood hover:bg-oxblood-tint"
                  onClick={() => setForm({ ...form, code: generateVoucherCode(merchant!.slug) })}
                >
                  {t('Generate', '生成')}
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="vm-kind">{t('Type', '类型')}</Label>
              <select
                id="vm-kind"
                className={SELECT_CLS}
                style={{ backgroundImage: CHEVRON_SVG, backgroundPosition: 'right 10px center' }}
                value={form.kind}
                onChange={e => setForm({ ...form, kind: e.target.value })}
              >
                <option value="percent">{t('Percentage (%)', '百分比 (%)')}</option>
                <option value="fixed">{t(`Fixed amount (${symbol})`, `固定金额 (${symbol})`)}</option>
              </select>
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="vm-amount">
                {form.kind === 'percent' ? t('Percent off', '折扣百分比') : t(`Amount off (${symbol})`, `折扣金额 (${symbol})`)}
              </Label>
              <Input
                id="vm-amount"
                variant="compact"
                type="number"
                step={form.kind === 'percent' ? '1' : '0.01'}
                value={form.amount}
                onChange={e => setForm({ ...form, amount: e.target.value })}
                required
                placeholder={form.kind === 'percent' ? '10' : '5.00'}
              />
            </div>
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="vm-max">{t('Max total uses (blank = unlimited)', '最大使用次数（留空 = 不限）')}</Label>
              <Input
                id="vm-max"
                variant="compact"
                type="number"
                step="1"
                value={form.maxUses}
                onChange={e => setForm({ ...form, maxUses: e.target.value })}
                placeholder={t('unlimited', '不限')}
              />
            </div>
          </div>
          <Button type="submit" size="md" className="mt-3" disabled={busy}>
            {busy ? t('Saving…', '保存中…') : t('Create voucher', '创建优惠券')}
          </Button>
        </form>
      </div>
    </div>
  )
}
