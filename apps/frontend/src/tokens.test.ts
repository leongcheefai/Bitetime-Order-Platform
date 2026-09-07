import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { contrastRatio } from './contrast'

/* Read the stylesheet rather than a duplicated TS copy of it: a token table that
   mirrors the CSS can drift from it silently, and then this suite passes while the
   app ships the wrong colour. */
const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8')

function token(name: string): string {
  const m = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(css)
  if (!m) throw new Error(`Token not found in tokens.css: ${name}`)
  const value = m[1].trim()
  if (!value.startsWith('#')) throw new Error(`${name} is not a literal hex: ${value}`)
  return value
}

const AA_TEXT = 4.5
const AA_LARGE = 3.0

describe('primitives are present and literal', () => {
  const required = [
    '--ink-50', '--ink-100', '--ink-200', '--ink-300', '--ink-400',
    '--ink-500', '--ink-600', '--ink-700', '--ink-900', '--ink-950',
    '--white', '--cream',
    '--brand-50', '--brand-100', '--brand-200',
    '--brand-400', '--brand-500', '--brand-600', '--brand-700',
  ]
  it.each(required)('%s is a hex literal', (name) => {
    expect(token(name)).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })

  it('keeps oxblood as the accent', () => {
    expect(token('--brand-500').toUpperCase()).toBe('#7A1028')
  })

  it('ships no second accent', () => {
    expect(css).not.toMatch(/--accent-500/)
    expect(css).not.toMatch(/--color-gold/)
  })
})

describe('the brand ramp is monotonic', () => {
  // A ramp whose "deeper" step is lighter than its "deep" step is the bug the old
  // oxblood-deep/-deeper pair shipped. This is what stops it recurring.
  it('darkens from 50 to 700', () => {
    const steps = ['--brand-50', '--brand-100', '--brand-200', '--brand-500', '--brand-600', '--brand-700']
    const whiteContrast = steps.map((s) => contrastRatio(token(s), '#FFFFFF'))
    for (let i = 1; i < whiteContrast.length; i++) {
      expect(whiteContrast[i]).toBeGreaterThan(whiteContrast[i - 1])
    }
  })

  it('makes brand-400 lighter than brand-500, for use on dark surfaces', () => {
    expect(contrastRatio(token('--brand-400'), '#FFFFFF'))
      .toBeLessThan(contrastRatio(token('--brand-500'), '#FFFFFF'))
  })
})

/* The canvas is CREAM, not --ink-50, and cream is lighter — every text pair has less room
   on it than on the zinc ladder. Assert against the surface each thing actually sits on:
   the page for page-level copy, white for anything inside a card. */
