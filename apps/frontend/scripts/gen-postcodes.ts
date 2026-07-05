// One-off generator. NOT run at build time — run it manually to (re)produce
// src/postcodes-my.json, which is committed.
//
// Source: the `malaysia-postcodes` npm package (v3). Its real export shape is
// nested, NOT a flat `{state, city, postcode}[]`:
//   allPostcodes: { name: string; city: { name: string; postcode: string[] }[] }[]
// i.e. an array of states, each with an array of cities, each with its own
// postcode list. Upstream state names are also non-canonical, e.g.
// "Wp Kuala Lumpur" / "Wp Labuan" / "Wp Putrajaya" (checked via
// `pkg.getStates()`), so we normalise those to our canonical MY_STATES.
//
// Run from the repo root:
//   pnpm dlx tsx apps/frontend/scripts/gen-postcodes.ts
//
// The script throws on any upstream state name it can't map to MY_STATES, so a
// dataset change can never silently drop East-Malaysia pricing.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { allPostcodes } from 'malaysia-postcodes'
import { MY_STATES } from '../src/states-my'

interface UpstreamCity { name: string; postcode: string[] }
interface UpstreamState { name: string; city: UpstreamCity[] }

// Upstream uses "Wp Kuala Lumpur" etc.; map those to our canonical strings.
// Names already canonical fall through unchanged.
const NORMALIZE: Record<string, string> = {
  'Wp Kuala Lumpur': 'W.P. Kuala Lumpur',
  'Wp Labuan': 'W.P. Labuan',
  'Wp Putrajaya': 'W.P. Putrajaya',
}

const states = allPostcodes as unknown as UpstreamState[]
if (!Array.isArray(states)) {
  throw new Error('malaysia-postcodes: could not find `allPostcodes` array export')
}

const canonicalStates = new Set<string>(MY_STATES as readonly string[])
const out: Record<string, string> = {}

for (const state of states) {
  const normalized = NORMALIZE[state.name] ?? state.name
  if (!canonicalStates.has(normalized)) {
    throw new Error(`Unmapped state "${state.name}" — add it to NORMALIZE or MY_STATES`)
  }
  for (const city of state.city) {
    for (const raw of city.postcode) {
      const pc = String(raw).padStart(5, '0')
      if (!/^\d{5}$/.test(pc)) continue
      // First city wins for a shared postcode (matches lookupPostcode contract).
      if (!(pc in out)) out[pc] = `${city.name}|${normalized}`
    }
  }
}

const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'postcodes-my.json')
writeFileSync(dest, JSON.stringify(out))
console.log(`Wrote ${Object.keys(out).length} postcodes to ${dest}`)
