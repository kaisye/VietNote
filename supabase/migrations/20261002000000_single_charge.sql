-- A meeting recorded from the microphone and system audio at once is charged
-- once: microphone time that overlaps the user's system audio stream is free.
-- A new reservation also closes the same source's reservations left open by a
-- worker that was killed or crashed, so they stop counting down the balance.

-- Seconds of a microphone grant, up to p_until, that ran alongside a system grant.
-- An open system grant counts as running until now (at most its reserved length).
create or replace function public.system_overlap_seconds(p_grant uuid, p_until timestamptz)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(greatest(0, extract(epoch from
      least(p_until, coalesce(s.released_at, least(now(), s.created_at + make_interval(secs => s.reserved_seconds))))
      - greatest(m.created_at, s.created_at)))), 0)::integer
  from soniox_grants m
  join soniox_grants s on s.user_id = m.user_id and s.source = 'system' and s.id <> m.id
  where m.id = p_grant and m.source = 'microphone'
$$;

-- What the user can spend now: balance plus the unused part of open reservations.
create or replace function public.available_seconds(p_user uuid)
returns integer language sql stable security definer set search_path = public as $$
  select p.balance_seconds + coalesce((
    select sum(greatest(0, g.reserved_seconds - greatest(0,
      ceil(extract(epoch from now() - g.created_at))::integer - system_overlap_seconds(g.id, now()))))
    from soniox_grants g where g.user_id = p_user and g.released_at is null), 0)::integer
  from profiles p where p.id = p_user
$$;

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
  used := greatest(0, used - system_overlap_seconds(g.id, now()));
  update profiles set balance_seconds = balance_seconds + (g.reserved_seconds - used) where id = p_user;
  if used < g.reserved_seconds then
    insert into credit_ledger (user_id, delta_seconds, reason, grant_id)
      values (p_user, g.reserved_seconds - used, 'release', g.id);
  end if;
  update soniox_grants set provisional_seconds = used, released_at = now() where id = g.id;
  return used;
end $$;

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
  actual := greatest(0, actual - system_overlap_seconds(g.id,
    coalesce(g.released_at, g.created_at + make_interval(secs => actual))));
  if charged <> actual then
    update profiles set balance_seconds = balance_seconds + (charged - actual) where id = g.user_id;
    insert into credit_ledger (user_id, delta_seconds, reason, grant_id)
      values (g.user_id, charged - actual, 'reconcile', g.id);
  end if;
  update soniox_grants set final_seconds = actual, released_at = coalesce(released_at, now()),
    reconciled_at = now() where id = g.id;
end $$;

create or replace function public.reserve_soniox_grant(p_user uuid, p_source text, p_max integer, p_min integer)
returns table (grant_id uuid, reserved_seconds integer, balance_seconds integer)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  balance integer;
  amount integer;
  new_grant uuid;
  stale uuid;
begin
  perform 1 from profiles p where p.id = p_user for update;
  -- One stream per source: an open grant for this source belongs to a dead stream.
  for stale in select g.id from soniox_grants g
      where g.user_id = p_user and g.source = p_source and g.released_at is null loop
    perform release_soniox_grant(p_user, stale);
  end loop;
  select p.balance_seconds into balance from profiles p where p.id = p_user;
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

revoke all on function public.system_overlap_seconds(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.available_seconds(uuid) from public, anon, authenticated;
grant execute on function public.system_overlap_seconds(uuid, timestamptz) to service_role;
grant execute on function public.available_seconds(uuid) to service_role;
