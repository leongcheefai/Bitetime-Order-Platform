// Pure dirty-detection for the tabbed Shop Settings forms.
// Each settings tab owns a flat map of its field values (all strings, as held by
// the inputs). A tab is "dirty" when any current field differs from the snapshot
// taken at last save/load. Kept UI-free and pure so it is unit-testable — sibling
// pattern to pricing.ts. See docs issue #19.

export type SettingsFields = Record<string, string>

/** True if any field's current value differs from the saved snapshot. Missing keys count as ''. */
export function isDirty(saved: SettingsFields, current: SettingsFields): boolean {
  const keys = new Set([...Object.keys(saved), ...Object.keys(current)])
  for (const k of keys) {
    if ((saved[k] ?? '') !== (current[k] ?? '')) return true
  }
  return false
}
