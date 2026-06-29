-- Record a voucher redemption on behalf of a (possibly anonymous) customer.
-- Customers can SELECT vouchers (vouchers_select_public) to validate a code at
-- checkout, but cannot write the table (vouchers_write_own is merchant-scoped).
-- This security-definer RPC appends the redeemer to used_by and enforces the
-- max_uses cap and one-per-customer rule server-side.
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
  select * into v_row
    from public.vouchers
    where merchant_id = p_merchant and code = p_code
    for update;
  if not found then raise exception 'voucher not found'; end if;

  -- Already redeemed by this customer: idempotent no-op.
  if v_row.used_by ? v_entry then return; end if;

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
