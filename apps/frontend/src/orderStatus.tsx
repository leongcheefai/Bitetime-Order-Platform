import { Badge } from '@/components/ui/badge'

export const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled']

export const STATUS_LABELS: Record<string, { en: string; zh: string }> = {
  new:       { en: 'New',       zh: '新订单' },
  preparing: { en: 'Preparing', zh: '备料中' },
  ready:     { en: 'Ready',     zh: '已备好' },
  completed: { en: 'Completed', zh: '已完成' },
  cancelled: { en: 'Cancelled', zh: '已取消' },
}

type BadgeConfig = { variant?: 'infoBlue' | 'danger'; className?: string }
export const STATUS_BADGE: Record<string, BadgeConfig> = {
  new:       { variant: 'infoBlue' },
  preparing: { className: 'bg-warn-bg-alt text-warn-fg-alt border-transparent' },
  ready:     { className: 'bg-success-bg-soft text-success-deep border-transparent' },
  completed: { className: 'bg-prep-bg-alt text-prep-fg-alt border-transparent' },
  cancelled: { className: 'bg-danger-bg text-danger-fg border-transparent' },
}

export function StatusBadge({ status, t }: { status: string; t: (en: string, zh: string) => string }) {
  const badge = STATUS_BADGE[status] ?? { variant: 'infoBlue' as const }
  return (
    <Badge variant={badge.variant} className={badge.className}>
      {t(STATUS_LABELS[status]?.en ?? status, STATUS_LABELS[status]?.zh ?? status)}
    </Badge>
  )
}
