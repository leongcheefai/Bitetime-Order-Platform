# 2. Fulfilment methods coexist; the fee rule belongs to the method

Date: 2026-07-22
Status: Accepted. Amends [ADR 0001](0001-distance-fees-from-a-cached-google-route.md).

## Context

ADR 0001 gave a shop one shipping policy, `merchants.shipping_mode`, either `region` or `distance`. The other policy's configuration stayed stored but dormant.

Issue #103 asked for something that arrangement cannot express: a merchant choosing which methods their customers may pick, from pickup, delivery and express delivery. A shop that posts parcels at a flat rate **and** runs a rider by the kilometre has two live prices, not a dormant one.

Neither did the exclusivity earn its keep. It was never a customer-facing fact — the storefront showed one Delivery button either way — so it bought no simplicity a customer could perceive, and it cost the one thing the merchant actually wanted to say.

## Decision

Three independent boolean columns replace `shipping_mode`, with a CHECK keeping at least one on. `delivery` is priced by region and `express` by distance, and **the fee rule follows the method the customer chose**, not a policy on the shop. `priceOrder` branches on `mode === 'express'` where it used to branch on the shop's policy.

`shipping_mode` is deleted rather than deprecated, by rewriting its own migration. It had never reached a remote project.

## Consequences

- One shop can quote two shipping rules in one session, so the storefront's address form branches on the selected method: express needs a confirmed place id, delivery needs a state.
- "Which policy is live" is no longer answerable about a shop, and no code should ask. `shopMethods` answers "does this shop offer X"; `shopDistance` answers "can express price".
- A shop offering nothing is refused at three layers — a disabled checkbox, a backend refusal that can say why, and the CHECK constraint that is the actual guarantee.
- Falling back from express to the region rate is now plainly wrong rather than merely undesirable: it would charge by a method the customer did not choose.
- The receipt line is named after the method (`Express delivery fee (25.2 km)`), reversing ADR 0001's "one house term for the charge". The principle survives — one order, one word for one charge — but the word is the method's own name.
