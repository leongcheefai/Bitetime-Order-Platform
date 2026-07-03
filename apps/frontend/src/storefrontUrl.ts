// Builds the public storefront URL for a merchant slug. Pure + DOM-free so it
// is unit-testable; callers pass window.location.origin at the call site.
export function storefrontUrl(slug: string, origin: string): string {
  const base = origin.replace(/\/$/, '')
  return `${base}/s/${slug}`
}
