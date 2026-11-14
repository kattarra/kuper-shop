create table if not exists public.shop_promotions (
  id uuid primary key default gen_random_uuid(),
  text text not null check (char_length(text) between 1 and 180),
  image_url text,
  sort_order integer not null default 0 check (sort_order between 0 and 1000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shop_promotions enable row level security;
revoke all on public.shop_promotions from anon, authenticated;
grant all on public.shop_promotions to service_role;

insert into public.shop_promotions (text, sort_order)
select 'Скидка 10% на все жидкости до конца недели', 0
where not exists (select 1 from public.shop_promotions);

insert into public.shop_promotions (text, sort_order)
select 'При покупке двух одноразок — третья в подарок', 1
where (select count(*) from public.shop_promotions) = 1;
