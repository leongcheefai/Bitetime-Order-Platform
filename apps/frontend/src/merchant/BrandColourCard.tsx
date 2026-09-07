import { useState } from 'react'
import { toast } from 'sonner'
import { normalizeBrandColor, PLATFORM_BRAND_COLOR } from '@bitetime/shared'
import { useSession } from '../SessionContext'
import { updateMerchantConfig } from '../store'
import BrandTheme from '../components/BrandTheme'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { useSaved } from './useSaved'
import { cn } from '@/lib/utils'

/**
 * The one colour a merchant picks for their shop.
 *
 * IN SHOP SETTINGS, on its own Brand tab. It sat on the Storefront tab first, on the reasoning
 * `ShopDescriptionCard` states there — Settings holds FACTS about the shop, Storefront holds what
 * the customer sees. That reasoning stopped applying once the colour began theming the DASHBOARD
 * too: it is no longer a storefront thing, it is shop-wide config like the currency and the tax
 * rate. The Storefront tab is also a drag surface, and a set-once picker is not workspace.
 *
 * ITS OWN Save, and the dirty flag reported UP through `onDirtyChange` — the shared shape every
 * Settings tab uses, and what lets `NavGuard` (one blocker slot) see unsaved work here.
 * `onDirtyChange` must be stable across renders; `useSaved` reports through an effect listing it.
 *
 * NO CONTRAST WARNING, deliberately. `brandTheme` makes every possible choice legible, so a warning
 * would either never appear or would be scolding the merchant about a problem already solved.
 */

/* Eight starting points, each a distinct hue at a lightness that works as a fill. They exist so a
   merchant with no hex code in hand still lands somewhere deliberate; the field beside them is for
   a shop that knows its own colour. */
const SWATCHES: { hex: string; name: [string, string] }[] = [
  { hex: PLATFORM_BRAND_COLOR, name: ['Oxblood (default)', '酒红（默认）'] },
  { hex: '#C2410C', name: ['Ember', '炭橙'] },
  { hex: '#B45309', name: ['Amber', '琥珀'] },
  { hex: '#1F5C3D', name: ['Forest', '森绿'] },
  { hex: '#0F6E6E', name: ['Teal', '青蓝'] },
  { hex: '#1E4E8C', name: ['Navy', '深蓝'] },
  { hex: '#6D28D9', name: ['Violet', '紫罗兰'] },
  { hex: '#3F3F46', name: ['Graphite', '石墨'] },
]

