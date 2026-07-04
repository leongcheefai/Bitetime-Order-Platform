-- Per-merchant pickup address, shown to customers who choose the pickup fulfilment mode.
-- Plain text (may be multi-line); empty/null means "no address set" and the storefront shows nothing.
alter table merchants add column if not exists pickup_address text;
