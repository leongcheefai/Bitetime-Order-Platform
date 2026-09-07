import { Copy } from 'lucide-react'
import { fulfilmentConfig, selectableDates, DEFAULT_TIMEZONE } from '@bitetime/shared'
import { useSession } from '../../SessionContext'
import { formatAddress } from '../../address'
import { formatCalendarDate } from '../../orderDate'
import { fulfilmentLabel } from '../../fulfilmentLabel'
import WaLink from '../WaLink'
import { Button } from '@/components/ui/button'
import DateField from '../DateField'
import DrawerCard, { Field, FIELD_GRID, LBL, CardSaveButton } from './DrawerCard'
import { copyText } from './copyText'

/**
 * Who the order is for and where it goes.
 *
 * These were two groups, `Customer` and `Fulfilment`, and the second drew its rows through a
 * fixed 84px label column — which left a delivery address about 300px to wrap in, so a real
 * Malaysian address took three lines. `Field` puts the label ABOVE its value, and the address
 * spans both columns, so it gets the full width of the card.
 */
export default function CustomerCard({
  order,
  fulfilDate,
  onFulfilDate,
  onSaveDate,
  savingDate,
  dateDirty,
  readOnly,
}: {
  order: any
  /** The date draft, `YYYY-MM-DD`. */
  fulfilDate: string
  onFulfilDate: (iso: string) => void
  onSaveDate: () => void
  savingDate: boolean
  dateDirty: boolean
  readOnly: boolean
}) {
  const { t, lang, merchant } = useSession()
  const address = order.address ? formatAddress(order.address) : null
  // The date is the merchant's to move on any order that is not DONE: a completed order's day is
  // as final as its status (ADR 0024), and the backend refuses it either way — this only decides
  // whether to draw the picker. The picker offers exactly the days the shop's own Fulfilment
  // settings offer a customer — `selectableDates`, the list the storefront picker is built from —
  // so a Monday the shop closes is not clickable here either, and no day it offers is one the
  // save refuses. Computed once per render, not per day: the calendar asks about every cell.
  const tz = merchant?.timezone ?? DEFAULT_TIMEZONE
  const dateEditable = !readOnly && (order.status || 'new') !== 'completed'
  const open = dateEditable ? new Set(selectableDates(fulfilmentConfig(merchant?.config), tz, new Date())) : null


  return (
    <DrawerCard
      title={t('Customer & delivery', '顾客与配送')}
      footer={dateEditable ? (
        <CardSaveButton
          label={t('Save date', '保存日期')}
          savingLabel={t('Saving…', '保存中…')}
          saving={savingDate}
          dirty={dateDirty}
          onSave={onSaveDate}
        />
      ) : undefined}
    >
      <div className={FIELD_GRID}>
        <Field label={t('Customer', '顾客')}>
          {order.customer_name || '—'}
        </Field>

        {order.customer_wa && (
          <Field label={t('WhatsApp', 'WhatsApp')}>
            <WaLink wa={order.customer_wa} />
          </Field>
        )}

        <Field label={t('Fulfilment', '配送')}>
          {/* The date the CUSTOMER asked for, shown as `—` rather than omitted for a legacy
              order: a missing row would read as "this order has no fulfilment info" rather
              than "placed before #91". */}
          {fulfilmentLabel(order.mode, t)}
          {!dateEditable && (
            <>
              {' · '}
              {order.fulfil_date ? formatCalendarDate(order.fulfil_date, lang) : '—'}
            </>
          )}
        </Field>

        {dateEditable && (
          <div className="flex flex-col gap-1 min-w-0">
            <label className={LBL} htmlFor={`fulfil-date-${order.id}`}>{t('Date', '日期')}</label>
            <DateField
              id={`fulfil-date-${order.id}`}
              value={fulfilDate}
              onChange={onFulfilDate}
              tz={tz}
              isDisabled={iso => !open!.has(iso)}
              t={t}
              lang={lang}
              placeholder={t('Pick a date', '选择日期')}
            />
          </div>
        )}

        {order.region && (
          <Field label={t('Region', '地区')}>{order.region}</Field>
        )}

        {address && (
          <div className="sm:col-span-2">
            <Field
              label={t('Address', '地址')}
              action={
                <Button
                  variant="ghost"
                  size="iconRound"
                  className="size-6"
                  aria-label={t('Copy address', '复制地址')}
                  onClick={() => copyText(address, { en: 'Address copied', zh: '地址已复制' }, t)}
                >
                  <Copy className="size-3" />
                </Button>
              }
            >
              {address}
            </Field>
          </div>
        )}
      </div>
    </DrawerCard>
  )
}
