// Builds the merchant signup URL carrying a referral code. Pure + DOM-free so it
// is unit-testable; callers pass window.location.origin at the call site.
// The `ref` param is a future crediting hook — signup does not yet read it.
export function referralSignupUrl(code: string, origin: string): string {
  const base = origin.replace(/\/$/, '')
  return `${base}/merchant/signup?ref=${encodeURIComponent(code)}`
}
