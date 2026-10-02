-- "Done" for a support thread. The superadmin closes the shop's forum topic in Telegram; the
-- webhook sees Telegram's forum_topic_closed service message and stamps this. Reopening the
-- topic, or the merchant writing again (the backend then reopens the topic itself), clears it.
-- Null = open. See docs/superpowers/specs/2026-10-02-support-chat-design.md → Resolving a thread.
alter table public.support_threads
  add column if not exists resolved_at timestamptz;
