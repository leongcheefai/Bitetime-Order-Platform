// Pure referral-code helpers — format validation + self-referral guard. DOM/DB-free and
// unit-testable. A referral code is the first 8 hex chars of a user id, uppercased
// (see referralCodeOf in store.ts). The self-referral guard takes the owner's code as a
// parameter rather than importing referralCodeOf, to avoid a store.ts ↔ referralCode.ts
// import cycle.

export function normalizeReferralCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim().toUpperCase()
  return /^[0-9A-F]{8}$/.test(code) ? code : null
}

// The code to store on a new merchant: normalized, but never the owner's own code.
export function resolveReferredByCode(
  raw: string | null | undefined,
  ownerCode: string,
): string | null {
  const code = normalizeReferralCode(raw)
  if (!code) return null
  return code === ownerCode ? null : code
}
