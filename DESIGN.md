---
name: BiteTime
description: Warm, hand-lettered storefront for a multi-merchant food-ordering platform
colors:
  oxblood: "#7A1028"
  oxblood-deep: "#550A1A"
  oxblood-tint: "#F5E6E8"
  ink: "#2B0A10"
  ink-soft: "#4A2530"
  rose-muted: "#7A4F55"
  clay-muted: "#A07070"
  text-tertiary: "#8A5550"
  clay-border: "#C9A090"
  rose-border: "#C9A0A8"
  cream: "#F2EAE0"
  surface-raised: "#FBF6F0"
  surface-high: "#FFFDF9"
  surface-sunken: "#EDE4D8"
  divider: "#D9C8BC"
  gold-accent: "#C9A030"
  gold-bg: "#FFF8E6"
  gold-border: "#E8C96A"
  success-fg: "#155724"
  success-bg: "#C3E6CB"
  info-fg: "#0C5460"
  info-bg: "#D1ECF1"
  prep-fg: "#5A1A7A"
  prep-bg: "#E8D5F5"
  warn-fg: "#856404"
  warn-bg: "#FFF3CD"
  neutral-fg: "#4A3020"
  danger-fg: "#721C24"
  danger-bg: "#F8D7DA"
  danger: "#C0392B"
typography:
  display:
    fontFamily: "Lora, Georgia, serif"
    fontSize: "26px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "0.3px"
  headline:
    fontFamily: "Lora, Georgia, serif"
    fontSize: "22px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.5px"
  title:
    fontFamily: "Lora, Georgia, serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.01em"
  label:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.09em"
  mono:
    fontFamily: "DM Mono, 'Courier New', monospace"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "1px"
rounded:
  xs: "4px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "14px"
  2xl: "16px"
  pill: "20px"
  round: "50%"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.oxblood}"
    textColor: "{colors.cream}"
    rounded: "{rounded.lg}"
    padding: "14px"
  button-primary-hover:
    backgroundColor: "{colors.oxblood-deep}"
    textColor: "{colors.cream}"
    rounded: "{rounded.lg}"
    padding: "14px"
  button-ghost:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.rose-muted}"
    rounded: "{rounded.sm}"
    padding: "7px 14px"
  input:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "7px 10px"
  pill-button:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.rose-muted}"
    rounded: "{rounded.pill}"
    padding: "5px 14px"
  status-chip:
    backgroundColor: "{colors.success-bg}"
    textColor: "{colors.success-fg}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
---

# Design System: BiteTime

## 1. Overview

**Creative North Star: "The Hand-Lettered Shopfront"**

BiteTime is a small food shop's signage made digital. The wordmark and headings are set in Lora — a humanist serif that reads like painted shop lettering — and they sit on warm cream surfaces the colour of unbleached paper and pastry. The signature colour is oxblood (`#7A1028`): a deep, confident wine-red borrowed from awnings, jam, and a stamped receipt, never bright or fast-food-loud. The whole system feels handmade and hospitable: soft pill buttons, clay-coloured hairline borders, and tints that warm rather than glow. A customer should feel they walked up to *that shop's* storefront, not logged into a platform.

The system works by tonal layering, not decoration. Depth comes from stepping warm neutrals — cream body, raised pastry-white panels, sunken taupe rails — separated by 1.5px clay strokes, not from shadows or gradients. Type carries the warmth (serif display + humanist sans body); the background stays quietly committed to its warm hue rather than shouting. Bilingual by design: every surface holds equally in English and 中文, so layouts breathe at both string lengths.

This explicitly rejects the **generic SaaS dashboard** (cold blue/grey panels, hero-metric templates, endless identical icon-cards) and **corporate fintech** (navy-and-gold, sterile, transactional). Even the merchant and admin screens stay on this warm palette; an order table is still hospitable. No gradient text, no decorative glass, no cream-near-white standing in for committed colour.

**Key Characteristics:**
- Oxblood-on-cream identity, warm through and through — operational screens included
- Lora serif signage paired with DM Sans body on a serif/sans contrast axis
- Flat surfaces, tonal warm-neutral layering, 1.5px clay hairline borders
- Soft pill geometry (20px) and gentle tinted hover states
- Full EN / 中文 parity as a structural constraint, not a translation layer

