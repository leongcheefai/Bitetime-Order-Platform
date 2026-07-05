-- Delivery address is now a structured object { line1, postcode, city, state }.
-- Convert the existing free-text column to jsonb. Existing text rows become
-- JSON string scalars (still valid jsonb) so the display formatter's string
-- branch keeps rendering them.
alter table orders
  alter column address type jsonb
  using case when address is null then null else to_jsonb(address) end;
