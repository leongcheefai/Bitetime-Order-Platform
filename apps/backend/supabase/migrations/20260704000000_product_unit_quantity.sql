-- Add a per-product unit quantity (display-only): "100 g", "1 pcs", "1.5 kg".
-- numeric so decimals are allowed; default 1 backfills existing rows.
alter table public.products
  add column unit_quantity numeric not null default 1;

-- Refresh PostgREST's schema cache so the new column is visible immediately.
notify pgrst, 'reload schema';
