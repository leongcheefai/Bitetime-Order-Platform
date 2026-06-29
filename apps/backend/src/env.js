// Centralized env access. Fail fast on missing required vars at startup.
function required(name) {
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

  // Stripe Price IDs, keyed by `${plan}_${cycle}`.
  prices: {
    basic_monthly: required('STRIPE_PRICE_BASIC_MONTHLY'),
    basic_yearly: required('STRIPE_PRICE_BASIC_YEARLY'),
    pro_monthly: required('STRIPE_PRICE_PRO_MONTHLY'),
    pro_yearly: required('STRIPE_PRICE_PRO_YEARLY'),
  },
}
