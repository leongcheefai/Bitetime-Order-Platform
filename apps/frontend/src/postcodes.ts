// Postcode → { city, state } lookup over the bundled MY dataset. The JSON is
// loaded lazily (dynamic import) so pickup-only sessions never pay for it, and
// memoised after the first call.
let cache: Record<string, string> | null = null

async function load(): Promise<Record<string, string>> {
  if (!cache) {
    const mod = await import('./postcodes-my.json')
    cache = (mod.default ?? mod) as Record<string, string>
  }
  return cache
}

export async function lookupPostcode(
  code: string,
): Promise<{ city: string; state: string } | null> {
  if (!/^\d{5}$/.test(code)) return null
  const map = await load()
  const value = map[code]
  if (!value) return null
  const [city, state] = value.split('|')
  return { city, state }
}
