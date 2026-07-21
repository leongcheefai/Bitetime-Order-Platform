# OG cover card — design

Issue: [#97](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/97) — `chore: design og card`

## Problem

`apps/frontend/index.html` already advertises `og:image` and `twitter:image` at
`https://bitetime-order-platform.vercel.app/og-cover.jpg`. That file does not exist.
Every link TinyOrder's own merchants paste into WhatsApp, Instagram or Facebook —
the exact channels the product tells them to sell through — currently renders as a
bare grey box.

## Goal

One static 1200×630 share card that reads as TinyOrder and only TinyOrder, plus the
Open Graph metadata a scraper needs to render it correctly. Out of scope: per-merchant
storefront OG images (`/s/:slug`), which need runtime generation and a separate issue.

## The design

### Concept: the receipt

The brand mark is already a receipt with a torn, perforated bottom edge. The card is
that mark at poster scale — an actual printed receipt, photographed flat on the
product's cream ground.

This is the anti-generic constraint, and it is a hard one. **No gradient mesh, no
glassmorphism, no floating 3D phone, no stock food photography, no blue or purple.**
The card must look printed, not rendered. Anything that could appear on a different
company's OG card with the logo swapped out has failed the brief.

### Composition

`1200×630`. Ground is cream `#F2EAE0` carrying the same SVG `feTurbulence` grain the
landing page uses (`GrainOverlay`), at roughly 3% opacity.

Centred on it, a receipt ≈760px wide, tilted `-1.5°`, with
`box-shadow: 0 24px 60px -20px rgba(43, 10, 16, 0.28)`. The paper is white `#FFFFFF`,
not cream — the sheet has to separate from the ground or the tilt reads as an accident.

The receipt's top and bottom edges are zigzag perforations cut with a CSS `clip-path`
polygon, at the same tooth pitch as the logo mark's torn edge. That silhouette is the
load-bearing idea: it is the brand mark's own shape, so the card cannot be reproduced
by anyone who is not TinyOrder.

The receipt's left edge carries nothing — no icon column, no rail. Print discipline.

### What is printed

| Block | Type | Colour |
|---|---|---|
| `TINYORDER` lockup | the real `tinyorder-logo.png`, h ≈ 34px | oxblood |
| rule | dotted, 2px dash / 6px gap | `--color-clay-border` `#C9A090` |
| `Sell your food online — without the DM chaos.` | Lora 500, 60px, `line-height: 1.14`, `letter-spacing: -0.01em` | `--color-ink` `#2B0A10` |
| rule | dotted | `--color-clay-border` |
| `1  YOUR OWN STOREFRONT LINK`<br>`1  EVERY ORDER IN ONE PLACE`<br>`1  BILINGUAL · 中英双语` | DM Sans 500, 17px, uppercase, `letter-spacing: 0.08em`; qty column left, label right | `--color-rose-muted` `#7A4F55` |
| rule | dotted | `--color-clay-border` |
| `TOTAL` … `7 DAYS FREE` | DM Sans 500, 20px, justified to both edges | `--color-oxblood` `#7A1028` |

Every string is lifted verbatim from the live landing page — the `h1`, the three value
props, and the `7-day free trial — no card required` line under the pricing heading.
Nothing is invented for the card, so the card cannot drift from the site.

`中英双语` on the third line makes the bilingual claim demonstrate itself rather than
assert itself.

### Why the headline sits on the receipt

Share cards are consumed at ~500px in a feed and ~200px in a WhatsApp reply thumbnail.
Only one element survives that. Putting the headline on the paper means the thumbnail
resolves to a zigzag silhouette plus one dark block of type; the line items degrade
into texture, which is what small print on a receipt looks like anyway. A split layout
(headline left, receipt right) would give the headline more size but leaves two focal
points competing at the size where it matters most.

## Pipeline

Source of truth is HTML, rendered to a committed JPEG. The image is a build *output*
that lives in git, not a build *step* — regeneration is manual and deliberate.

This follows the generator pattern `apps/frontend/scripts/gen-postcodes.ts` already
establishes: a `.ts` one-off, run by hand via `pnpm dlx tsx`, with its output committed
and its invocation documented in a header comment. No `package.json` script, because a
script entry implies something CI might run.

- **`apps/frontend/scripts/og-cover.html`** — self-contained. Lora and DM Sans are
  inlined as base64 `woff2` and the logo as a base64 PNG, so rendering touches the
  network zero times and the same input always produces the same pixels. Colour values
  are hardcoded hex with a comment pointing back at `src/tokens.css`; the render has no
  Tailwind or Vite in front of it, so it cannot read the tokens at build time.
- **`apps/frontend/scripts/og-cover.ts`** — viewport `1200×630`,
  `deviceScaleFactor: 2`, `screenshot({ type: 'jpeg', quality: 92 })` →
  `public/og-cover.jpg`. Run with
  `pnpm dlx tsx apps/frontend/scripts/og-cover.ts` from the repo root.
- **`apps/frontend/package.json`** — adds `playwright-core` as a devDependency, not
  `playwright`. `playwright-core` ships no browser binaries, so it costs every
  `pnpm install` about 2MB instead of a ~150MB Chromium download; the script launches
  the developer's installed Chrome with `chromium.launch({ channel: 'chrome' })`. The
  script must fail with a readable message naming Chrome if that launch throws, since
  the default Playwright error points at an install step that does not apply here.

Deliberately not wired into `build`: regenerating a file that changes twice a year on
every Vercel deploy is a bad trade.

JPEG at q92 keeps the existing `og:image` path unchanged and lands well under
WhatsApp's ~300KB scraper ceiling, which PNG would not once the grain is in.

## Metadata

`apps/frontend/index.html` gains, alongside the existing tags:

- `og:url` — `https://bitetime-order-platform.vercel.app/`, matching the origin
  `og:image` already points at
- `og:image:width` `1200`, `og:image:height` `630` — lets a scraper lay out the card
  before it has finished fetching the image
- `og:image:alt` and `twitter:image:alt`

`og:image` is already absolute, which is required — relative URLs are silently dropped
by most scrapers.

## Verification

Per `CLAUDE.md`, UI is verified by running the app. For this change that means:

1. `pnpm dlx tsx apps/frontend/scripts/og-cover.ts` writes `public/og-cover.jpg`;
   confirm the file is 1200×630 and under 300KB.
2. Open the rendered JPEG and check it at full size and scaled to ~200px wide — the
   headline must still be legible at thumbnail size.
3. Run the app and confirm `/og-cover.jpg` is served.
4. After deploy, run the URL through a scraper preview (e.g. opengraph.xyz) to confirm
   the card renders in the WhatsApp/Facebook/Twitter previews.

No unit tests. The asset has no logic to test, and asserting on a screenshot's bytes
would fail on every font-rendering difference without catching a single real defect.
