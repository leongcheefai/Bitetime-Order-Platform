// Canonical Malaysian states / federal territories. The East-Malaysia three
// (Sabah, Sarawak, W.P. Labuan) MUST match EM_STATES in `packages/shared/src/pricing.ts`
// verbatim (the module both the browser and the backend price with) so
// regional shipping resolves. Used by the storefront State <select> and by the
// postcode-dataset generator to validate/normalise upstream state names.
export const MY_STATES = [
  'Johor',
  'Kedah',
  'Kelantan',
  'Melaka',
  'Negeri Sembilan',
  'Pahang',
  'Perak',
  'Perlis',
  'Pulau Pinang',
  'Sabah',
  'Sarawak',
  'Selangor',
  'Terengganu',
  'W.P. Kuala Lumpur',
  'W.P. Labuan',
  'W.P. Putrajaya',
] as const
