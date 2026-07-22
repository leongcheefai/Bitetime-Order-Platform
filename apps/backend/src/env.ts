// Centralized env access. Fail fast on missing required vars at startup.
function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

export const env = {
  port: Number(process.env.PORT || 8787),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  stripeSecretKey: required('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: required('STRIPE_WEBHOOK_SECRET'),

  supabaseUrl: required('SUPABASE_URL'),
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),

  // Direct Postgres connection, separate from the Supabase REST clients above.
  // supabase-js cannot open a transaction, which is the only reason the order rules were
  // ever PL/pgSQL: the counter needs an atomic upsert and the voucher a row lock. This is
  // what lets those rules be TypeScript instead. See src/db.ts.
  databaseUrl: required('DATABASE_URL'),

  // Email (Resend). Optional: when the key is unset, sends are skipped with a
  // warning so local dev works without an email account.
  resendApiKey: process.env.RESEND_API_KEY || '',
  emailFrom: process.env.EMAIL_FROM || 'TinyOrder <onboarding@resend.dev>',

  // Google Maps Platform — Routes (distance) and Places (address autocomplete), on the
  // PLATFORM's account, never a merchant's: zero setup for a merchant is the whole point of the
  // dependency (see docs/adr/0001). Deliberately OPTIONAL, not `required()`: every existing
  // deployment, every dev machine and the DB test suites run without it, and a region-priced
  // shop never touches it. Unset simply means distance lookups fail — which is a refusal, and
  // failing closed is the house rule.
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',

  // Stripe Price IDs (MYR), keyed by `${plan}_${cycle}`. We charge MYR for every
  // subscription, so there is one set and all four are required. Point these at
  // your MYR Prices.
  prices: {
    basic_monthly: required('STRIPE_PRICE_BASIC_MONTHLY'),
    basic_yearly: required('STRIPE_PRICE_BASIC_YEARLY'),
    pro_monthly: required('STRIPE_PRICE_PRO_MONTHLY'),
    pro_yearly: required('STRIPE_PRICE_PRO_YEARLY'),
  },
}
