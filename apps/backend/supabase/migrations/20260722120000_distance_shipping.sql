-- Distance-based delivery fees (#101, spec #100). See CONTEXT.md -> "Shipping policy" and
-- docs/adr/0001-distance-fees-from-a-cached-google-route.md.
--
-- Real, typed columns rather than keys in the `shipping` jsonb: a CHECK constraint is what
-- stops a half-configured distance shop from ever pricing an order, and jsonb cannot have one.
-- Same argument as merchants.tax_enabled/tax_rate (20260720140000).
--
-- Every default keeps an existing shop EXACTLY where it is: shipping_mode 'region'.

alter table merchants
  add column shipping_mode        text          not null default 'region',
  add column delivery_base_fee    numeric(10,2) not null default 0,
  add column delivery_rate_per_km numeric(10,2) not null default 0,
  -- null = no limit. NOT "0 = no limit": 0 would be an honest "deliver nowhere" and the two
  -- must not collide.
  add column delivery_max_km      numeric(6,1),
  add column origin_place_id      text,
  add column origin_lat           numeric(9,6),
  add column origin_lng           numeric(9,6),
  add column origin_address       text;

alter table merchants
  add constraint merchants_shipping_mode_valid
    check (shipping_mode in ('region', 'distance')),
  add constraint merchants_delivery_base_fee_nonneg
    check (delivery_base_fee >= 0),
  add constraint merchants_delivery_rate_nonneg
    check (delivery_rate_per_km >= 0),
  add constraint merchants_delivery_max_km_positive
    check (delivery_max_km is null or delivery_max_km > 0),
  -- The validation that makes "you cannot half-configure your way into quoting nothing" a
  -- database fact rather than a UI courtesy: distance mode REQUIRES an origin to route from.
  add constraint merchants_distance_requires_origin
    check (shipping_mode <> 'distance' or origin_place_id is not null);

comment on column merchants.shipping_mode is
  'Which shipping policy is live: region (flat WM/EM rates) or distance (base + rate x km). The other policy''s configuration stays stored but dormant.';
comment on column merchants.delivery_max_km is
  'Routed km beyond which this shop does not deliver. NULL = no limit.';
comment on column merchants.origin_place_id is
  'The delivery origin''s Google place id — the routing origin AND the distance cache key. A merchant who moves changes this and so invalidates their own cached distances.';

-- The order snapshot. `delivery_distance_km` LABELS the receipt line, the same reason
-- orders.tax_rate is stored rather than derived. base/rate are stored because
-- `base + rate x km` has two unknowns and one equation: without them no past order's fee is
-- reconstructable once the merchant edits their rates.
--
-- All three are NULL on a region-priced shop's orders, and NULL on every order placed before
-- this shipped. Readers must treat NULL as "no distance line", never as 0 km.
alter table orders
  add column delivery_distance_km numeric(6,1),
  add column delivery_base_fee    numeric(10,2),
  add column delivery_rate_per_km numeric(10,2);

comment on column orders.delivery_distance_km is
  'Routed km this order was charged for. NULL for region-priced orders.';

-- The distance cache: one row per (origin, destination) place-id pair.
--
-- Rows expire after 30 days. That TTL is GOOGLE'S TERMS, not a tuning knob — do not raise it.
-- Expiry is enforced by the reader (`created_at >= now() - interval '30 days'`), not by a sweep:
-- a stale row is simply a miss, and re-resolving overwrites it.
create table distance_quotes (
  origin_place_id      text        not null,
  destination_place_id text        not null,
  metres               integer     not null check (metres >= 0),
  created_at           timestamptz not null default now(),
  primary key (origin_place_id, destination_place_id)
);

-- Backend-only, like every other table since 20260718130000. db.ts connects as the database
-- owner and is RLS-exempt; RLS-with-no-policies plus zero browser grants is the backstop.
alter table distance_quotes enable row level security;
revoke all on public.distance_quotes from anon, authenticated;

-- The application path (`src/db.ts`) connects as the database owner and needs no grant. This
-- one is for the service-role REST client: the DB-backed suites seed and clear cache rows
-- through it, and a table created after 20260718130000 inherits no DML grants at all. Same
-- reason 20260720120000_merchant_feedback.sql carries an explicit grant.
grant select, insert, update, delete on table public.distance_quotes to service_role;

comment on table distance_quotes is
  'Cached (origin, destination) -> metres routes. Written by the quote endpoint, read by order intake, so the quote and the charge are the same number without asking Google twice. 30-day TTL is contractual.';
