-- Rotate the platform owner email: bitetimeandco@gmail.com -> bitetime@praxor.dev.
-- is_owner() is the email-based owner gate used across RLS policies. Redefine it
-- to match the new owner account. Mirrors USER_EMAIL in SessionContext.tsx.
create or replace function public.is_owner()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'bitetime@praxor.dev';
$$;
