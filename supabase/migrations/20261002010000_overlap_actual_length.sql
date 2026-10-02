-- A system grant left open by a dead worker is closed only when the next one
-- is reserved, so its released_at can be far past the end of its audio. End
-- each system interval at its measured length once Soniox has reported it.
create or replace function public.system_overlap_seconds(p_grant uuid, p_until timestamptz)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(greatest(0, extract(epoch from least(p_until, s.ends_at) - greatest(m.created_at, s.created_at)))), 0)::integer
  from soniox_grants m
  join lateral (
    select g.created_at, g.created_at + make_interval(secs => least(g.reserved_seconds::numeric,
      coalesce(g.final_seconds::numeric, extract(epoch from coalesce(g.released_at, now()) - g.created_at)))) as ends_at
    from soniox_grants g
    where g.user_id = m.user_id and g.source = 'system' and g.id <> m.id
  ) s on true
  where m.id = p_grant and m.source = 'microphone'
$$;
