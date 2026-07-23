-- Onboarding spotlight tour (#102 follow-up).
--
-- A one-time guided tour auto-opens on a new merchant's first dashboard visit,
-- dimming the screen and spotlighting each checklist step in turn. This flag records
-- that the tour has been shown so it never auto-opens again (the merchant can still
-- replay it from the card). Separate from `onboarding_dismissed`, which hides the
-- whole checklist — the tour is seen once; the card lingers until the shop is set up.

alter table merchants
  add column onboarding_tour_seen boolean not null default false;

-- Every EXISTING shop predates the tour and must never have it auto-open. Shops
-- created after this migration start false and see it once.
update merchants set onboarding_tour_seen = true;

comment on column merchants.onboarding_tour_seen is 'Onboarding spotlight tour has auto-opened once; never auto-opens again (#102).';
