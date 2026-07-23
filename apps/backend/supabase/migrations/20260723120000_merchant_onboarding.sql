-- Merchant onboarding checklist (#102).
--
-- Two of the three checklist steps have no honest derivable signal: every shop
-- ships with default fulfilment methods on (so "set pickup/delivery" cannot be
-- read off the config), and "shared the order link" is an action that persists no
-- state. Each therefore gets an explicit boolean flag the merchant's own action
-- flips. The third step (first product) is derived from the product count and
-- needs no column. `onboarding_dismissed` hides the card once the merchant clears
-- the celebration.
--
-- Real columns rather than keys in the `config` jsonb: they are plain booleans read
-- alongside the row the dashboard already loads, and match the `tax_enabled` pattern.

alter table merchants
  add column onboarding_shipping_set boolean not null default false,
  add column onboarding_link_shared  boolean not null default false,
  add column onboarding_dismissed    boolean not null default false;

-- Every EXISTING shop predates onboarding and must never be shown the checklist.
-- Shops created after this migration start with all three false and see it.
update merchants set onboarding_dismissed = true;

comment on column merchants.onboarding_shipping_set is 'Merchant saved the Shipping settings tab at least once (#102).';
comment on column merchants.onboarding_link_shared is 'Merchant copied/opened/QR-shared the storefront link at least once (#102).';
comment on column merchants.onboarding_dismissed is 'Merchant cleared the onboarding checklist; card never shows again (#102).';
