// Pro-tier entitlement, browser side (#110). The gate itself is the BACKEND — `requirePro`
// refuses the write and answers `requires_pro`. Everything here is UX: it decides whether a
// feature renders live or renders locked behind an upgrade prompt, so the merchant meets a
// padlock and a price rather than a failed save. Gating the next Pro feature should be one
// `useProAccess()` call, not a re-derivation of what "Pro" means.
//
// See CONTEXT.md → Plan entitlement.
import { useSession } from './SessionContext'

/** The error code every gated endpoint answers with. One string, one upgrade prompt. */
export const REQUIRES_PRO = 'requires_pro'

/**
 * Whether the shop currently in context may use Pro features.
 *
 * `plan === 'pro'` and nothing else — a NULL plan (every shop that predates billing) is not
 * Pro. A superadmin passes on any shop, mirroring both `RequireRole` here and `requirePro` on
 * the backend: support and impersonation must not be obstructed by the tier the shop pays for.
 */
export function useProAccess(): boolean {
  const { merchant, role } = useSession()
  return merchant?.plan === 'pro' || role === 'superadmin'
}

/**
 * Did this failure come from the plan gate? The locked UI means a merchant should never reach
 * a gated write in the first place — this is the fallback for the paths that can still get
 * there (a stale `plan` in a long-open tab, a shop comped or downgraded mid-session), so the
 * answer is an upgrade prompt instead of a bare error string.
 */
export function isRequiresPro(err: unknown): boolean {
  return err instanceof Error && err.message === REQUIRES_PRO
}
