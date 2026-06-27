# Product

## Register

product

## Users

Three roles share one platform, each in a different context:

- **Customers** — people ordering food from a specific local shop at `/s/:slug`. Mostly on mobile, often mid-task (picking items, a delivery date, a voucher, checking out fast). Bilingual audience: every string ships EN + ZH. Malaysia-focused (postcode → city lookup, WM/EM shipping). They want to order without friction and trust the shop.
- **Merchants** — independent shop owners running their storefront from the `/merchant` dashboard: products, orders, vouchers, customers, settings, Telegram/email notifications. They are not power users; the dashboard must be legible and forgiving on a phone or a laptop between serving customers.
- **Platform super-admin** — approves, suspends, and manages merchants at `/admin`. Low-frequency, high-trust operational screens.

## Product Purpose

BiteTime is a multi-merchant food-ordering SaaS. Many independent shops each run their own storefront, products, orders, vouchers, and customers on one platform — fully isolated per tenant by Postgres RLS. A shop signs up with a name, gets an auto-generated slug, and goes live once a super-admin approves it.

Success = a customer completes an order without confusion, a merchant runs their shop without needing support, and the platform onboards new shops cleanly. The design's job is to make a small local shop feel credible and cared-for on the web, and to make daily operations effortless.

## Brand Personality

Warm and artisanal. Homely, crafted, hospitable — the feel of a trusted local bakery or café, not a tech platform. Three words: **warm, crafted, trustworthy.**

Voice: plain, friendly, human. Bilingual and equal in both languages — ZH is a first-class citizen, never an afterthought. The interface should evoke care and hospitality (the warmth of being served by someone who knows you), and quiet confidence on the operational side. Never cold, never shouty.

This warmth lives in the existing identity — oxblood/wine `#7A1028`, warm cream surfaces, Lora serif for display paired with DM Sans for body, soft pill radii. Carry warmth through type, accent, and copy, not through louder backgrounds.

## Anti-references

- **Generic SaaS dashboard.** No cold blue/gray admin panels, hero-metric templates, or endless identical icon-heading-text card grids. The operational screens stay warm and on-brand, not default-product-grey.
- **Corporate fintech.** No navy-and-gold, no sterile institutional polish, nothing that reads transactional or cold. This is food and hospitality, not banking.

Also avoid by extension: the AI-default warm-near-white-cream body as a *substitute* for committed color (the brand already owns its warmth deliberately), gradient text, and decorative glassmorphism.

## Design Principles

1. **Warmth is the product.** Every surface — even an admin table — should feel hospitable. When a choice is between "efficient and cold" and "efficient and warm", pick warm. The palette and serif carry an identity; protect it.
2. **The shop is the hero, the platform is invisible.** A customer at `/s/:slug` should feel they're at *that shop*, not on a SaaS. Reserved platform chrome stays quiet.
3. **Bilingual parity.** EN and ZH are equals. Layouts must hold at both string lengths; nothing breaks or looks bolted-on in either language.
4. **Forgiving over clever.** Merchants and customers are not power users. Clear labels, obvious affordances, recoverable mistakes beat density or novelty.
5. **Mobile-first, calm under the thumb.** Customers order on phones mid-task. Touch targets, legible contrast, and an unhurried flow matter more than desktop flourish.

## Accessibility & Inclusion

Target **WCAG 2.1 AA**.

- Body text ≥ 4.5:1, large text ≥ 3:1. Watch the warm palette: muted clay tones (`#A07070`, `#C9A090`) are decorative/border colors, not body text — keep body copy toward the ink end (`#2B0A10`, `#4A2530`).
- Full keyboard navigation; visible focus states (the existing `box-shadow: 0 0 0 2px rgba(122,16,40,0.1)` focus ring is the baseline).
- `prefers-reduced-motion` honored on every animation — crossfade or instant fallback.
- Complete EN/ZH parity; no string left untranslated.
- Touch targets sized for thumbs on the customer storefront.
