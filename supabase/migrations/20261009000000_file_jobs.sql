-- Recorded files transcribed with Soniox's async API. A file second costs
-- FILE_RATE (75%) of a streaming second. Like streams, a job reserves credit up
-- front and is settled against the audio length Soniox reports.

create table public.file_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  filename text,
  reserved_seconds integer not null check (reserved_seconds > 0),
  -- Credit charged once Soniox reported the audio length (75% of it, rounded up).
  charged_seconds integer,
  audio_seconds integer,
  soniox_file_id text,
  transcription_id text,
  status text not null default 'reserved' check (status in ('reserved', 'processing', 'completed', 'failed', 'cancelled')),
  error text,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index file_jobs_user on public.file_jobs (user_id, created_at desc);
alter table public.file_jobs enable row level security;

alter table public.credit_ledger add column file_job_id uuid references public.file_jobs on delete set null;

-- Reserve credit for a job; p_need is what the estimated length will cost.
create or replace function public.reserve_file_job(p_user uuid, p_need integer, p_filename text)
returns table (job_id uuid, reserved_seconds integer, balance_seconds integer)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  balance integer;
  new_job uuid;
begin
  select p.balance_seconds into balance from profiles p where p.id = p_user for update;
  if balance is null or balance < p_need then
    raise exception 'insufficient_credit';
  end if;
  update profiles set balance_seconds = balance - p_need where id = p_user;
  insert into file_jobs (user_id, filename, reserved_seconds) values (p_user, p_filename, p_need)
    returning id into new_job;
  insert into credit_ledger (user_id, delta_seconds, reason, file_job_id, note)
    values (p_user, -p_need, 'reserve', new_job, 'file');
  return query select new_job, p_need, balance - p_need;
end $$;

-- Charge the job for the audio Soniox processed; refund (or take) the difference.
-- Idempotent: a settled job returns its charge again.
create or replace function public.settle_file_job(p_job uuid, p_audio_seconds integer, p_rate numeric)
returns integer language plpgsql security definer set search_path = public as $$
declare
  j file_jobs;
  charge integer;
begin
  select * into j from file_jobs where id = p_job for update;
  if not found then raise exception 'job_missing'; end if;
  if j.settled_at is not null then return j.charged_seconds; end if;
  perform 1 from profiles where id = j.user_id for update;
  charge := ceil(greatest(0, p_audio_seconds) * p_rate)::integer;
  if charge <> j.reserved_seconds then
    update profiles set balance_seconds = balance_seconds + (j.reserved_seconds - charge) where id = j.user_id;
    insert into credit_ledger (user_id, delta_seconds, reason, file_job_id, note)
      values (j.user_id, j.reserved_seconds - charge, 'reconcile', j.id, 'file');
  end if;
  update file_jobs set charged_seconds = charge, audio_seconds = p_audio_seconds, status = 'completed', settled_at = now()
    where id = j.id;
  return charge;
end $$;

-- A job that failed or was cancelled before Soniox finished is not charged.
create or replace function public.refund_file_job(p_job uuid, p_status text, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  j file_jobs;
begin
  select * into j from file_jobs where id = p_job for update;
  if not found or j.settled_at is not null then return; end if;
  perform 1 from profiles where id = j.user_id for update;
  update profiles set balance_seconds = balance_seconds + j.reserved_seconds where id = j.user_id;
  insert into credit_ledger (user_id, delta_seconds, reason, file_job_id, note)
    values (j.user_id, j.reserved_seconds, 'release', j.id, 'file');
  update file_jobs set charged_seconds = 0, status = p_status, error = p_error, settled_at = now() where id = j.id;
end $$;

revoke all on function public.reserve_file_job(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.settle_file_job(uuid, integer, numeric) from public, anon, authenticated;
revoke all on function public.refund_file_job(uuid, text, text) from public, anon, authenticated;
grant execute on function public.reserve_file_job(uuid, integer, text) to service_role;
grant execute on function public.settle_file_job(uuid, integer, numeric) to service_role;
grant execute on function public.refund_file_job(uuid, text, text) to service_role;
