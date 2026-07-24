// The grammar of the dashboard's URL hash: `#<section>` or `#<section>/<sub-tab>`.
//
// Split out from useDashboardSection when Settings' sub-tabs moved into the URL (#112) so the
// Pro upgrade CTA could link straight to `#settings/subscription`. Keeping it pure keeps it
// testable — the hooks own `window`, this owns the shape — and it is the reason every settings
// sub-tab now survives a refresh instead of silently resetting to Shipping.
//
// Neither function validates: callers check the parts against their own known keys and fall
// back, because a hash is whatever a stale link or a typing user handed us.

export function parseDashboardHash(hash: string): { section: string; sub: string | null } {
  const [section = '', sub = ''] = hash.replace(/^#/, '').split('/')
  return { section, sub: sub || null }
}

export function dashboardHash(section: string, sub?: string | null): string {
  return sub ? `#${section}/${sub}` : `#${section}`
}
