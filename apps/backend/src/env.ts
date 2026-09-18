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

  // GitHub (auto-files merchant feedback as issues on leongcheefai/Bitetime-Order-Platform,
  // see github.ts). Optional, same posture as googleMapsApiKey: unset means issue creation
  // is skipped and logged, never a startup error — the feedback table is the source of
  // truth regardless of whether GitHub has heard about a row.
  githubToken: process.env.GITHUB_TOKEN || '',

  // Anthropic (Claude API — rewrites raw GitHub release bodies into merchant-facing copy for
  // the "what's new" bell, see releases.ts). Optional, same posture as githubToken: unset
  // means humanizeRelease logs and returns null, and the pulled release is stored with
  // humanize_error set rather than a title/summary — the pull itself never fails.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

  // Shared secret for the trial-feedback cron sweep (POST /api/internal/trial-feedback-sweep,
  // called by a GitHub Actions schedule — see .github/workflows/trial-feedback-sweep.yml).
  // Optional, same posture as googleMapsApiKey: unset means the endpoint always refuses (503)
  // rather than running unauthenticated.
  trialFeedbackSweepSecret: process.env.TRIAL_FEEDBACK_SWEEP_SECRET || '',

  // Shared secret for the billing reconciliation sweep (POST /api/internal/billing-sweep, called
  // by a GitHub Actions schedule — see .github/workflows/billing-sweep.yml). Same posture as
  // trialFeedbackSweepSecret: unset means the endpoint always refuses (503).
  //
  // Worth stating what an unset secret costs here, because it is not the same as the other two:
  // this sweep is the ONLY thing that closes a shop when Stripe's `customer.subscription.deleted`
  // never reaches us. Disabled, the app is back to trusting a single webhook delivery — which is
  // exactly the state that let expired trials keep selling in production.
  billingSweepSecret: process.env.BILLING_SWEEP_SECRET || '',

  // Shared secret for the sample-shop screenshot cron sweep
  // (POST /api/internal/sample-shop-screenshot/:merchantId, called by a GitHub Actions
  // schedule — see .github/workflows/sample-shop-screenshot-sweep.yml). Same posture as
  // trialFeedbackSweepSecret: unset means the endpoint always refuses (503).
  sampleShopScreenshotSweepSecret: process.env.SAMPLE_SHOP_SCREENSHOT_SWEEP_SECRET || '',

  // Shared secret for the release pull called by .github/workflows/release.yml the moment it
  // cuts a tag (POST /api/internal/releases-pull). Same posture as trialFeedbackSweepSecret:
  // unset means the endpoint always refuses (503), and the only cost of that is that a
  // superadmin pulls the release by hand from /admin, exactly as before this was automated.
  releasePullSecret: process.env.RELEASE_PULL_SECRET || '',

  // The PLATFORM's own Telegram chat — where the superadmin hears that a shop signed up
  // (platformNotify.ts). A PAIR: the bot token and the chat id, and either one missing turns the
  // alert off. Not to be confused with the per-merchant token in `merchant_secrets`, which is a
  // different bot in a different chat telling a different person about orders.
  //
  // OPTIONAL, same posture as googleMapsApiKey: unset means the send is skipped and logged. It
  // can be nothing else — the alert is a notice about a signup that has already committed, so a
  // missing variable must never fail the signup and must never stop the backend from booting.
  platformTgToken: process.env.PLATFORM_TG_TOKEN || '',
  platformTgChatId: process.env.PLATFORM_TG_CHAT_ID || '',

  // Signs the merchant email-verification link (emailVerifyToken.ts).
  //
  // OPTIONAL, same posture as GOOGLE_MAPS_API_KEY and ANTHROPIC_API_KEY: unset, the feature is
  // simply off — no mail is sent and the dashboard shows no banner. That is deliberate and not
  // laziness. Signup must not depend on it: the whole point of the merchant door is that nothing
  // stands between the form and the dashboard, and a `required()` here would turn a missing
  // variable into a backend that refuses to boot.
  emailVerifySecret: process.env.EMAIL_VERIFY_SECRET || '',

  // Stripe Price IDs (MYR), keyed by billing cycle. One plan, charged in MYR to every
  // subscriber, so there is one pair and both are required. Point these at your MYR Prices.
  prices: {
    monthly: required('STRIPE_PRICE_PRO_MONTHLY'),
    yearly: required('STRIPE_PRICE_PRO_YEARLY'),
  },
}