## 2. Colors

A warm, low-glow palette: one committed oxblood accent over a ladder of cream-to-taupe neutrals, with a muted six-state semantic set for order status.

### Primary
- **Oxblood** (`#7A1028`): The single brand voice. Primary buttons, the wordmark and serif headings, active nav, badges, focus rings, the notification dot. Carries identity on every screen.
- **Oxblood Deep** (`#550A1A`): Hover/pressed state for oxblood surfaces only. Never used as a resting fill.
- **Oxblood Tint** (`#F5E6E8`): The faint rose wash behind an active/selected row or the add-button hover. The accent at 8% strength.

### Secondary
- **Gold Accent** (`#C9A030`) on **Gold Wash** (`#FFF8E6`) with **Gold Border** (`#E8C96A`): Reserved strictly for shipment / tracking (AWB) affordances. A functional secondary, not a decorative one — if it appears outside tracking, it's misused.

### Neutral
- **Cream** (`#F2EAE0`): The body background and input fills. The unbleached-paper base everything sits on.
- **Surface Raised** (`#FBF6F0`): Panels, cards, form wraps — a pastry-white step above cream.
- **Surface High** (`#FFFDF9`): Floating UI only (notification panel, popovers) — the highest, lightest step.
- **Surface Sunken** (`#EDE4D8`): The sidebar and recessed rails — a taupe step *below* cream.
- **Divider** (`#D9C8BC`): Hairline rules inside panels and sidebar sections.
- **Clay Border** (`#C9A090`): The default 1.5px stroke on inputs, pills, cards. The system's signature edge.
- **Rose Border** (`#C9A0A8`): Warm-toned border for admin panels and delete affordances.
- **Ink** (`#2B0A10`): Primary text — a near-black with a maroon undertone, never pure black.
- **Ink Soft** (`#4A2530`): Sidebar nav labels and slightly-recessed body text.
- **Rose Muted** (`#7A4F55`): Secondary text, field labels, captions. Passes AA on cream (5.73:1).
- **Text Tertiary** (`#8A5550`): The lightest text still legible — dates, stat labels, captions, table meta, empty states. Clears AA on cream/raised/sunken (≥4.5:1). This is the token for tertiary *text*.
- **Clay Muted** (`#A07070`): Borders and decorative icons **only** — fails AA as text (3.49:1 on cream). Never set type in it; use Text Tertiary instead.

### Semantic (order status — the six-state set)
- **Pending** — `#155724` on `#C3E6CB` (green)
- **Confirmed** — `#0C5460` on `#D1ECF1` (teal)
- **Preparing** — `#5A1A7A` on `#E8D5F5` (plum)
- **Ready** — `#856404` on `#FFF3CD` (amber)
- **Completed** — `#4A3020` on `#EDE4D8` (taupe / done)
- **Cancelled** — `#721C24` on `#F8D7DA` (red); inline errors use **Danger** `#C0392B`

### Named Rules
**The One Voice Rule.** Oxblood is the only brand accent. It does not compete with a second saturated colour — gold is functional (tracking) and the semantic set is reserved for status. If a screen has two accents fighting, one of them is wrong.

**The Warm-Floor Rule.** No surface is cooler than its hue allows. Every neutral steps along the cream→taupe ladder; never reach for a grey (`#EEE`, `#F5F5F5`, slate). A cool neutral on this palette reads instantly as the SaaS default the brand rejects.

## 3. Typography

**Display Font:** Lora (with Noto Serif SC → Georgia, serif fallback)
**Body Font:** DM Sans (with Noto Sans SC → sans-serif fallback)
**Label/Mono Font:** DM Mono (with 'Courier New', monospace) — order numbers, voucher codes, AWB
**CJK Font:** Noto Serif SC (headings) / Noto Sans SC (body) — the bilingual EN/ZH siblings. Latin glyphs never reach them; they render only Chinese, so the storefront/dashboard keep a single consistent type voice across both languages instead of a browser fallback face.

