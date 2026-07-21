// One-off generator for the Open Graph share card. NOT run at build time —
// run it manually to (re)produce public/og-cover.jpg, which is committed.
//
// Run from the repo root:
//   pnpm dlx tsx apps/frontend/scripts/og-cover.ts
//
// Design: docs/superpowers/specs/2026-07-21-og-cover-design.md
//
// Fonts are fetched from Google Fonts at GENERATE time using the css2
// endpoint's `text=` parameter, which returns a woff2 containing only the
// glyphs actually printed — a few KB rather than the ~8MB a full Noto Sans SC
// would cost for four CJK characters. They are then inlined as base64, so the
// render itself touches the network zero times. Deriving the subset from the
// copy on every run is also what stops a copy edit from silently producing
// tofu.
//
// The script throws rather than writing a bad file: a share card that is the
// wrong size, or too heavy for a scraper to fetch, fails invisibly in
// production because nothing renders it in CI.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(HERE, 'og-cover.html')
const LOGO = join(HERE, '..', 'src', 'assets', 'tinyorder-logo@2x.png')
const OUT = join(HERE, '..', 'public', 'og-cover.jpg')

const WIDTH = 1200
const HEIGHT = 630
const MAX_BYTES = 300 * 1024 // WhatsApp stops fetching past ~300KB.

// Every glyph the card prints, per family. These MUST stay in sync with the
// copy in og-cover.html — a character here that is missing from the markup
// only wastes bytes, but a character in the markup that is missing here
// renders as tofu.
const FONTS = [
  {
    family: 'Lora',
    weight: 500,
    text: 'Sell your food online — without the DM chaos.',
  },
  {
    // Uppercase, because the template sets text-transform: uppercase — the
    // subset must contain the glyphs Chrome actually paints, not the ones in
    // the markup. The leading digit (1) is the quantity column; including it
    // ensures CSS font-stack fallback lands all glyphs in DM Sans, not per-glyph
    // fallback to the system sans-serif. Google dedupes the characters itself,
    // so passing the whole string is both correct and readable.
    family: 'DM Sans',
    weight: 500,
    text: '1YOUR OWN STOREFRONT LINK EVERY ORDER IN ONE PLACE BILINGUAL · TOTAL 7 DAYS FREE',
  },
  {
    family: 'Noto Sans SC',
    weight: 500,
    text: '中英双语',
  },
] as const

// Google Fonts serves woff2 only to browser-like clients; with Node's default
// UA it returns ttf, which is 3-4× larger for identical pixels.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function fetchOne(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res
}

/** Fetch glyph-subset woff2 for each family and return inlinable @font-face CSS. */
async function buildFontFaces(): Promise<string> {
  const faces: string[] = []

  for (const font of FONTS) {
    const url =
      'https://fonts.googleapis.com/css2' +
      `?family=${encodeURIComponent(font.family)}:wght@${font.weight}` +
      `&text=${encodeURIComponent(font.text)}`

    const css = await (await fetchOne(url)).text()

    // Google's kit-based CDN serves e.g. fonts.gstatic.com/l/font?kit=... —
    // the URL itself no longer ends in `.woff2` (that was true of the older
    // /s/<family>/<version>/<file>.woff2 static path). Match on the
    // format('woff2') hint instead of the URL's own extension.
    const woff2 = css.match(/url\((https:\/\/[^)]+)\)\s*format\('woff2'\)/)?.[1]
    if (!woff2) {
      throw new Error(
        `No woff2 in the Google Fonts response for ${font.family}. ` +
          `Got:\n${css.slice(0, 400)}`
      )
    }

    const bytes = Buffer.from(await (await fetchOne(woff2)).arrayBuffer())
    faces.push(
      `@font-face{font-family:'${font.family}';font-style:normal;` +
        `font-weight:${font.weight};font-display:block;` +
        `src:url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2')}`
    )
  }

  return faces.join('\n')
}

/** Width and height from a JPEG's SOF marker — enough to prove the output shape. */
function jpegSize(buf: Buffer): { width: number; height: number } {
  let i = 2 // skip SOI
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error(`Not a JPEG: bad marker at byte ${i}`)
    const marker = buf[i + 1]
    const len = buf.readUInt16BE(i + 2)
    // SOF0/1/2/3 and SOF5-7, SOF9-11, SOF13-15 all carry the frame header.
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (isSOF) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  throw new Error('No SOF marker found — the screenshot is not a JPEG')
}

async function main() {
  const fontFaces = await buildFontFaces()
  const logo = `data:image/png;base64,${readFileSync(LOGO).toString('base64')}`

  const html = readFileSync(TEMPLATE, 'utf8')
    .replace('{{FONT_FACES}}', fontFaces)
    .replace('{{LOGO}}', logo)

  if (html.includes('{{')) {
    throw new Error('A {{placeholder}} survived substitution — check og-cover.html')
  }

  let browser
  try {
    browser = await chromium.launch({ channel: 'chrome' })
  } catch (cause) {
    throw new Error(
      'Could not launch Google Chrome. This script uses playwright-core, ' +
        'which ships no browsers of its own — install Chrome rather than ' +
        'running `playwright install`.',
      { cause }
    )
  }

  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 2,
    })
    await page.setContent(html, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)

    // deviceScaleFactor: 2 above supersamples the render for crisp text: with
    // the default scale: 'device', screenshot() would emit one pixel per
    // device pixel (2400×1260). scale: 'css' downsamples back to one pixel
    // per CSS pixel — the 1200×630 the design spec and og:image:width/height
    // both require — while keeping the antialiasing quality of the 2x render.
    const shot = await page.screenshot({ type: 'jpeg', quality: 92, scale: 'css' })

    const { width, height } = jpegSize(shot)
    if (width !== WIDTH || height !== HEIGHT) {
      throw new Error(`Expected ${WIDTH}×${HEIGHT}, rendered ${width}×${height}`)
    }
    if (shot.byteLength > MAX_BYTES) {
      throw new Error(
        `${(shot.byteLength / 1024).toFixed(0)}KB exceeds the ${MAX_BYTES / 1024}KB ` +
          'scraper ceiling — lower the JPEG quality or the grain opacity'
      )
    }

    writeFileSync(OUT, shot)
    console.log(`Wrote ${OUT} — ${width}×${height}, ${(shot.byteLength / 1024).toFixed(0)}KB`)
  } finally {
    await browser.close()
  }
}

await main()
