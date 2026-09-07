// Error copy is `text-danger-fg`, never the fill red — and the fill red has TWO names.
//
// tokens.test.ts pins `--danger-500` (#EF4444) below the AA text floor, but a pin on a token
// cannot see an alias: `--destructive` in index.css resolves to the same value, and after the
// first sweep of `text-danger` an audit found nine error messages reaching 3.76:1 through
// `text-destructive` instead. This test reads the sources, so a third name would fail it too.
//
// Both classes are legitimate on a FILL, a BORDER, a RING or an ICON. What is forbidden is the
// bare class on running text, which is what `text-` names. The allowlist below is every site
// where `text-danger` colours a glyph, not words; a hover state on an icon button is the same.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname)

/** `text-danger` on something that is not text — an icon, or a hover colour on an icon button. */
const ALLOWED_TEXT_DANGER = new Set([
  'store/OrderTimeline.tsx',      // the cancelled-order Ban glyph
  'merchant/OptionGroupsEditor.tsx', // hover:text-danger on two delete icon buttons
])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, out) }
    else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) out.push(p)
  }
  return out
}

const files = walk(SRC).map(p => [relative(SRC, p), readFileSync(p, 'utf8')] as const)

describe('error copy never uses the fill red', () => {
  it('no source uses `text-destructive`', () => {
    const hits = files
      .filter(([rel]) => !rel.startsWith('components/ui/'))
      .filter(([, src]) => /\btext-destructive\b/.test(src))
      .map(([rel]) => rel)
    expect(hits).toEqual([])
  })

  it('`text-danger` (not -fg) appears only where it colours an icon', () => {
    const hits = files
      .filter(([, src]) => /\btext-danger(?!-)/.test(src))
      .map(([rel]) => rel)
      .filter(rel => !ALLOWED_TEXT_DANGER.has(rel))
    expect(hits).toEqual([])
  })

  it('no filled control puts white on the fill red', () => {
    const hits = files
      .filter(([, src]) => /\bbg-danger(?!-)[^"'`]*\btext-white\b|\btext-white\b[^"'`]*\bbg-danger(?!-)/.test(src))
      .map(([rel]) => rel)
    expect(hits).toEqual([])
  })
})
