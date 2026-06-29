create or replace function public.next_order_number(p_merchant uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text;
  v_today  text := to_char(now(), 'YYMMDD');
  v_value  int;
begin
  select order_prefix into v_prefix from public.merchants where id = p_merchant;
  if v_prefix is null then raise exception 'merchant not found'; end if;

  insert into public.order_counters (merchant_id, day, value)
    values (p_merchant, v_today, 50)
  on conflict (merchant_id) do update
    set day   = v_today,
        value = case when public.order_counters.day = v_today
                     then public.order_counters.value + 1
                     else 50 end
  returning value into v_value;

  return v_prefix || '-' || v_today || '-' || lpad(v_value::text, 4, '0');
end;
$$;

grant execute on function public.next_order_number(uuid) to anon, authenticated;
