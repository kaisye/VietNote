-- Usage analytics: which feature each request served, what it cost, and daily
-- roll-ups for a dashboard. Only counts and durations are kept, never content.

-- The feature behind each AI request and each live speech stream. Rows written
-- before this migration keep 'unknown'.
alter table public.ai_usage
  add column if not exists feature text not null default 'unknown'
    check (feature ~ '^[a-z_]{1,32}$');
alter table public.soniox_grants
  add column if not exists feature text not null default 'unknown'
    check (feature ~ '^[a-z_]{1,32}$');
comment on column public.ai_usage.feature is 'App feature that made the request, e.g. summary, note_chat, watch_captions.';
comment on column public.soniox_grants.feature is 'App feature that opened the stream: live_translate or meeting_note.';

create index if not exists ai_usage_created on public.ai_usage (created_at);
create index if not exists soniox_grants_created on public.soniox_grants (created_at);
create index if not exists file_jobs_created on public.file_jobs (created_at);

-- Provider prices over time. A price change is a new row with a later
-- valid_from, so past days keep the price they were billed at.
--   speech_realtime / speech_async: USD per audio hour
--   vnd_per_usd: exchange rate used to compare cost with revenue
create table if not exists public.cost_rates (
  id bigint generated always as identity primary key,
  item text not null check (item in ('speech_realtime', 'speech_async', 'vnd_per_usd')),
  rate numeric(14, 6) not null check (rate > 0),
  valid_from date not null,
  note text,
  unique (item, valid_from)
);
alter table public.cost_rates enable row level security;
-- No policies: only the service role and the analytics role read it.

-- Starting values; check them against the latest invoices and add rows when they change.
insert into public.cost_rates (item, rate, valid_from, note) values
  ('speech_realtime', 0.12, '2026-01-01', 'Real-time recognition and translation, per audio hour'),
  ('speech_async', 0.10, '2026-01-01', 'File recognition, per audio hour'),
  ('vnd_per_usd', 26300, '2026-01-01', 'Approximate exchange rate')
on conflict (item, valid_from) do nothing;

create schema if not exists analytics;
revoke all on schema analytics from public, anon, authenticated;

-- The rate for `item` in force on `day`. Functions in a view run as the reader,
-- so this one runs as its owner to read cost_rates.
create or replace function analytics.rate_on(p_item text, p_day date)
returns numeric language sql stable security definer set search_path = public as $$
  select rate from public.cost_rates where item = p_item and valid_from <= p_day
  order by valid_from desc limit 1
$$;

-- Days are counted in Vietnam time.
create or replace view analytics.ai_daily as
select (u.created_at at time zone 'Asia/Ho_Chi_Minh')::date as day,
       u.feature,
       count(*) as requests,
       count(distinct u.user_id) as users,
       sum(u.prompt_tokens) as prompt_tokens,
       sum(u.completion_tokens) as completion_tokens,
       coalesce(sum(u.cost_usd), 0) as cost_usd
from public.ai_usage u
group by 1, 2;

-- Live streams: both sources run at once in a meeting and each is billed by the
-- provider, so every stream counts toward cost.
create or replace view analytics.speech_daily as
select g.day, g.feature, g.source,
       count(*) as streams,
       count(distinct g.user_id) as users,
       sum(g.seconds) as audio_seconds,
       round(sum(g.seconds) / 3600.0 * analytics.rate_on('speech_realtime', g.day), 6) as cost_usd
from (
  select (created_at at time zone 'Asia/Ho_Chi_Minh')::date as day, feature, source, user_id,
         coalesce(final_seconds, provisional_seconds, 0) as seconds
  from public.soniox_grants
) g
group by g.day, g.feature, g.source;

create or replace view analytics.file_daily as
select (j.created_at at time zone 'Asia/Ho_Chi_Minh')::date as day,
       case j.billing_source when 'watch' then 'watch_listen' else 'file_note' end as feature,
       count(*) filter (where j.status = 'completed') as jobs,
       count(*) filter (where j.status = 'failed') as failed_jobs,
       count(distinct j.user_id) as users,
       coalesce(sum(j.audio_seconds) filter (where j.status = 'completed'), 0) as audio_seconds,
       coalesce(sum(j.charged_seconds) filter (where j.status = 'completed'), 0) as charged_seconds,
       round(coalesce(sum(j.audio_seconds) filter (where j.status = 'completed'), 0) / 3600.0
         * analytics.rate_on('speech_async', (j.created_at at time zone 'Asia/Ho_Chi_Minh')::date), 6) as cost_usd
from public.file_jobs j
group by 1, 2, (j.created_at at time zone 'Asia/Ho_Chi_Minh')::date;

-- Videos watched with captions: no recognition cost (their translation shows up
-- in ai_daily as watch_captions), only charged time.
create or replace view analytics.watch_daily as
select (w.created_at at time zone 'Asia/Ho_Chi_Minh')::date as day,
       count(*) as sessions,
       count(distinct w.user_id) as users,
       count(distinct w.video_id) as videos,
       sum(w.charged_seconds) as charged_seconds
