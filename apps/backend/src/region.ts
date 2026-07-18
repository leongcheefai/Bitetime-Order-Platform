// Geo detection for the pricing page. We charge MYR everywhere, so there are no
// billing "regions" any more — this only resolves the visitor's country so the
// display layer can pick an approximate local-currency estimate (see fx.ts).

// CDN-provided country headers, in precedence order (first present wins).
const COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'x-country-code']

/**
 * Resolve the visitor's ISO 3166-1 alpha-2 country. Precedence: an explicit
 * country (the `?country=` override) beats CDN headers, which beat nothing.
 * Returns '' when undetected. Pure — the caller supplies a header accessor.
 */
export function detectCountry({
  explicitCountry,
  getHeader,
}: {
  explicitCountry?: string
  getHeader: (name: string) => string | undefined
}): string {
  const explicit = (explicitCountry ?? '').trim()
  if (explicit) return explicit.toUpperCase()
  for (const name of COUNTRY_HEADERS) {
    const value = getHeader(name)
    if (value) return value.trim().toUpperCase()
  }
  return ''
}
