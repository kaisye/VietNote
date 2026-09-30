-- Paid credit through payOS (VietQR).
--
-- Prices and promotions live in credit_packages and are edited in the Supabase
-- Table Editor; the website and the app read them through credit_offers().
-- A promotion is on while promo_price_vnd or promo_bonus_seconds is set and
-- promo_ends_at is empty or in the future.

create table public.credit_packages (
  id text primary key,
  name text not null,
  hours numeric(6,1) not null check (hours > 0),
  price_vnd integer not null check (price_vnd >= 2000),
  promo_price_vnd integer check (promo_price_vnd >= 2000),
  promo_bonus_hours numeric(6,1) not null default 0 check (promo_bonus_hours >= 0),
  promo_label text,
  promo_ends_at timestamptz,
  highlight boolean not null default false,
  sort integer not null default 0,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

comment on table public.credit_packages is 'Gói phút bán trong app. Sửa trực tiếp ở Table Editor; website và app cập nhật ngay.';
comment on column public.credit_packages.id is 'Mã gói, không đổi sau khi đã bán (vd. goi-10h)';
comment on column public.credit_packages.name is 'Tên hiển thị (vd. Gói 10 giờ)';
comment on column public.credit_packages.hours is 'Số giờ sử dụng của gói';
comment on column public.credit_packages.price_vnd is 'Giá thường, đồng';
comment on column public.credit_packages.promo_price_vnd is 'Giá khuyến mãi, đồng. Để trống nếu không giảm giá';
comment on column public.credit_packages.promo_bonus_hours is 'Số giờ tặng thêm trong khuyến mãi';
comment on column public.credit_packages.promo_label is 'Nhãn khuyến mãi (vd. Giảm 30% · Tết)';
comment on column public.credit_packages.promo_ends_at is 'Khuyến mãi tự tắt sau thời điểm này. Để trống = không hạn';
comment on column public.credit_packages.highlight is 'Tô nổi gói này (Phổ biến)';
comment on column public.credit_packages.sort is 'Thứ tự hiển thị, nhỏ đứng trước';
comment on column public.credit_packages.active is 'Bỏ chọn để ẩn gói';

alter table public.credit_packages enable row level security;

create or replace function public.touch_credit_package() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger credit_packages_touch before update on public.credit_packages
  for each row execute function public.touch_credit_package();

insert into public.credit_packages (id, name, hours, price_vnd, highlight, sort) values
  ('goi-5h', 'Gói 5 giờ', 5, 59000, false, 10),
  ('goi-15h', 'Gói 15 giờ', 15, 149000, true, 20),
  ('goi-40h', 'Gói 40 giờ', 40, 349000, false, 30);

-- What is on sale right now, with the promotion already applied.
create or replace function public.credit_offers()
returns table (
  id text, name text, hours numeric, bonus_hours numeric, price_vnd integer,
  original_price_vnd integer, promo_label text, promo_ends_at timestamptz, highlight boolean
)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.hours,
    case when promo then p.promo_bonus_hours else 0 end,
    case when promo and p.promo_price_vnd is not null then p.promo_price_vnd else p.price_vnd end,
    case when promo and p.promo_price_vnd is not null and p.promo_price_vnd < p.price_vnd then p.price_vnd end,
    case when promo then p.promo_label end,
    case when promo then p.promo_ends_at end,
    p.highlight
  from credit_packages p,
    lateral (select (p.promo_price_vnd is not null or p.promo_bonus_hours > 0)
      and (p.promo_ends_at is null or p.promo_ends_at > now()) as promo) x
  where p.active
  order by p.sort, p.price_vnd
$$;
grant execute on function public.credit_offers() to anon, authenticated, service_role;

create table public.credit_orders (
  order_code bigint primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  package_id text not null references public.credit_packages (id),
  amount_vnd integer not null,
  seconds integer not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'cancelled')),
  payment_link_id text,
  checkout_url text,
  reference text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index credit_orders_user on public.credit_orders (user_id, created_at desc);
alter table public.credit_orders enable row level security;
create policy "own orders" on public.credit_orders for select using (auth.uid() = user_id);

-- Credits a paid order exactly once. Returns false when it was already paid.
create or replace function public.pay_credit_order(p_order bigint, p_amount integer, p_reference text)
returns boolean language plpgsql security definer set search_path = public as $$
declare o credit_orders;
begin
  select * into o from credit_orders where order_code = p_order for update;
  if not found then raise exception 'unknown_order'; end if;
  if o.status = 'paid' then return false; end if;
  if p_amount < o.amount_vnd then raise exception 'amount_mismatch'; end if;
  update credit_orders set status = 'paid', paid_at = now(), reference = p_reference where order_code = p_order;
  perform add_credit(o.user_id, o.seconds, 'purchase', 'payOS ' || p_order || coalesce(' · ' || p_reference, ''));
  return true;
end $$;
revoke all on function public.pay_credit_order(bigint, integer, text) from public, anon, authenticated;
grant execute on function public.pay_credit_order(bigint, integer, text) to service_role;
revoke all on function public.touch_credit_package() from public, anon, authenticated;
