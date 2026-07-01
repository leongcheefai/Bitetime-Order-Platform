// Billing regions. Each region prices platform subscriptions in its own currency
// with its own real Stripe Prices — there is no FX conversion. `US` is the default
// (rest-of-world); `MY` is the only non-default region at launch. Adding a region
// is additive: extend COUNTRY_TO_REGION, REGION_CURRENCY, and the env price map.

export const REGIONS = ['US', 'MY'] as const
export type Region = (typeof REGIONS)[number]
export const DEFAULT_REGION: Region = 'US'

// Region → ISO 4217 currency code, consumed by the frontend money formatter.
export const REGION_CURRENCY: Record<Region, string> = {
  US: 'USD',
  MY: 'MYR',
}

// Country (ISO 3166-1 alpha-2) → region. Everything unlisted falls back to the
// default, so only the non-default markets need an entry.
const COUNTRY_TO_REGION: Record<string, Region> = {
  MY: 'MY',
}

// CDN-provided country headers, in precedence order (first present wins).
const COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'x-country-code']

export function isValidRegion(value: unknown): value is Region {
  return typeof value === 'string' && (REGIONS as readonly string[]).includes(value)
}

function regionForCountry(country: string | undefined): Region {
  const code = (country ?? '').trim().toUpperCase()
  return COUNTRY_TO_REGION[code] ?? DEFAULT_REGION
}

/**
 * Resolve the billing region for a request. Precedence: an explicit country
 * (e.g. the `?country=` override) beats CDN country headers, which beat the
 * default. Pure — the caller supplies a header accessor.
 */
export function detectRegion({
  explicitCountry,
  getHeader,
}: {
  explicitCountry?: string
  getHeader: (name: string) => string | undefined
}): Region {
  const explicit = (explicitCountry ?? '').trim()
  if (explicit) return regionForCountry(explicit)
  for (const name of COUNTRY_HEADERS) {
    const value = getHeader(name)
    if (value) return regionForCountry(value)
  }
  return DEFAULT_REGION
}
