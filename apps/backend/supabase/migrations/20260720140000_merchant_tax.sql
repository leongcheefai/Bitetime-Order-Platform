-- Merchant-configurable tax (#88).
--
-- Real columns rather than a key in the `config` jsonb: the order transaction already does
-- `select order_prefix, status, shipping, currency, config, timezone from merchants`, so two
-- more columns cost nothing at read time and buy a CHECK constraint jsonb cannot have.
--
-- Defaults are OFF / 0: every existing shop is a tax-free shop and must stay one.

alter table merchants
  add column tax_enabled boolean not null default false,
  add column tax_rate    numeric(5,2) not null default 0;

alter table merchants
  add constraint merchants_tax_rate_range check (tax_rate >= 0 and tax_rate <= 100);

-- The rate is snapshotted onto the order alongside the amount, NOT derived at read time.
-- A shop moving 6% -> 8% next month must not repaint last month's receipts, and `tax` alone
-- cannot label itself "6%".
--
-- Readers gate the tax line on `tax_rate > 0`, never on `tax > 0`: an 8% shop's fully
-- discounted order has tax = 0 and must still print "Tax (8%) 0.00" rather than look untaxed.
alter table orders
  add column tax      numeric not null default 0,
  add column tax_rate numeric(5,2) not null default 0;

comment on column merchants.tax_rate is 'Percentage: 6 means 6%. Charged only when tax_enabled.';
comment on column orders.tax_rate is 'Percentage charged on THIS order. 0 = no tax was charged.';
