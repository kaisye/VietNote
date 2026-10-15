-- Preserve the billing rule with each async transcription job. Recorded files
-- remain at 75%; audio processed by Watch Video is charged at 100% of duration.
alter table public.file_jobs
  add column if not exists billing_rate numeric not null default 0.75
    check (billing_rate > 0 and billing_rate <= 1),
  add column if not exists billing_source text not null default 'file'
    check (billing_source in ('file', 'watch'));

comment on column public.file_jobs.billing_rate is 'Credit seconds charged per processed audio second.';
comment on column public.file_jobs.billing_source is 'Feature that created the job: file or watch.';

-- Videos with captions do not create a file job. Charge their actual playback
-- time idempotently from a cumulative counter sent by the desktop app.
alter table public.credit_ledger drop constraint if exists credit_ledger_reason_check;
alter table public.credit_ledger add constraint credit_ledger_reason_check
  check (reason in ('signup_bonus', 'reserve', 'release', 'reconcile', 'purchase', 'admin', 'watch'));

create table if not exists public.watch_usage_sessions (
  id uuid primary key,
  user_id uuid not null references public.profiles on delete cascade,
  video_id text not null,
  charged_seconds integer not null default 0 check (charged_seconds >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists watch_usage_user on public.watch_usage_sessions (user_id, updated_at desc);
alter table public.watch_usage_sessions enable row level security;
drop policy if exists "read own watch usage" on public.watch_usage_sessions;
create policy "read own watch usage" on public.watch_usage_sessions for select using (auth.uid() = user_id);

create or replace function public.charge_watch_usage(p_user uuid, p_session uuid, p_video text, p_total integer)
returns table (charged_seconds integer, balance_seconds integer)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  usage public.watch_usage_sessions;
  balance integer;
  target integer := greatest(0, least(p_total, 12 * 60 * 60));
  delta integer;
begin
  insert into public.watch_usage_sessions (id, user_id, video_id)
    values (p_session, p_user, left(p_video, 64)) on conflict (id) do nothing;
  select * into usage from public.watch_usage_sessions where id = p_session for update;
  if usage.user_id <> p_user or usage.video_id <> left(p_video, 64) then raise exception 'invalid_watch_session'; end if;

  delta := greatest(0, target - usage.charged_seconds);
  select p.balance_seconds into balance from public.profiles p where p.id = p_user for update;
  if balance is null or balance < delta then raise exception 'insufficient_credit'; end if;
  if delta > 0 then
    update public.profiles set balance_seconds = balance_seconds - delta where id = p_user;
    update public.watch_usage_sessions set charged_seconds = target, updated_at = now() where id = p_session;
    insert into public.credit_ledger (user_id, delta_seconds, reason, note)
      values (p_user, -delta, 'watch', left(p_video, 64));
    balance := balance - delta;
  end if;
  return query select greatest(usage.charged_seconds, target), balance;
end $$;

revoke all on function public.charge_watch_usage(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.charge_watch_usage(uuid, uuid, text, integer) to service_role;
