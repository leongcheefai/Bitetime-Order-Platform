-- ============================================================================
-- Seed a handful of sample orders on the LOCAL Supabase dev DB.
--
-- Attaches to the merchant with slug :'slug' (psql variable, default set below).
-- If that merchant does not exist yet, a demo shop is created (status 'active')
-- so the seed works on a fresh database.
--
-- Orders are guest orders (user_id null) with self-contained item snapshots, so
-- no auth.users rows are required. Idempotent: order_number is unique per
-- merchant, and every insert is ON CONFLICT DO NOTHING — re-running is a no-op.
--
-- Run via scripts/seed-sample-orders.sh (wraps this in the docker psql).
-- ============================================================================

-- Default the slug when the caller did not pass -v slug=...
\if :{?slug}
\else
  \set slug 'demo-bakery'
\endif

-- Stash the slug in a GUC: psql does NOT interpolate :'slug' inside the $$ body,
-- so hand it in via set_config and read it with current_setting below.
select set_config('seed.slug', :'slug', false);

do $$
declare
  v_slug   text := current_setting('seed.slug');
  v_mid    uuid;
  v_prefix text;
  v_day    text := to_char(now(), 'YYMMDD');
begin
  -- Resolve (or create) the target merchant.
  select id, order_prefix into v_mid, v_prefix
    from public.merchants where slug = v_slug;

  if v_mid is null then
    insert into public.merchants (name, slug, order_prefix, status)
      values ('Demo Bakery', v_slug, 'DE', 'active')
      returning id, order_prefix into v_mid, v_prefix;
    raise notice 'Created demo merchant % (slug %).', v_mid, v_slug;
  end if;

  -- Sample orders: varied modes, regions, statuses. Fixed daily counter suffixes
  -- so order_number is deterministic and the whole seed is idempotent.
  insert into public.orders
    (merchant_id, created_at, user_id, customer_name, customer_wa, preferred_date,
     mode, address, region, shipping_fee, items, total, order_number, status, note)
  values
    (v_mid, now() - interval '3 days', null, 'Aisyah Rahman', '60123456789',
     current_date + 2, 'delivery', '12 Jalan Ampang, 50450 Kuala Lumpur', 'WM', 8,
     '[{"id":"chewy","name":"Soft & chewy cookies","qty":3,"price":12},
       {"id":"box","name":"Cookie box / gift set","qty":1,"price":45}]'::jsonb,
     89, v_prefix || '-' || v_day || '-0050', 'new', null),

    (v_mid, now() - interval '2 days', null, 'Tan Wei Ming', '60169876543',
     current_date + 1, 'delivery', '88 Jalan Gaya, 88000 Kota Kinabalu', 'EM', 18,
     '[{"id":"crinkle","name":"Crinkle cookies","qty":2,"price":12}]'::jsonb,
     42, v_prefix || '-' || v_day || '-0051', 'preparing', 'No nuts please'),

    (v_mid, now() - interval '2 days', null, 'Nurul Izzah', '60112223344',
     current_date + 3, 'pickup', null, null, 0,
     '[{"id":"lava","name":"Stuffed / lava cookies","qty":4,"price":15}]'::jsonb,
     60, v_prefix || '-' || v_day || '-0052', 'ready', null),

    (v_mid, now() - interval '1 day', null, 'Kavitha Nair', '60187654321',
     current_date + 1, 'delivery', '5 Lorong Kenari, 11900 Bayan Lepas, Penang', 'WM', 8,
     '[{"id":"chewy","name":"Soft & chewy cookies","qty":1,"price":12},
       {"id":"crinkle","name":"Crinkle cookies","qty":1,"price":12},
       {"id":"lava","name":"Stuffed / lava cookies","qty":1,"price":15}]'::jsonb,
     47, v_prefix || '-' || v_day || '-0053', 'ready', 'AWB SPX123456789'),

    (v_mid, now() - interval '1 day', null, 'Daniel Lim', '60134567890',
     current_date, 'pickup', null, null, 0,
     '[{"id":"box","name":"Cookie box / gift set","qty":2,"price":45}]'::jsonb,
     90, v_prefix || '-' || v_day || '-0054', 'completed', null),

    (v_mid, now() - interval '6 hours', null, 'Siti Aminah', '60198765432',
     current_date + 2, 'delivery', '3 Jalan Tun Razak, 50400 Kuala Lumpur', 'WM', 8,
     '[{"id":"crinkle","name":"Crinkle cookies","qty":5,"price":12}]'::jsonb,
     68, v_prefix || '-' || v_day || '-0055', 'cancelled', 'Customer changed mind')
  on conflict (merchant_id, order_number) where order_number is not null
    do nothing;

  -- Keep the per-merchant daily counter ahead of the seeded suffixes so the next
  -- real order (via next_order_number) does not collide.
  insert into public.order_counters (merchant_id, day, value)
    values (v_mid, v_day, 55)
  on conflict (merchant_id) do update
    set day   = v_day,
        value = case when public.order_counters.day = v_day
                     then greatest(public.order_counters.value, 55)
                     else 55 end;

  raise notice 'Seeded sample orders for merchant % (prefix %).', v_slug, v_prefix;
end $$;
