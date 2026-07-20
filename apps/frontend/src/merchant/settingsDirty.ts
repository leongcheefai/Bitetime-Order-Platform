// Pure dirty-detection for the tabbed Shop Settings forms.
// Each settings tab owns a flat map of its field values, held by ONE shared type across
// every tab — a tab only ever sets the subset of keys its own fields use, so every key is
// optional. Almost all fields are strings, as held by text/number inputs; `taxEnabled` is
// the one boolean, for the Tax card's checkbox. The index signature keeps `isDirty` below
// generic over whichever keys a tab actually populates. A tab is "dirty" when any current
// field differs from the snapshot taken at last save/load. Kept UI-free and pure so it is
// unit-testable — sibling pattern to pricing.ts. See docs issue #19.

export type SettingsFields = {
  [key: string]: string | boolean | undefined
  currency?: string
  wm?: string
  em?: string
  pickupAddress?: string
  taxEnabled?: boolean
  taxRate?: string
  bank?: string
  note?: string
  tgToken?: string
  tgChat?: string
}

/** True if any field's current value differs from the saved snapshot. Missing keys count as ''. */
export function isDirty(saved: SettingsFields, current: SettingsFields): boolean {
  const keys = new Set([...Object.keys(saved), ...Object.keys(current)])
  for (const k of keys) {
    if ((saved[k] ?? '') !== (current[k] ?? '')) return true
  }
  return false
}
