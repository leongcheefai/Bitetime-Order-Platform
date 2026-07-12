// Resolve the caller's address for rate-limiting.
//
// The subtlety that matters: `X-Forwarded-For` is a list a caller can start. Anything a
// non-browser client sends arrives as the LEFTMOST entries, and the proxy in front of us
// appends the address it actually saw on the right. Reading the leftmost entry — the usual
// mistake — would hand an attacker a fresh IP per request and the window would never fire,
// leaving the per-email limit as the only control (defeated by rotating emails).
//
// So: the CDN's own header first (a caller cannot forge it through the CDN), then the
// rightmost XFF entry, then the socket address for local dev. When nothing is known the key
// is a single shared bucket — blunt on purpose, because a private window for anyone who
// withholds headers is no window at all.
//
// This assumes the last hop in XFF is OUR proxy. If a second proxy is ever put in front,
// the rightmost entry becomes that proxy's address and every customer behind it shares one
// bucket — set the CDN header, or count hops, before that happens.
export function clientIp(headers: Record<string, string | undefined>, socketAddress?: string): string {
  const cdn = headers['cf-connecting-ip']?.trim()
  if (cdn) return cdn

  const forwarded = (headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const nearest = forwarded[forwarded.length - 1]
  if (nearest) return nearest

  return socketAddress?.trim() || 'unknown'
}
