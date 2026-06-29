-- The platform owner (email-based is_owner(), baseline) can update any merchant
-- — needed for the approval queue before real superadmin role seeding (P4).
drop policy if exists merchants_update_own_or_super on public.merchants;
create policy merchants_update_own_or_super on public.merchants
  for update
  using (owner_id = auth.uid() or public.is_superadmin() or public.is_owner())
  with check (owner_id = auth.uid() or public.is_superadmin() or public.is_owner());
