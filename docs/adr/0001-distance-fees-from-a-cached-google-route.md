# Distance delivery fees are priced from a cached Google route

Distance-based delivery fees (#100) need a road distance, which is I/O — but `priceOrder` is pure and runs on **both** sides of the wire, where any disagreement between the browser's quote and the backend's charge is a hard `price_changed` refusal. So the distance enters pricing as a plain input, and the two sides get the same input from a **distance cache** keyed by `(origin place id, destination place id)`: the storefront's quote endpoint calls Google Routes and writes the row, order intake reads it. One Google call per address pair, no drift by construction, and repeat customers cost nothing.

## Considered options

**A signed quote token (HMAC, short TTL)** was the other stateless-and-drift-free answer, and it was rejected for buying less: a new signing surface, and a distance that is unauditable after the fact unless it is also written down — which is a table again.

**Calling Routes a second time at intake** was rejected outright. Traffic and route updates move the answer between quote and submit, so the customer meets a `price_changed` that retrying re-creates — the same permanent refusal loop the promo clock skew already produced once.

**Taking the distance from the request body** is the `total: 0` hole with extra steps.

**Straight-line distance from geocoded points** would have avoided the routing dependency and most of the cost, but a road route is what the rider drives; a great-circle figure understates it by roughly a third, and every merchant would set their per-km rate against a number that does not describe their delivery.

## Consequences

The platform takes a **dependency on Google Maps Platform and pays for it** — Routes plus Places Autocomplete on both the merchant's origin and the customer's destination. That is what makes distance pricing zero-setup for a merchant (the alternative, a per-merchant API key, is a Google Cloud project and a billing card before they can price a delivery, and most would never finish), and it is what makes the quote endpoint a public endpoint that spends money per call. Hence: the endpoint accepts a **place id, never free text**, the cache absorbs repeats, and the existing in-memory rate limit plus a per-merchant daily ceiling bound the rest.

The 30-day cache TTL is Google's, not ours — their terms cap how long this data may be retained.

Nothing changes for a shop on region pricing, which is every shop today and the default for every new one.
