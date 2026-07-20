-- Merchant feedback about the PLATFORM (#89) — not customer reviews of a shop.
--
-- Written by a shop owner through POST /api/merchants/:id/feedback and read/triaged by a
-- superadmin. Like merchant_billing and referral_rewards, the browser never touches this
-- table: it holds no grants (20260718130000_revoke_all_browser_grants.sql closed every
-- browser grant in this schema, and nothing here reopens one), so RLS is enabled with NO
-- policies. Postgres checks table privileges before RLS, so the withheld grant is what
-- actually shuts the door; policy-less RLS is the belt for anything that reopens a grant
-- by accident.
--
-- The message bounds are duplicated in @bitetime/shared (validateFeedback) so the browser
-- can show a counter and the server can refuse. This CHECK is the authority; the shared
-- rule exists so a merchant is told before they submit, not after.

create table if not exists public.merchant_feedback (
  id           uuid primary key default gen_random_uuid(),
  merchant_id  uuid not null references public.merchants (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  category     text not null check (category in ('bug', 'feature', 'billing', 'other')),
  message      text not null check (char_length(btrim(message)) between 1 and 2000),
  status       text not null default 'open' check (status in ('open', 'resolved')),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);

-- The admin list's only sort: newest-first, optionally filtered to open.
create index if not exists merchant_feedback_triage_idx
  on public.merchant_feedback (status, created_at desc);

create index if not exists merchant_feedback_merchant_idx
  on public.merchant_feedback (merchant_id);

alter table public.merchant_feedback enable row level security;

revoke all on table public.merchant_feedback from anon, authenticated;
grant select, insert, update on table public.merchant_feedback to service_role;
