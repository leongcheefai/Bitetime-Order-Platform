/**
 * How a merchant reaches a human, in one place.
 *
 * The feedback dialog (#89) is one-way by design: it writes a `merchant_feedback` row a
 * superadmin reads later, and nothing ever replies to it. The support chat in the same Help
 * panel is the live answer to "my shop is shut and I do not know why"; this address is the
 * fallback for when that chat is down — a real inbox, reached without the platform in the middle.
 * There used to be a WhatsApp number here too. It went when the chat replaced it.
 *
 * Hardcoded rather than read from `import.meta.env`. A support address changes about as often
 * as the product name, both spellings cost a redeploy to change, and only this one can be
 * pinned by a test — an env var that is unset in production degrades to a `mailto:undefined`
 * that looks like a working link right up until someone taps it.
 */
export const SUPPORT_EMAIL = 'enquiry@support.tinyorder.shop'

/**
 * A `mailto:` that already names the shop it is about.
 *
 * The slug is what a superadmin looks a shop up by, and a merchant writing in distress rarely
 * thinks to include it — "my orders stopped" from an unknown sender is a round trip before the
 * work can even start. Both parts are encoded: a shop name is merchant-typed and may hold a
 * `&`, which unencoded ends the subject and silently drops the rest of it.
 */
export function supportMailto(shop?: { name: string; slug: string }): string {
  if (!shop) return `mailto:${SUPPORT_EMAIL}`
  const subject = encodeURIComponent(`Support — ${shop.name} (${shop.slug})`)
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}`
}
