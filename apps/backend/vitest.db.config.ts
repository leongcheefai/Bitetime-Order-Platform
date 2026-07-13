import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vitest/config'

// The suites under tests/rls and tests/api talk to a real local Supabase, so they need
// that stack's URL, keys and Postgres connection string. They used to read them from env
// vars and `describe.skipIf` themselves away when those were absent — which meant the one
// suite proving an order cannot be spoofed onto a stranger's account reported success
// while asserting nothing.
//
// So: resolve the credentials here, from the running stack, and let the suites fail
// loudly if they cannot be found. Explicit env vars still win, so CI can inject its own.
// This config is separate from vitest.config.ts precisely so the unit run never pays for
// (or depends on) a Supabase.
//
// DATABASE_URL is here for the same reason as the keys, and it matters more: the order
// rules are moving out of PL/pgSQL into TypeScript, and the properties they must hold —
// a voucher redeemed once under concurrent checkout, two orders never sharing a number —
// are properties of real Postgres row locks. A mocked database would report green while
// proving nothing, which is worse than no suite at all.
const FROM_CLI: Record<string, string> = {
  SUPABASE_URL: 'API_URL',
  SUPABASE_ANON_KEY: 'ANON_KEY',
  SUPABASE_SERVICE_ROLE_KEY: 'SERVICE_ROLE_KEY',
  DATABASE_URL: 'DB_URL',
}

// tests/api imports the Hono app, which imports env.ts, which fails fast on a missing
// Stripe key. These suites never reach Stripe — nothing they touch calls it, and a real key
// in a test process is a liability rather than an asset. Stub the keys so importing the app
// is possible; anything that genuinely exercises Stripe belongs in a suite that says so.
const STRIPE_STUBS: Record<string, string> = {
  STRIPE_SECRET_KEY: 'sk_test_stub',
  STRIPE_WEBHOOK_SECRET: 'whsec_stub',
  STRIPE_PRICE_BASIC_MONTHLY: 'price_stub',
  STRIPE_PRICE_BASIC_YEARLY: 'price_stub',
  STRIPE_PRICE_PRO_MONTHLY: 'price_stub',
  STRIPE_PRICE_PRO_YEARLY: 'price_stub',
}

function supabaseStatusEnv(): Map<string, string> {
  // `supabase` resolves the project from the config in ./supabase, so this must run
  // with apps/backend as cwd — which it does, being the workspace vitest runs in.
  const raw = execFileSync('supabase', ['status', '-o', 'env'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const vars = new Map<string, string>()
  for (const line of raw.split('\n')) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim())
    if (match) vars.set(match[1], match[2])
  }
  return vars
}

function loadSupabaseEnv() {
  for (const [name, value] of Object.entries(STRIPE_STUBS)) {
    if (!process.env[name]) process.env[name] = value
  }

  const missing = Object.keys(FROM_CLI).filter(name => !process.env[name])
  if (missing.length === 0) return

  let status: Map<string, string>
  try {
    status = supabaseStatusEnv()
  } catch {
    throw new Error(
      `The DB-backed suites need a local Supabase. Could not read one from \`supabase status\`, and ` +
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.\n` +
        `Start the stack with \`supabase start\` (from apps/backend), or set those vars yourself.`,
    )
  }

  for (const name of missing) {
    const value = status.get(FROM_CLI[name])
    if (!value) {
      throw new Error(
        `Local Supabase is running but reported no ${FROM_CLI[name]}, so ${name} cannot be set. ` +
          `Check \`supabase status\`.`,
      )
    }
    process.env[name] = value
  }
}

// Runs in the main process, before workers fork — they inherit the env we set here.
loadSupabaseEnv()

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/rls/**/*.test.ts', 'tests/api/**/*.test.ts'],
    // Files run in parallel (vitest's default). That is safe only because each suite owns a
    // disjoint set of merchant slugs and user emails — its fixtures are keyed on them and it
    // clears them on the way in. A new suite that reuses another's slug will flake here.
  },
})