from public.watch_usage_sessions w
group by 1;

-- One row per day and feature, with the cost of every provider behind it.
-- `users` is the largest count among the feature's sources, so a lower bound; do
-- not add it across features (analytics.active_daily has the true total).
create or replace view analytics.feature_daily as
select day, feature, max(users) as users, sum(usage_seconds) as usage_seconds,
       sum(ai_requests) as ai_requests, sum(cost_usd) as cost_usd
from (
  select day, feature, users, 0::numeric as usage_seconds, requests as ai_requests, cost_usd from analytics.ai_daily
  union all
  select day, feature, users, audio_seconds, 0, cost_usd from analytics.speech_daily
  union all
  select day, feature, users, audio_seconds, 0, cost_usd from analytics.file_daily
  union all
  select day, 'watch_captions', users, charged_seconds, 0, 0 from analytics.watch_daily
) parts
group by day, feature;

create or replace view analytics.revenue_daily as
select (paid_at at time zone 'Asia/Ho_Chi_Minh')::date as day,
       count(*) as orders,
       count(distinct user_id) as buyers,
       sum(amount_vnd) as revenue_vnd,
       sum(seconds) as sold_seconds
from public.credit_orders
where status = 'paid'
group by 1;

-- Anyone who used anything that day.
create or replace view analytics.active_daily as
select day, count(distinct user_id) as active_users
from (
  select (created_at at time zone 'Asia/Ho_Chi_Minh')::date as day, user_id from public.ai_usage
  union all select (created_at at time zone 'Asia/Ho_Chi_Minh')::date, user_id from public.soniox_grants
  union all select (created_at at time zone 'Asia/Ho_Chi_Minh')::date, user_id from public.file_jobs
  union all select (created_at at time zone 'Asia/Ho_Chi_Minh')::date, user_id from public.watch_usage_sessions
) activity
group by day;

-- Cost against revenue per day, both in VND.
create or replace view analytics.margin_daily as
select d.day,
       coalesce(r.revenue_vnd, 0) as revenue_vnd,
       round(coalesce(c.cost_usd, 0) * analytics.rate_on('vnd_per_usd', d.day)) as cost_vnd,
       coalesce(r.revenue_vnd, 0) - round(coalesce(c.cost_usd, 0) * analytics.rate_on('vnd_per_usd', d.day)) as margin_vnd,
       coalesce(a.active_users, 0) as active_users
from (
  select day from analytics.feature_daily union select day from analytics.revenue_daily
) d
left join (select day, sum(cost_usd) as cost_usd from analytics.feature_daily group by day) c using (day)
left join analytics.revenue_daily r using (day)
left join analytics.active_daily a using (day);

-- Per person: what they bought, what they used and what it cost.
create or replace view analytics.user_economics as
select p.id as user_id,
       u.email,
       u.created_at as signed_up_at,
       p.balance_seconds,
       coalesce(o.revenue_vnd, 0) as revenue_vnd,
       coalesce(o.orders, 0) as orders,
       coalesce(-l.used_seconds, 0) as used_seconds,
       round(coalesce(ai.cost_usd, 0) + coalesce(sp.cost_usd, 0) + coalesce(fj.cost_usd, 0), 6) as cost_usd,
       greatest(ai.last_at, sp.last_at, fj.last_at) as last_active_at
from public.profiles p
join auth.users u on u.id = p.id
left join (select user_id, sum(amount_vnd) as revenue_vnd, count(*) as orders from public.credit_orders where status = 'paid' group by user_id) o on o.user_id = p.id
left join (select user_id, sum(delta_seconds) as used_seconds from public.credit_ledger where reason in ('reserve', 'release', 'reconcile', 'watch') group by user_id) l on l.user_id = p.id
left join (select user_id, sum(cost_usd) as cost_usd, max(created_at) as last_at from public.ai_usage group by user_id) ai on ai.user_id = p.id
left join (
  select user_id, sum(coalesce(final_seconds, provisional_seconds, 0) / 3600.0
    * analytics.rate_on('speech_realtime', (created_at at time zone 'Asia/Ho_Chi_Minh')::date)) as cost_usd, max(created_at) as last_at
  from public.soniox_grants group by user_id
) sp on sp.user_id = p.id
left join (
  select user_id, sum(coalesce(audio_seconds, 0) / 3600.0
    * analytics.rate_on('speech_async', (created_at at time zone 'Asia/Ho_Chi_Minh')::date)) as cost_usd, max(created_at) as last_at
  from public.file_jobs where status = 'completed' group by user_id
) fj on fj.user_id = p.id;

-- A read-only role for the dashboard. It logs in only after an admin gives it a
-- password in the SQL editor (never in a migration):
--   alter role analytics_reader with login password '…';
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'analytics_reader') then
    create role analytics_reader nologin;
  end if;
end $$;
grant usage on schema analytics to analytics_reader;
grant select on all tables in schema analytics to analytics_reader;
grant execute on all functions in schema analytics to analytics_reader;
alter default privileges in schema analytics grant select on tables to analytics_reader;
-- The views run with their owner's rights, so the role needs nothing in public or auth.