**Character:** A clean serif/sans contrast pairing. Lora is the painted shop sign — humanist, slightly bookish, used at modest sizes with warmth rather than grandeur. DM Sans is the legible counter-clerk handwriting underneath: neutral, quiet, sized small and dense for forms and tables. Monospace appears only where a code must be read character-by-character.

### Hierarchy
- **Display** (Lora 500, 26px, lh 1.15, +0.3px): The brand wordmark and primary screen headings. The landing hero scales up from here.
- **Headline** (Lora 500, 22px, +0.5px): Sidebar logo, section heads.
- **Title** (Lora 500, 15px): Panel titles, card headings — serif used small to keep warmth in dense UI.
- **Body** (DM Sans 400, 16px, lh 1.5): All running copy, form values, inputs, buttons, table cells. This is the `text-sm` utility (redefined to 16px in `index.css`) — the readability floor. Cap measure at 65–75ch in prose. Dense compact variants (product rows, admin fields) may drop to 14px.
- **Field Label** (DM Sans, 14px): Input/field labels above controls (`label.tsx`) — sits just under body.
- **Eyebrow/Tag** (DM Sans 500, 10–11px, +0.09em, uppercase): Section eyebrows, role tags. Stays small — `text-xs`/`text-[11px]`, unaffected by the body floor.
- **Mono** (DM Mono 700, 14px, +1px): Order numbers (`PREFIX-YYYYMMDD-XXXX`), voucher codes, AWB only.

### Named Rules
**The Serif-Signage Rule.** Lora is for names and headings — the shop's lettering. It never sets body copy, form labels, or table data; that is always DM Sans. Serif paragraphs would break the signage metaphor.

**The Modest-Display Rule.** Display tops out around the landing hero; everywhere else serif stays small (≤26px). Warmth comes from the typeface, not from shouting size. Keep display letter-spacing ≥ -0.02em — these letters never crowd.

## 4. Elevation

Flat by default, with depth built from **tonal layering**: surfaces step along the warm-neutral ladder (sunken taupe → cream → raised pastry-white → floating high-white) and are separated by 1.5px clay hairline borders, not shadows. Resting cards, panels, and form wraps carry **no** shadow — only a border and a surface step. Shadows are reserved exclusively for elements that genuinely float above the page.

### Shadow Vocabulary (floating UI only)
- **Focus ring** (`box-shadow: 0 0 0 2px rgba(122,16,40,0.1)`): Every focused input/field. The oxblood-tinted glow is the standard focus affordance (3px on larger controls).
- **Popover** (`box-shadow: 0 8px 24px rgba(43,10,16,0.16)`): Notification panel, dropdowns.
- **Sidebar** (`box-shadow: 0 2px 12px rgba(122,16,40,0.07)` / `6px 0 32px rgba(43,10,16,0.12)`): The sticky rail's quiet lift off the page.
- **Sticky bar** (`box-shadow: 0 -4px 20px rgba(43,10,16,0.10)`): The mobile sticky checkout/submit bar, lifting up from the bottom edge.
- **Modal** (`box-shadow: 0 12px 48px rgba(43,10,16,0.25)`): Overlay dialogs only.

### Named Rules
**The Flat-Rest Rule.** A surface at rest has a border and a tonal step, never a drop shadow. If you reach for `box-shadow` on a card, you've skipped the surface ladder — step the background colour instead. Shadows answer only to "this floats" (popover, sticky, modal, focus), never to "this is a card."

## 5. Components

### Buttons
- **Shape:** Soft and hospitable. Primary actions use 12px radius (`rounded.lg`); secondary/utility buttons use pills (20px) or 8px.
- **Primary:** Oxblood (`#7A1028`) fill, cream (`#F2EAE0`) text, full-width 14px padding, DM Sans 500. (`.submit-btn`, `.save-btn`, `.voucher-apply-btn`)
- **Hover / Active:** Background → Oxblood Deep (`#550A1A`); `:active` `transform: scale(0.99)`. Transition `background 0.15s, transform 0.1s`.
- **Ghost / Add:** Dashed clay border on raised surface, rose-muted text; hover shifts border + text to oxblood with an oxblood-tint wash. (`.add-btn`)
- **Pill (toggle/lang/account):** 20px pill, clay border, raised fill; `.active` becomes oxblood fill + cream text. (`.lang-btn`, `.cust-account-btn`)