describe('light-theme text clears AA', () => {
  it('body text on the page background', () => {
    expect(contrastRatio(token('--ink-900'), token('--cream'))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('muted text on the page background', () => {
    expect(contrastRatio(token('--ink-600'), token('--cream'))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('muted text on a raised surface', () => {
    expect(contrastRatio(token('--ink-600'), token('--white'))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  /* --ink-500 is the border/icon grey. It reaches 4.06:1 on cream, so it must NOT be used
     for text there — that is what --ink-600 exists for. Pinned so a future edit cannot
     quietly point a text alias back at it. */
  it('the border grey is not viable as text on the canvas', () => {
    expect(contrastRatio(token('--ink-500'), token('--cream'))).toBeLessThan(AA_TEXT)
  })

  /* --ink-500 is the border/icon grey on cream, but it DOES clear AA on white (4.83:1) — and
     that is what lets Input/Textarea set their placeholder a step lighter than muted copy, so a
     hint stops reading as a value. Pinned in both directions: the assertion above forbids it as
     text on the canvas, this one keeps the placeholder treatment legal on the surface it
     actually sits on. Lighten --ink-500 and one of the two fails. */
  it('the border grey IS viable as placeholder text on a raised surface', () => {
    expect(contrastRatio(token('--ink-500'), token('--white'))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('the accent on the page background', () => {
    expect(contrastRatio(token('--brand-500'), token('--cream'))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('accent text on its own tint (chips, active rows)', () => {
    expect(contrastRatio(token('--brand-700'), token('--brand-50'))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  // --ink-400 is Voltage's --color-text-subtle. It does NOT clear AA as body text on
  // #FAFAFA (~2.46:1), which is the same trap the old clay-muted token documented. It is
  // permitted for borders and decorative icons only; this asserts the weaker floor it must
  // still meet, so nobody later promotes it to text.
  it('subtle is held to the non-text floor only', () => {
    const ratio = contrastRatio(token('--ink-400'), token('--cream'))
    expect(ratio).toBeLessThan(AA_TEXT)
    expect(ratio).toBeGreaterThanOrEqual(1.5)
  })
})

/* WCAG exempts inactive controls from contrast requirements, so this is a legibility
   floor we choose rather than one we owe. It exists because the treatment it replaced --
   opacity-50 on an oxblood fill -- landed at 2.82:1 and was genuinely hard to read. */
describe('the disabled treatment stays legible', () => {
  it('disabled label on the disabled fill', () => {
    expect(contrastRatio(token('--ink-600'), token('--ink-200'))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('the disabled fill is distinguishable from the canvas', () => {
    expect(contrastRatio(token('--ink-200'), token('--cream'))).toBeGreaterThanOrEqual(1.05)
  })
})

describe('dark-theme accent clears AA', () => {
  it('brand-400 on the darkest surface', () => {
    expect(contrastRatio(token('--brand-400'), token('--ink-950'))).toBeGreaterThanOrEqual(AA_TEXT)
  })
})

describe('status chips clear AA', () => {
  const pairs: Array<[string, string, string]> = [
    ['success', '--success-fg', '--success-100'],
    ['warning', '--warning-fg', '--warning-100'],
    ['danger', '--danger-fg', '--danger-100'],
    ['info', '--info-fg', '--info-100'],
    ['neutral', '--neutral-fg', '--neutral-100'],
  ]
  it.each(pairs)('%s chip text on its own tint', (_name, fg, bg) => {
    expect(contrastRatio(token(fg), token(bg))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  /* The inline-error colour is `--danger-fg`, on every surface — not `--danger-500`. The
     `-500` red is a FILL and a border: as 13px text it reaches 3.76:1 on white, 3.16:1 on cream
     and 3.08:1 on its own tint, and the audit found it under fifteen error messages, the customer's
     checkout refusal among them. These pins hold both halves: the text token clears AA wherever
     an error can land, and the fill token stays a colour nobody can promote to text by accident. */
  it('inline-error text clears AA on white and on the canvas', () => {
    expect(contrastRatio(token('--danger-fg'), token('--white'))).toBeGreaterThanOrEqual(AA_TEXT)
    expect(contrastRatio(token('--danger-fg'), token('--cream'))).toBeGreaterThanOrEqual(AA_TEXT)
  })
  it('the danger fill is not a text colour', () => {
    expect(contrastRatio(token('--danger-500'), token('--white'))).toBeLessThan(AA_TEXT)
    expect(contrastRatio(token('--danger-500'), token('--cream'))).toBeLessThan(AA_TEXT)
  })

  /* Against WHITE, because a status chip lives inside a card — an order row, a detail
     drawer — never directly on the cream canvas. Asserting it against the page would be
     testing a pairing the UI does not produce. */
  it.each(pairs)('%s tint is distinguishable from the card surface', (_name, _fg, bg) => {
    expect(contrastRatio(token(bg), token('--white'))).toBeGreaterThanOrEqual(1.05)
  })

  it('info does not collide with the brand accent', () => {
    expect(token('--info-500').toUpperCase()).not.toBe(token('--brand-500').toUpperCase())
  })
})

describe('solid status fills carry legible white text', () => {
  /* --warning-500 is deliberately absent: white on amber is 2.15:1 and no amber fill in
     this design carries white text (the warning chip is warn-fg on warn-100). Adding it
     here would force the amber darker to satisfy a pairing nothing uses. */
  it.each(['--success-500', '--danger-500', '--info-500'])('%s', (name) => {
    expect(contrastRatio('#FFFFFF', token(name))).toBeGreaterThanOrEqual(AA_LARGE)
  })

  /* The two SOLID status badges — `new` on info-fg and `ready` on success-fg — set white at
     11px, which is small text and so owes the full 4.5:1, not the large-text figure above. */
  it.each(['--info-fg', '--success-fg'])('%s carries small white text', (name) => {
    expect(contrastRatio('#FFFFFF', token(name))).toBeGreaterThanOrEqual(AA_TEXT)
  })
})

describe('non-colour scales exist', () => {
  it.each([
    '--space-1', '--space-4', '--space-20',
    '--elev-1', '--elev-3', '--focus-ring',
    '--ease-out', '--dur-base',
    '--icon-sm', '--icon-xl',
  ])('%s is defined', (name) => {
    expect(css).toMatch(new RegExp(`^\\s*${name}:`, 'm'))
  })
})

describe('radii are the Voltage sharp scale', () => {
  it.each([
    ['--radius-xs', '2px'],
    ['--radius-sm', '4px'],
    ['--radius-md', '4px'],
    ['--radius-lg', '8px'],
    ['--radius-xl', '8px'],
    ['--radius-2xl', '12px'],
    ['--radius-pill', '9999px'],
  ])('%s is %s', (name, expected) => {
    expect(new RegExp(`${name}:\\s*${expected};`).test(css)).toBe(true)
  })
})
