import { useSession } from '../../SessionContext'
import { formatMoney } from '../../currency'
import { ItemSelections } from '../../ItemSelections'
import DrawerCard from './DrawerCard'

/** What was ordered. The money it adds up to is `PaymentCard`'s. */
export default function ItemsCard({ items, currency }: { items: any[]; currency?: string }) {
  const { t } = useSession()
  const count = items.length

  return (
    <DrawerCard
      title={t('Items', '商品')}
      aside={
        <span className="text-[12px] text-muted-foreground">
          {t(`${count} item${count === 1 ? '' : 's'}`, `${count} 件商品`)}
        </span>
      }
    >
      <ul className="flex flex-col">
        {items.map((it: any, i: number) => (
          // Index key, deliberately not id: a split promo puts two lines with the SAME
          // product id in `items` (base half + promo half), and keying by id would collapse
          // them into one row on screen while charging for both.
          <li
            key={i}
            className="flex justify-between gap-3 py-1.5 text-[13px] text-foreground border-t border-dashed border-border first:border-t-0 first:pt-0"
          >
            <span className="min-w-0 break-words">
              <span className="text-muted-foreground tabular-nums">{it.qty}×</span> {it.name}
              <ItemSelections item={it} />
              {/* `it.promo` missing (rows written before I-2) reads as false, not a crash. */}
              {it.promo && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-pill bg-primary text-primary-foreground text-[10px] leading-[14px] font-medium align-middle">
                  {t('Promo', '优惠')}
                </span>
              )}
            </span>
            <span className="tabular-nums text-muted-foreground whitespace-nowrap">
              {formatMoney((it.price ?? 0) * (it.qty ?? 0), currency)}
            </span>
          </li>
        ))}
      </ul>
    </DrawerCard>
  )
}
