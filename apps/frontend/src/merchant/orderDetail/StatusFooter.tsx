import { useSession } from '../../SessionContext'
import { ORDER_STATUSES, STATUS_LABELS, isStatusFinal } from '../../orderStatus'
import { nextStatus } from './nextStatus'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/**
 * The status control, pinned to the bottom of the drawer.
 *
 * Changing the status is the thing a merchant opens this drawer to do most often, and it used
 * to be the LAST control on the page — reachable only by scrolling past the items, the address,
 * the courier fields and the note. It does not scroll any more, and the usual next step is a
 * button rather than a list to open and read.
 *
 * One `Select` serves both shapes. There is no `useMediaQuery` in this codebase and no reason
 * to add one: the only difference is how the trigger is dressed, which is a class.
 *
 * A COMPLETED order renders NOTHING — see `isStatusFinal`. Not a disabled `Select`, which still
 * invites the merchant to open it and read six moves none of which are available; and not the
 * badge on its own either, because `OrderHeader` is already showing that badge four inches above.
 * A suspended shop's drawer has had no footer for the same reason: where there is no move to
 * make, the bar is a strip of chrome saying what the header said.
 */
export default function StatusFooter({
  status,
  onChange,
}: {
  status: string
  onChange: (status: string) => void
}) {
  const { t } = useSession()

  if (isStatusFinal(status)) return null

  const next = nextStatus(status)
  const statusItems = ORDER_STATUSES.map(s => ({
    value: s,
    label: t(STATUS_LABELS[s].en, STATUS_LABELS[s].zh),
  }))

  return (
    <div className="shrink-0 border-t border-border bg-card px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
      <Select
        value={status}
        // `if (v)` rather than `??` — this handler writes to the database, so a null must be
        // dropped, never coerced into a status.
        onValueChange={v => { if (v) onChange(v) }}
        items={statusItems}
      >
        <SelectTrigger
          aria-label={t('Order status', '订单状态')}
          className={cn(
            'w-full bg-background text-[13px] sm:w-[190px]',
            // With an advance button present, the phone shows the list as a quiet text
            // button under it — the primary move gets the thumb-sized target. On a desktop,
            // and whenever there is no advance button, it is an ordinary select box.
            next && 'order-2 justify-center border-0 shadow-none text-muted-foreground underline underline-offset-2 [&_svg]:hidden sm:order-1 sm:justify-between sm:border sm:border-input sm:shadow-xs sm:no-underline sm:text-foreground sm:[&_svg]:block',
          )}
        >
          {next ? (
            <>
              <span className="sm:hidden">{t('Set another status', '设置其他状态')}</span>
              {/* Wrapped, and that is load-bearing. The base `SelectTrigger` carries
                  `*:data-[slot=select-value]:flex` — a child selector, which outranks a plain
                  `hidden` sitting on the value itself, so the value rendered on a phone
                  BESIDE the "Set another status" label. `*:` matches direct children only, so
                  one span between the two puts the value out of that rule's reach and lets
                  this `hidden` decide. */}
              <span className="hidden sm:flex sm:min-w-0 sm:flex-1 sm:items-center">
                <SelectValue />
              </span>
            </>
          ) : (
            <SelectValue />
          )}
        </SelectTrigger>
        <SelectContent>
          {statusItems.map(i => (
            <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {next && (
        <Button
          type="button"
          size="none"
          onClick={() => onChange(next.to)}
          className="order-1 w-full rounded-lg px-[14px] py-[10px] text-[14px] sm:order-2 sm:ml-auto sm:w-auto"
        >
          {t(next.en, next.zh)}
        </Button>
      )}
    </div>
  )
}
