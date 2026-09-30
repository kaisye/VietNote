-- VietNote credit ledger. Credit is counted in seconds of Soniox streaming.
-- Every balance change goes through a SECURITY DEFINER function that locks the
-- profile row, so concurrent streams can never overdraw or double-refund.

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  balance_seconds integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.soniox_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  source text not null,
  reserved_seconds integer not null check (reserved_seconds > 0),
  -- Server-measured time until the client released the key (provisional charge).
  provisional_seconds integer,
  -- Audio duration reported by Soniox usage logs (final charge).
  final_seconds integer,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  reconciled_at timestamptz
);
create index soniox_grants_open on public.soniox_grants (created_at) where reconciled_at is null;

create table public.credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  delta_seconds integer not null,
  reason text not null check (reason in ('signup_bonus', 'reserve', 'release', 'reconcile', 'purchase', 'admin')),
  grant_id uuid references public.soniox_grants on delete set null,
  note text,
  created_at timestamptz not null default now()
);
create index credit_ledger_user on public.credit_ledger (user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.soniox_grants enable row level security;
alter table public.credit_ledger enable row level security;
create policy "read own profile" on public.profiles for select using (auth.uid() = id);
create policy "read own grants" on public.soniox_grants for select using (auth.uid() = user_id);
create policy "read own ledger" on public.credit_ledger for select using (auth.uid() = user_id);

-- Free minutes for every new account (one-time, not monthly).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare bonus constant integer := 3600;
begin
  insert into public.profiles (id, email, balance_seconds) values (new.id, new.email, bonus);
  insert into public.credit_ledger (user_id, delta_seconds, reason) values (new.id, bonus, 'signup_bonus');
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Reserve up to p_max seconds for one Soniox stream. Fails with
-- 'insufficient_credit' when fewer than p_min seconds remain.
create or replace function public.reserve_soniox_grant(p_user uuid, p_source text, p_max integer, p_min integer)
returns table (grant_id uuid, reserved_seconds integer, balance_seconds integer)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  balance integer;
  amount integer;
  new_grant uuid;
begin
  select p.balance_seconds into balance from profiles p where p.id = p_user for update;
  if balance is null or balance < p_min then
    raise exception 'insufficient_credit';
  end if;
  amount := least(balance, p_max);
  update profiles set balance_seconds = balance - amount where id = p_user;
  insert into soniox_grants (user_id, source, reserved_seconds) values (p_user, p_source, amount)
    returning id into new_grant;
  insert into credit_ledger (user_id, delta_seconds, reason, grant_id) values (p_user, -amount, 'reserve', new_grant);
  return query select new_grant, amount, balance - amount;
end $$;

-- Undo a reservation whose temporary key could not be created.
create or replace function public.cancel_soniox_grant(p_grant uuid)
returns void language plpgsql security definer set search_path = public as $$
declare g soniox_grants;
begin
  select * into g from soniox_grants where id = p_grant and reconciled_at is null for update;
  if not found then return; end if;
  update profiles set balance_seconds = balance_seconds + g.reserved_seconds where id = g.user_id;
  insert into credit_ledger (user_id, delta_seconds, reason, grant_id, note)
    values (g.user_id, g.reserved_seconds, 'release', g.id, 'key not issued');
  update soniox_grants set provisional_seconds = 0, final_seconds = 0,
    released_at = now(), reconciled_at = now() where id = g.id;
end $$;

-- The client closed its stream: refund the unused part, measured by the server
-- clock. Soniox usage logs later correct this in reconcile_soniox_grant.
create or replace function public.release_soniox_grant(p_user uuid, p_grant uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  g soniox_grants;
  used integer;
begin
  select * into g from soniox_grants
    where id = p_grant and user_id = p_user and released_at is null for update;
  if not found then return null; end if;
  used := least(g.reserved_seconds, ceil(extract(epoch from now() - g.created_at))::integer);
  update profiles set balance_seconds = balance_seconds + (g.reserved_seconds - used) where id = p_user;
  if used < g.reserved_seconds then
    insert into credit_ledger (user_id, delta_seconds, reason, grant_id)
      values (p_user, g.reserved_seconds - used, 'release', g.id);
  end if;
  update soniox_grants set provisional_seconds = used, released_at = now() where id = g.id;
  return used;
end $$;

-- Settle a grant at its final cost. The difference against what was already
-- charged may be positive (refund) or negative (a client released early while
-- still streaming); a negative balance blocks new reservations.
create or replace function public.reconcile_soniox_grant(p_grant uuid, p_actual integer)
returns void language plpgsql security definer set search_path = public as $$
declare
  g soniox_grants;
  charged integer;
  actual integer;
begin
  select * into g from soniox_grants where id = p_grant and reconciled_at is null for update;
  if not found then return; end if;
  charged := coalesce(g.provisional_seconds, g.reserved_seconds);
  actual := greatest(0, least(g.reserved_seconds, p_actual));
  if charged <> actual then
    update profiles set balance_seconds = balance_seconds + (charged - actual) where id = g.user_id;
    insert into credit_ledger (user_id, delta_seconds, reason, grant_id)
      values (g.user_id, charged - actual, 'reconcile', g.id);
  end if;
  update soniox_grants set final_seconds = actual, released_at = coalesce(released_at, now()),
    reconciled_at = now() where id = g.id;
end $$;

-- Admin / payment webhook top-up.
create or replace function public.add_credit(p_user uuid, p_seconds integer, p_reason text, p_note text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare balance integer;
begin
  update profiles set balance_seconds = balance_seconds + p_seconds where id = p_user
    returning balance_seconds into balance;
  if not found then raise exception 'unknown_user'; end if;
  insert into credit_ledger (user_id, delta_seconds, reason, note) values (p_user, p_seconds, p_reason, p_note);
  return balance;
end $$;

-- Only the Edge Functions (service role) may move credit.
revoke all on function public.reserve_soniox_grant(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.cancel_soniox_grant(uuid) from public, anon, authenticated;
revoke all on function public.release_soniox_grant(uuid, uuid) from public, anon, authenticated;
revoke all on function public.reconcile_soniox_grant(uuid, integer) from public, anon, authenticated;
revoke all on function public.add_credit(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.reserve_soniox_grant(uuid, text, integer, integer) to service_role;
grant execute on function public.cancel_soniox_grant(uuid) to service_role;
grant execute on function public.release_soniox_grant(uuid, uuid) to service_role;
grant execute on function public.reconcile_soniox_grant(uuid, integer) to service_role;
grant execute on function public.add_credit(uuid, integer, text, text) to service_role;
