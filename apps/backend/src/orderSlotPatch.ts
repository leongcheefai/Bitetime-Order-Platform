import { isSlotSelectable, type FulfilmentConfig } from '@bitetime/shared'
import type { OrderPatch, OrderPatchBefore } from './orderEvents.js'

/**
 * Whether a merchant's patch leaves the order with a slot the shop can serve (#282).
 *
 * The CUSTOMER's rule, on purpose, as the date is: the shop's hours are what the merchant told
 * the platform they serve, and the drawer must not be a door around the Fulfilment tab. Judged
 * against the date the row WILL hold — a moved date carries its slot along, and the slot must be
 * open on the new day too.
 *
 * Pure, and separate from `patchOrder`, so every branch runs under `pnpm test` with no database.
 * Returns the refusal code or null; `patchOrder` turns the code into `{ refused }`.
 */
export function judgeSlotPatch(
  before: Pick<OrderPatchBefore, 'fulfil_date' | 'fulfil_time_from' | 'fulfil_time_to'>,
  patch: OrderPatch,
  cfg: FulfilmentConfig,
  tz: string,
  now: Date,
): 'fulfil_time_unavailable' | null {
  const slotPatched = patch.fulfil_time_from !== undefined
  const datePatched = patch.fulfil_date !== undefined
  if (!slotPatched && !datePatched) return null

  const from = slotPatched ? (patch.fulfil_time_from ?? null) : before.fulfil_time_from
  const to = slotPatched ? (patch.fulfil_time_to ?? null) : before.fulfil_time_to
  const unchanged = from === before.fulfil_time_from && to === before.fulfil_time_to

  if (!cfg.slots_enabled) {
    // Hours are dormant: nothing new can be judged open. Clearing and a no-op retry pass.
    return slotPatched && !unchanged && from !== null ? 'fulfil_time_unavailable' : null
  }

  if (from === null || to === null) {
    // A slot shop's order keeps its slot: it can move but never clear. A LEGACY order that never
    // had one is not given one by a date move — that is the merchant's choice to make explicitly.
    return slotPatched ? 'fulfil_time_unavailable' : null
  }

  const date = patch.fulfil_date ?? before.fulfil_date
  if (date === null) return 'fulfil_time_unavailable'
  return isSlotSelectable(date, { from, to }, cfg, tz, now) ? null : 'fulfil_time_unavailable'
}
