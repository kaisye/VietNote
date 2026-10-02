-- Settings the owner changes in the Table Editor without a deploy. The signup
-- bonus applies to accounts created after the change; the website shows it.

create table public.app_settings (
  key text primary key,
  value integer not null check (value >= 0),
  description text,
  updated_at timestamptz not null default now()
);
comment on table public.app_settings is 'Cấu hình sửa trực tiếp ở Table Editor; áp dụng ngay, không cần deploy.';

insert into public.app_settings (key, value, description) values
  ('signup_bonus_minutes', 120, 'Số phút tặng khi đăng ký tài khoản mới (website hiển thị số này)');

-- No direct access; reads go through the functions below.
alter table public.app_settings enable row level security;

create or replace function public.signup_bonus_minutes()
returns integer language sql stable security definer set search_path = public as $$
  select coalesce((select value from app_settings where key = 'signup_bonus_minutes'), 60)
$$;
grant execute on function public.signup_bonus_minutes() to anon, authenticated, service_role;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare bonus integer := signup_bonus_minutes() * 60;
begin
  insert into public.profiles (id, email, balance_seconds) values (new.id, new.email, bonus);
  if bonus > 0 then
    insert into public.credit_ledger (user_id, delta_seconds, reason) values (new.id, bonus, 'signup_bonus');
  end if;
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
