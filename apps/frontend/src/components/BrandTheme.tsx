import type { CSSProperties, ReactNode } from 'react'
import { brandTheme } from '../brandTheme'

/**
 * Puts one shop's derived palette on a subtree.
 *
 * THE OVERRIDE SET IS THE WHOLE POINT, and it is longer than it looks like it should be.
 * `index.css` declares `--primary: var(--color-accent)` on `:root`, and `var()` is substituted
 * where the declaration lives — so descendants inherit an already-resolved oxblood, and overriding
 * `--color-accent` alone changes NOTHING about `--primary`, `--ring` or `--focus-ring`. The result
 * of getting this wrong is a half-branded page that looks like a caching bug. Every token that
 * carries the accent has to be restated here, and `brandScope.test.ts` walks the stylesheets to
 * prove none was missed.
 *
 * THE RAMP IS SET AS PRIMITIVES, `--brand-*`, not as the `--color-brand-*` bridge next to it, and
 * that is not interchangeable. Both `@theme` blocks in index.css are `@theme inline`, which means
 * Tailwind substitutes the value at BUILD time: `bg-brand-600` compiles to
 * `background-color: var(--brand-600)`, and `--color-brand-600` is never read at runtime at all.
 * Setting the bridge here would look right and do nothing. (Checked against the built CSS, not
 * inferred.)
 *
 * The ramp is here in the first place because `bg-brand-wash` is the app's pale wash, with forty-odd
 * call sites, twelve of them on branded surfaces. A shop with a green accent and pink washes reads
 * as a half-finished theme.
 *
 * `display: contents` so the wrapper adds no box and cannot disturb any layout it wraps.
 */
export default function BrandTheme({ color, children }: {
  /** `merchants.brand_color`. Null, absent or malformed all give the platform palette. */
  color: string | null | undefined
  children: ReactNode
}) {
  const t = brandTheme(color)
  const style = {
    display: 'contents',
    // Semantic accent tokens. The ON-FILL colour is carried by `--primary-foreground` below, which
    // is what the utilities read; a `--color-accent-fg` here would be written and never read.
    '--color-accent': t.accent,
    '--color-accent-hover': t.accentHover,
    '--color-accent-text': t.accentText,
    '--color-focus-ring': t.ring,
    '--color-brand-wash': t.tint100,
    // tokens.css builds this at :root as `0 0 0 2px var(--color-focus-ring)`, already substituted
    // by the time it inherits — so the whole box-shadow is rebuilt, not just its colour.
    '--focus-ring': `0 0 0 2px ${t.ring}`,
    // The ramp. These are what bg-brand-*, text-brand-* and hover:bg-brand-* actually read.
    '--brand-50': t.tint50,
    '--brand-100': t.tint100,
    '--brand-200': t.tint200,
    '--brand-400': t.light400,
    '--brand-500': t.accent,
    '--brand-600': t.accentHover,
    '--brand-700': t.accentDeep,
    // The shadcn bridge, which :root already resolved.
    '--primary': t.accent,
    '--primary-foreground': t.accentFg,
    '--ring': t.accent,
    // The dashboard rail's focus ring reads `--ring`, which :root has likewise already resolved.
    '--sidebar-ring': t.accent,
  } as CSSProperties
  return <div data-brand="" style={style}>{children}</div>
}
