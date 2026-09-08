import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The page-width invariant, pinned in the only place that can catch a regression cheaply.
//
// `body` is a centred flex column (index.css), so its one child #root is a flex item that is NOT
// stretched — shrink-to-fit. Without an explicit width the app's page width is the intrinsic
// width of whatever happens to be mounted, and a subtree that contributes nothing collapses the
// whole screen to zero, which `align-items: center` then parks at the middle of the viewport
// with every card overflowing to its right (#233).
//
// This degrades in near-silence: the route still works, the colours and fonts are all correct,
// and it only shows on the devices that trip the collapse. Hence a test rather than a comment.

const src = dirname(fileURLToPath(import.meta.url))
// Comments stripped, because this file's rules are explained at length right above themselves and
// a prose mention of `#root` or `100vw` must not read as the declaration.
const css = readFileSync(join(src, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const ruleFor = (selector: string) =>
  css.match(new RegExp(`^[^{}\\n]*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{}\\n]*\\{[^}]*\\}`, 'm'))?.[0]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('page width', () => {
  // Both levels, because anchoring only the outer one moves the shrink-wrap down rather than
  // removing it: .route-view is PageTransition's wrapper and sits between #root and every screen.
  it.each(['#root', '.route-view'])('gives %s an explicit full width', selector => {
    const rule = ruleFor(selector)
    expect(rule).toBeTruthy()
    expect(rule).toMatch(/width:\s*100%/)
  })

  it('sizes .form-wrap from its parent, never from the viewport', () => {
    const rule = ruleFor('.form-wrap')
    expect(rule).toBeTruthy()
    expect(rule).toMatch(/width:\s*100%/)
    expect(rule).not.toMatch(/vw/)
  })

  // A viewport unit is the failure this whole file exists to stop: an in-app browser that lays
  // the page out off screen can resolve `100vw` as 0, and every width derived from it goes with
  // it. A percentage of a real in-flow ancestor cannot fail that way. `vh`/`dvh` are unaffected —
  // a zero-height min-height is harmless — so only the inline axis is banned.
  //
  // The exception is a `position: fixed` overlay, and it is an exception for a reason rather
  // than by exhaustion: a fixed box's containing block IS the viewport, so it has no in-flow
  // ancestor to take a percentage of, and a `vw` cap is what gives it its margin from the
  // screen edge. Add to this list only for another fixed or absolutely-positioned overlay.
  // (The dashboard rail used to be here for its mobile drawer's `82vw` cap; on shadcn's
  // Sidebar the sheet is sized in rem, so it no longer needs the exemption.)
  const FIXED_OVERLAYS = ['merchant/MenuImportDialog.tsx']

  it('derives no in-flow width from a viewport unit', () => {
    const offenders = sourceFiles(src)
      .filter(path => !FIXED_OVERLAYS.includes(path.slice(src.length + 1)))
      .filter(path => /\b(?:max-)?w(?:idth)?[-:[(]?[^;"'`]*\b\d+(?:vw|dvw|svw|lvw)\b/.test(readFileSync(path, 'utf8')))
      .map(path => path.slice(src.length + 1))
    expect(offenders).toEqual([])
  })
})
