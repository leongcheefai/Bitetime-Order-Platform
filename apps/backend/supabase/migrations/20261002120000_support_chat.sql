-- Support chat between a merchant and the platform superadmin. See
-- docs/superpowers/specs/2026-10-02-support-chat-design.md.
--
-- The browser never touches these tables: every read and write goes through the backend's
-- service-role / owner connections, behind requireMerchantOwns. So RLS is enabled with NO
-- policies and the browser roles hold no grants — the withheld grant is what shuts the door,
-- and policy-less RLS is the belt for a grant reopened by accident.
-- tests/rls/support-chat-grant.test.ts is the proof.

create table if not exists public.support_threads (
  merchant_id            uuid primary key references public.merchants (id) on delete cascade,
  -- The forum topic in PLATFORM_SUPPORT_CHAT_ID. Null until the first message reaches Telegram,
  -- and cleared when Telegram reports the topic gone (deleted by hand).
  tg_topic_id            bigint unique,
  merchant_last_seen_at  timestamptz,
  merchant_last_read_at  timestamptz,
  last_away_email_at     timestamptz,
  created_at             timestamptz not null default now()
);

create table if not exists public.support_messages (
  id              uuid primary key default gen_random_uuid(),
  merchant_id     uuid not null references public.support_threads (merchant_id) on delete cascade,
  sender          text not null check (sender in ('merchant', 'admin')),
  author_user_id  uuid references auth.users (id) on delete set null,
  -- The database's copy of SUPPORT_MAX_LENGTH in @bitetime/shared. This CHECK is the authority.
  body            text not null check (char_length(btrim(body)) between 1 and 2000),
  -- Paths in the PRIVATE support-images bucket, never URLs.
  image_paths     text[] not null default '{}' check (cardinality(image_paths) <= 3),
  tg_message_id   bigint,
  created_at      timestamptz not null default now()
);

create index if not exists support_messages_thread_idx
  on public.support_messages (merchant_id, created_at, id);

-- A Telegram update can arrive twice (a retry after a slow or failed response). The reply's own
-- Telegram id makes the second insert a no-op. Partial: a merchant row's tg_message_id is the id
-- of the forwarded post, which nothing deduplicates on.
create unique index if not exists support_messages_admin_tg_message_id
  on public.support_messages (tg_message_id) where sender = 'admin';

alter table public.support_threads enable row level security;
alter table public.support_messages enable row level security;

revoke all on table public.support_threads from anon, authenticated;
revoke all on table public.support_messages from anon, authenticated;
grant select, insert, update on table public.support_threads to service_role;
grant select, insert, update on table public.support_messages to service_role;

-- PRIVATE: a merchant's screenshot is usually their own dashboard — customer names, phone
-- numbers, addresses. Same posture as feedback-images (20260806120000).
insert into storage.buckets (id, name, public)
values ('support-images', 'support-images', false)
on conflict (id) do nothing;

update storage.buckets
set
  file_size_limit = 5242880, -- 5 MiB — MAX_FEEDBACK_IMAGE_BYTES in @bitetime/shared
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'support-images';

-- Deliberately NO storage.objects policies: with public = false and zero policies, anon and
-- authenticated get nothing in either direction.
