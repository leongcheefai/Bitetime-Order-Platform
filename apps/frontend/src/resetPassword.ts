/** The shape `slugify` produces, and the only shape this route will navigate to. */
const SLUG = /^[a-z0-9-]+$/

/**
 * Where a reset link comes back to, and where the customer goes once they've reset.
 *
 * The landing route is TOP-LEVEL (`/reset-password`), never nested under `/s/:slug`. Nested, the
 * storefront shell's merchant-status gate would swallow the page — and a shop being suspended must
 * never lock a customer out of their own account. It also means Supabase's redirect allow-list
 * needs exactly one static entry instead of a wildcard.
 */
export const RESET_PATH = '/reset-password'

export function resetRedirectUrl(origin: string, slug: string | null | undefined): string {
  const base = `${origin}${RESET_PATH}`
  return slug ? `${base}?shop=${encodeURIComponent(slug)}` : base
}

/**
 * Role-blind: with a shop, the customer lands back where they were ordering; without one, the
 * merchant dashboard. Merchants have no reset path today either, so their entry point later is a
 * link and nothing more.
 *
 * The `shop` value arrives from the query string of a link that has been through an inbox, and it
 * is used to navigate — so an unchecked value here is an open redirect. Anything that isn't a
 * plain slug goes to the dashboard.
 */
export function resetDestination(slug: string | null | undefined): string {
  if (!slug || !SLUG.test(slug)) return '/merchant'
  return `/s/${slug}`
}
