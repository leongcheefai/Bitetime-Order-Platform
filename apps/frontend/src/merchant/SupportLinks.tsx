import { Mail, MessageCircle } from 'lucide-react'
import { useSession } from '../SessionContext'
import { SUPPORT_EMAIL, SUPPORT_WA_DISPLAY, SUPPORT_WA_HREF, supportMailto } from '../support'
import { cn } from '@/lib/utils'

/**
 * The two ways a merchant reaches a human outside the support chat: mail and WhatsApp.
 *
 * Merchant-side only, and only inside the Help panel (SupportFab). The sidebar used to carry a
 * stacked copy too; it went once the panel became the one place to ask for help.
 *
 * `compact` is one muted line (the feedback form, the chat's "could not alert" notice); the
 * default is stacked and tappable (the panel's "chat not available" view). `whatsapp={false}`
 * leaves mail only — the feedback form's footer, where the chat is one tap away already.
 */
export default function SupportLinks({ compact = false, whatsapp = true }: { compact?: boolean; whatsapp?: boolean }) {
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
      {/* Labels, never the address itself. The sidebar is 210px and the address is 30 characters:
          it clipped mid-word, which reads as a broken address rather than a truncated one. The
          real value goes in `title`, for a merchant who wants to copy it. */}
      <a className={link} href={mailto} title={SUPPORT_EMAIL}>
        <Mail {...icon} />
        {t('Email us', '发邮件给我们')}
      </a>
      {whatsapp && SUPPORT_WA_HREF && (
        <a
          className={link}
          href={SUPPORT_WA_HREF}
          title={SUPPORT_WA_DISPLAY}
          target="_blank"
          rel="noopener noreferrer"
        >
          <MessageCircle {...icon} />
          {t('WhatsApp', 'WhatsApp')}
        </a>
      )}
    </div>
  )
}