### Chips (status)
- **Style:** Pill (20px), 3px×10px padding, no border at rest. Background + text drawn from the six-state semantic set (e.g. Pending green `#C3E6CB`/`#155724`).
- **State:** As a *filter* control (`.user-status-opt.active`), the chip gains a matching-colour border to read as selected.

### Cards / Containers
- **Corner Style:** 14–16px (`rounded.xl`) for panels; form wraps cap at 600/900/1100px by context.
- **Background:** Surface Raised (`#FBF6F0`) stepped above the cream body.
- **Shadow Strategy:** None at rest — see Elevation's Flat-Rest Rule. Depth is the surface step + border.
- **Border:** 1.5px clay (`#C9A090`); admin panels use rose (`#C9A0A8`).
- **Internal Padding:** `lg` (1.25rem) typical; `xl` for primary content columns.

### Inputs / Fields
- **Style:** 1.5px clay border, cream (`#F2EAE0`) fill, 10px radius, DM Sans 13px, ink text.
- **Focus:** Border → oxblood, plus the oxblood-tint focus ring (`0 0 0 2px rgba(122,16,40,0.1)`). No native outline.
- **Tracking inputs:** AWB fields swap to the gold border/ring set — the only place gold touches a control.

### Navigation (merchant/admin sidebar)
- **Style:** Sunken taupe rail (`#EDE4D8`), 20px outer radius, sticky full-height. Lora wordmark + role label at top.
- **Items:** DM Sans 500 13px, ink-soft. Hover → oxblood text on a darker taupe with a `→` that slides 4px and a 3px oxblood left-edge marker scaling in. Active → oxblood-tint fill, oxblood text, marker held.

### Signature: Order Number
The mono order number (`PREFIX-YYYYMMDD-XXXX`, DM Mono 700, +1px) is the brand's receipt stamp — the one place monospace appears in customer-facing UI, signalling "this is your real, trackable order."

## 6. Do's and Don'ts

### Do:
- **Do** keep oxblood (`#7A1028`) as the single brand voice; hover to `#550A1A`, never a second resting accent (The One Voice Rule).
- **Do** build depth from the warm surface ladder (sunken `#EDE4D8` → cream `#F2EAE0` → raised `#FBF6F0` → high `#FFFDF9`) plus 1.5px clay borders. Step the colour, don't add a shadow (The Flat-Rest Rule).
- **Do** set names and headings in Lora, everything else in DM Sans (The Serif-Signage Rule).
- **Do** keep body copy on `ink` (`#2B0A10`) or `rose-muted` (`#7A4F55`), and tertiary text on `text-tertiary` (`#8A5550`) — all clear AA on cream. `clay-muted` (`#A07070`) is borders/icons only.
- **Do** carry the warm palette into merchant and admin screens — an order table is still hospitable.
- **Do** hold every layout at both EN and 中文 string lengths; provide a `prefers-reduced-motion` fallback for the nav slide and any entrance.

### Don't:
- **Don't** build a **generic SaaS dashboard**: no cold blue/grey panels, no hero-metric template (big number + small label + gradient), no endless identical icon-heading-text card grids.
- **Don't** drift toward **corporate fintech**: no navy-and-gold, no sterile institutional polish, nothing that reads transactional or cold.
- **Don't** reach for a cool grey neutral (`#EEE`, `#F5F5F5`, slate). Every neutral lives on the cream→taupe ladder (The Warm-Floor Rule).
- **Don't** set any text in `clay-muted` (`#A07070`) or `clay-border` (`#C9A090`) — they fail AA on cream (3.49 / 1.98:1); they are stroke/icon colours. Tertiary text goes on `text-tertiary` (`#8A5550`).
- **Don't** use gold (`#C9A030`) anywhere but shipment/tracking, or let serif set body copy, table data, or form labels.
- **Don't** add gradient text, decorative glassmorphism, or a near-white cream standing in for committed colour — the warmth is the oxblood and the type, not a washed-out background.
