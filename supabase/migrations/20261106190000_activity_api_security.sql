drop policy if exists "Users manage their own coding sessions" on public.coding_sessions;
drop policy if exists "Users manage their own coding session days" on public.coding_session_days;

create policy "Users read their own coding sessions"
  on public.coding_sessions
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users read their own coding session days"
  on public.coding_session_days
  for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.coding_sessions, public.coding_session_days from anon, authenticated;
revoke all on public.coding_activity_daily from anon, authenticated;

create index if not exists coding_sessions_user_ended_at_idx
  on public.coding_sessions (user_id, ended_at desc, started_at desc);

create index if not exists coding_session_days_user_date_session_idx
  on public.coding_session_days (user_id, activity_date, session_id);

create or replace function public.upsert_coding_session(p_user_id uuid, p_session jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  daily_entry record;
  session_id uuid := (p_session ->> 'id')::uuid;
begin
  insert into public.coding_sessions (
    user_id,
    id,
    started_at,
    ended_at,
    active_seconds,
    project,
    languages,
    event_count,
    updated_at
  )
  values (
    p_user_id,
    session_id,
    (p_session ->> 'started_at')::timestamptz,
    (p_session ->> 'ended_at')::timestamptz,
    (p_session ->> 'active_seconds')::integer,
    coalesce(p_session ->> 'project', ''),
    coalesce(array(select jsonb_array_elements_text(p_session -> 'languages')), '{}'),
    (p_session ->> 'event_count')::integer,
    now()
  )
  on conflict (user_id, id) do update
  set
    started_at = least(public.coding_sessions.started_at, excluded.started_at),
    ended_at = greatest(public.coding_sessions.ended_at, excluded.ended_at),
    active_seconds = greatest(public.coding_sessions.active_seconds, excluded.active_seconds),
    project = excluded.project,
    languages = array(
      select distinct language
      from unnest(public.coding_sessions.languages || excluded.languages) as merged(language)
    ),
    event_count = greatest(public.coding_sessions.event_count, excluded.event_count),
    updated_at = now();

  for daily_entry in
    select key, value
    from jsonb_each(coalesce(p_session -> 'daily_active_seconds', '{}'::jsonb))
  loop
    insert into public.coding_session_days (user_id, session_id, activity_date, active_seconds)
    values (p_user_id, session_id, daily_entry.key::date, (daily_entry.value #>> '{}')::integer)
    on conflict (user_id, session_id, activity_date) do update
    set active_seconds = greatest(public.coding_session_days.active_seconds, excluded.active_seconds);
  end loop;
end;
$$;

revoke all on function public.upsert_coding_session(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_coding_session(uuid, jsonb) to service_role;

create or replace function public.upsert_coding_sessions(p_user_id uuid, p_sessions jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_value jsonb;
begin
  if jsonb_typeof(p_sessions) <> 'array' or jsonb_array_length(p_sessions) > 50 then
    raise exception 'p_sessions must be an array of at most 50 sessions';
  end if;

  for session_value in select value from jsonb_array_elements(p_sessions)
  loop
    perform public.upsert_coding_session(p_user_id, session_value);
  end loop;
end;
$$;

revoke all on function public.upsert_coding_sessions(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_coding_sessions(uuid, jsonb) to service_role;

create or replace function public.count_coding_sessions(p_user_id uuid, p_from date, p_to date)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select count(distinct session_id)
  from public.coding_session_days
  where user_id = p_user_id
    and activity_date between p_from and p_to;
$$;

revoke all on function public.count_coding_sessions(uuid, date, date) from public, anon, authenticated;
grant execute on function public.count_coding_sessions(uuid, date, date) to service_role;