export default function BrandColourCard({ onDirtyChange }: {
  onDirtyChange: (dirty: boolean) => void
}) {
  const { t, merchant, refreshMerchant } = useSession()
  const merchantId = merchant!.id

  // Seeded once, like the description card: this screen calls refreshMerchant after every save,
  // and re-seeding on that would throw away whatever the merchant has been typing.
  const [text, setText] = useState<string>(merchant?.brand_color ?? '')
  const [saving, setSaving] = useState(false)

  const parsed = normalizeBrandColor(text)
  // What would be stored. Null means the platform colour, which is a valid choice, not an error.
  const pending = parsed.ok ? parsed.value : null
  const invalid = !parsed.ok

  const { dirty, commit } = useSaved(
    merchant?.brand_color ?? null,
    pending,
    (a, b) => a === b,
    onDirtyChange,
  )

  async function save() {
    if (invalid) return
    setSaving(true)
    const r = await updateMerchantConfig(merchantId, { brand_color: pending })
    setSaving(false)
    if (!r.ok) {
      toast.error(r.error.message || t('Could not save the colour', '无法保存颜色'))
      return
    }
    await refreshMerchant()
    // Committed from what the write ANSWERED with: the endpoint normalises (it uppercases, and it
    // expands the three-digit form), so committing what was typed would leave the card dirty for
    // ever, offering to save a change the shop already has.
    const applied = (r.data?.brand_color ?? null) as string | null
    setText(applied ?? '')
    commit(applied)
    toast.success(t('Colour saved', '颜色已保存'))
  }

  return (
    <div className="bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border max-sm:p-4 max-sm:mb-6">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="font-heading text-[15px] font-medium text-primary">
          {t('Brand colour', '品牌颜色')}
        </h3>
        <Button
          type="button" size="none"
          className="rounded-lg py-[6px] px-[14px] text-[13px] whitespace-nowrap"
          onClick={save}
          disabled={!dirty || saving || invalid}
        >
          {saving ? t('Saving…', '保存中…') : t('Save', '保存')}
        </Button>
      </div>

      <p className="text-[12px] text-muted-foreground leading-[1.6] mb-4 max-w-[560px]">
        {t('One colour for your storefront and this dashboard. Buttons, prices and highlights use it. Text stays readable whichever colour you pick.',
           '为您的店面和此后台设置一种颜色。按钮、价格和重点内容会使用它。无论选哪种颜色，文字都清晰可读。')}
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {SWATCHES.map(s => (
          <button
            key={s.hex}
            type="button"
            onClick={() => setText(s.hex)}
            aria-label={t(s.name[0], s.name[1])}
            aria-pressed={pending === s.hex}
            title={t(s.name[0], s.name[1])}
            className={cn(
              'size-8 rounded-full border transition-shadow',
              pending === s.hex ? 'border-foreground shadow-elev-1' : 'border-border',
            )}
            style={{ backgroundColor: s.hex }}
          />
        ))}
      </div>

      <div className="flex flex-col gap-1 max-w-[220px] mb-4">
        <Label htmlFor="brand-colour-hex">{t('Colour code', '颜色代码')}</Label>
        <Input
          id="brand-colour-hex"
          value={text}
          placeholder={PLATFORM_BRAND_COLOR}
          spellCheck={false}
          onChange={e => setText(e.target.value.toUpperCase())}
          // Normalised when the merchant leaves the field, not while they type: `#F0A` and `7a1028`
          // are both accepted, and showing them back in the stored form is how the field stops
          // disagreeing with the swatch it just matched. Invalid text is left exactly as typed.
          onBlur={() => { if (parsed.ok && parsed.value) setText(parsed.value) }}
          aria-invalid={invalid}
          aria-describedby="brand-colour-hex-hint"
        />
        {invalid ? (
          <p id="brand-colour-hex-hint" role="alert" className="text-[11px] text-danger-fg leading-[1.5]">
            {t('Use a colour code like #7A1028.', '请输入类似 #7A1028 的颜色代码。')}
          </p>
        ) : (
          <p id="brand-colour-hex-hint" className="text-[11px] text-muted-foreground leading-[1.5]">
            {pending
              ? t('Reset to go back to the default colour.', '重置可恢复默认颜色。')
              : t('Your shop uses the default colour.', '您的店铺使用默认颜色。')}
          </p>
        )}
      </div>

      {/* Clearing the field by hand is not a control. This one writes NULL — never the platform
          hex — so a shop that resets is a shop that never chose, and a later change to the default
          still reaches it. */}
      {(pending || invalid) && (
        <div className="mb-4">
          <Button
            type="button" variant="link" size="none"
            className="text-[12px]"
            onClick={() => setText('')}
          >
            {t('Reset to default', '恢复默认')}
          </Button>
        </div>
      )}

      {/* The preview renders inside the SAME component the storefront mounts, fed the pending
          value — so what the merchant sees here cannot drift from what the customer gets. */}
      <BrandTheme color={pending}>
        <div className="rounded-xl border border-border bg-brand-100 p-4 flex flex-wrap items-center gap-3">
          <Button type="button" size="none" className="rounded-lg py-[6px] px-[14px] text-[13px]">
            {t('Add to cart', '加入购物车')}
          </Button>
          <span className="text-[15px] font-medium text-primary">RM 12.00</span>
          <span className="text-[11px] font-medium text-primary uppercase tracking-[0.09em]">
            {t('Menu', '菜单')}
          </span>
        </div>
      </BrandTheme>
    </div>
  )
}
