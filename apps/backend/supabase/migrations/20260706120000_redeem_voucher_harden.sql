-- Harden redeem_voucher for the one-per-customer rule.
--
-- Two prior defects let a customer redeem repeatedly while used_by stayed at 1:
--   * an empty/anonymous entry coalesced to '' so every anonymous redemption
--     collapsed onto a single '' key (a 50-cap voucher counted as 1);
--   * a re-redeem by an already-recorded entry returned a silent no-op, so the
--     caller got no signal and re-granted the discount.
-- Reject the empty entry, and raise on re-redeem so callers can block the dupe.
create or replace function public.redeem_voucher(p_merchant uuid, p_code text, p_entry text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.vouchers%rowtype;
  v_entry text := lower(coalesce(p_entry, ''));
begin
  -- An anonymous/empty entry cannot be tracked one-per-customer.
  if v_entry = '' then raise exception 'voucher entry required'; end if;

  select * into v_row
    from public.vouchers
    where merchant_id = p_merchant and code = p_code
    for update;
  if not found then raise exception 'voucher not found'; end if;

  -- One redemption per customer: re-redeem is an error, not a silent no-op.
  if v_row.used_by ? v_entry then raise exception 'voucher already used'; end if;

  -- max_uses null = unlimited total (still one per customer via the check above).
  if v_row.max_uses is not null
     and jsonb_array_length(v_row.used_by) >= v_row.max_uses then
    raise exception 'voucher fully used';
  end if;

  update public.vouchers
    set used_by = v_row.used_by || to_jsonb(v_entry)
    where id = v_row.id;
end;
$$;

grant execute on function public.redeem_voucher(uuid, text, text) to anon, authenticated;
