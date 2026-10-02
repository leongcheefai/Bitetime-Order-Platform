import { Mail } from 'lucide-react'
import { useSession } from '../SessionContext'
import { SUPPORT_EMAIL, supportMailto } from '../support'
import { cn } from '@/lib/utils'

/**
 * How a merchant reaches a human outside the support chat: mail.
 *
 * Merchant-side only, and only inside the Help panel (SupportFab). The sidebar used to carry a
 * stacked copy, and both used to offer WhatsApp; the panel's chat replaced both.
 *
 * `compact` is one muted line (the feedback form, the chat's "could not alert" notice); the
 * default is stacked and tappable (the panel's "chat not available" view).
 */
export default function SupportLinks({ compact = false }: { compact?: boolean }) {
  const { t, merchant } = useSession()
  const mailto = supportMailto(merchant ? { name: merchant.name, slug: merchant.slug } : undefined)

  const link = cn(
    'inline-flex items-center gap-1.5 font-sans',
    'text-primary transition-colors duration-150 hover:text-brand-600',
    compact ? 'text-[12px]' : 'text-[12px] py-1 [@media(pointer:coarse)]:min-h-[36px]',
  )
  const icon = { size: compact ? 13 : 14, strokeWidth: 1.75 }

  return (
    <div className={cn(compact ? 'flex flex-wrap items-center gap-x-3 gap-y-1' : 'flex flex-col')}>
      <span className={cn('text-[11px] text-muted-foreground', !compact && 'mb-1')}>
        {compact
          ? t('Need an answer?', '需要回复？')
          : t('Contact us', '联系我们')}
      </span>
      {/* A label, never the address itself. In a narrow column the 30-character address clipped
          mid-word, which reads as a broken address rather than a truncated one. The real value
          goes in `title`, for a merchant who wants to copy it. */}
      <a className={link} href={mailto} title={SUPPORT_EMAIL}>
        <Mail {...icon} />
        {t('Email us', '发邮件给我们')}
      </a>
    </div>
  )
}
