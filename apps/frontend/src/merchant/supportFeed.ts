// The support chat's two pure rules: how often to poll, and how a poll joins what is on screen.
import type { SupportMessage } from '@bitetime/shared'

export const POLL_OPEN_MS = 5_000
export const POLL_CLOSED_MS = 60_000

/** Null means "do not poll": a hidden tab asks nobody anything. */
export function pollDelay(s: { open: boolean; hidden: boolean }): number | null {
  if (s.hidden) return null
  return s.open ? POLL_OPEN_MS : POLL_CLOSED_MS
}

/**
 * Join by id, order by time then id — the same order the backend's cursor uses. A message can
 * arrive twice (in a send response, then in the next poll), and a reply can be OLDER than a
 * message already on screen, so this cannot simply append.
 *
 * The id tie-break compares UUID strings; Postgres compares `uuid` byte by byte. For lower-case
 * hex the two orders agree.
 */
export function mergeMessages(current: SupportMessage[], incoming: SupportMessage[]): SupportMessage[] {
  const known = new Set(current.map(m => m.id))
  const fresh = incoming.filter(m => !known.has(m.id))
  if (fresh.length === 0) return current
  return [...current, ...fresh].sort((x, y) =>
    x.created_at === y.created_at ? (x.id < y.id ? -1 : 1) : (x.created_at < y.created_at ? -1 : 1))
}

/**
 * Where the "Marked as resolved" line goes: after the last message written up to the moment the
 * superadmin closed the topic. Null hides it. A reply posted after the close (an admin can still
 * write into a closed topic) stays below the line, so the line never claims to cover it.
 */
export function resolvedLineAfter(messages: SupportMessage[], resolvedAt: string | null): number | null {
  if (!resolvedAt) return null
  const count = messages.filter(m => m.created_at <= resolvedAt).length
  return count > 0 ? count : null
}
