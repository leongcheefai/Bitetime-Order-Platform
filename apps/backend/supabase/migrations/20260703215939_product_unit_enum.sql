-- Convert products.unit from free text to a Postgres enum.
-- Values mirror the UNITS list in the product form (ProductsManager.tsx).

create type public.product_unit as enum (
  'pcs', 'box', 'set', 'pack', 'dozen', 'bottle', 'jar', 'tray', 'slice', 'kg', 'g'
);

-- Normalize legacy / unknown values before the type cast so it can't fail.
-- Legacy 'pc' → 'pcs'; anything else (incl. blank/NULL) falls back to 'pcs'.
update public.products set unit = case
  when unit = 'pc' then 'pcs'
  when unit in ('pcs','box','set','pack','dozen','bottle','jar','tray','slice','kg','g') then unit
  else 'pcs'
end;

alter table public.products
  alter column unit type public.product_unit using unit::public.product_unit,
  alter column unit set default 'pcs',
  alter column unit set not null;

-- Enum types are usable by PUBLIC by default; grant explicitly to be safe.
grant usage on type public.product_unit to anon, authenticated, service_role;

-- Refresh PostgREST's schema cache so the new column type is picked up.
notify pgrst, 'reload schema';
