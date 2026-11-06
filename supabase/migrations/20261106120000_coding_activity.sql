create table if not exists public.coding_sessions (
  user_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  active_seconds integer not null default 0 check (active_seconds >= 0),
  project text not null default '',
  languages text[] not null default '{}',
  event_count integer not null default 1 check (event_count > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  check (ended_at >= started_at)
);

create index if not exists coding_sessions_user_started_at_idx
  on public.coding_sessions (user_id, started_at desc);

create table if not exists public.coding_session_days (
  user_id uuid not null,
  session_id uuid not null,
  activity_date date not null,
  active_seconds integer not null default 0 check (active_seconds >= 0),
  primary key (user_id, session_id, activity_date),
  foreign key (user_id, session_id)
    references public.coding_sessions (user_id, id) on delete cascade
);

create index if not exists coding_session_days_user_date_idx
  on public.coding_session_days (user_id, activity_date);

alter table public.coding_sessions enable row level security;
alter table public.coding_session_days enable row level security;

drop policy if exists "Users manage their own coding sessions" on public.coding_sessions;
create policy "Users manage their own coding sessions"
  on public.coding_sessions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users manage their own coding session days" on public.coding_session_days;
create policy "Users manage their own coding session days"
  on public.coding_session_days
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace view public.coding_activity_daily
with (security_invoker = true)
as
select
  user_id,
  activity_date,
  sum(active_seconds)::bigint as active_seconds,
  count(*)::bigint as session_count
from public.coding_session_days
group by user_id, activity_date;

comment on table public.coding_sessions is
  'Coding sessions produced by the activity ingestion backend; ended_at is the last observed activity time.';
comment on table public.coding_session_days is
  'Per-local-calendar-day active time for each session, allowing accurate period summaries.';
comment on view public.coding_activity_daily is
  'Daily active time and session counts; group activity_date into week, month, or year in the client.';
