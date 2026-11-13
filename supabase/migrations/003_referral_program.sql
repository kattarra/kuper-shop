-- KuperShop referral program: data layer.
-- Adds new referral tables only. Does not modify products, catalog rows, orders, or order_items.
-- Run in Supabase SQL Editor after reviewing the migration.

create extension if not exists pgcrypto;

create table if not exists public.partners (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique,
  telegram_username text,
  display_name text not null,
  referral_code text not null unique,
  status text not null default 'invited'
    check (status in ('invited','active','blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.referral_customers (
  id uuid primary key default gen_random_uuid(),
  phone_hash text not null unique,
  partner_id uuid not null references public.partners(id),
  first_order_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists referral_customers_partner_idx
  on public.referral_customers(partner_id);

create table if not exists public.referral_order_links (
  order_id uuid primary key references public.orders(id) on delete restrict,
  partner_id uuid not null references public.partners(id),
  phone_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists referral_order_links_partner_idx
  on public.referral_order_links(partner_id);

create table if not exists public.referral_commissions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete restrict,
  partner_id uuid not null references public.partners(id),
  subtotal integer not null check (subtotal >= 0),
  commission_amount integer not null check (commission_amount >= 0),
  status text not null default 'pending'
    check (status in ('pending','available','paid','reversed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists referral_commissions_partner_status_idx
  on public.referral_commissions(partner_id, status);

create table if not exists public.partner_payout_requests (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id),
  amount integer not null check (amount > 0),
  status text not null default 'requested'
    check (status in ('requested','paid','rejected')),
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  processed_by text,
  note text
);

create index if not exists partner_payout_requests_partner_idx
  on public.partner_payout_requests(partner_id, requested_at desc);

alter table public.partners enable row level security;
alter table public.referral_customers enable row level security;
alter table public.referral_order_links enable row level security;
alter table public.referral_commissions enable row level security;
alter table public.partner_payout_requests enable row level security;

-- No direct browser access. All reads/writes go through server-side API with service role.
revoke all on public.partners, public.referral_customers,
  public.referral_order_links, public.referral_commissions,
  public.partner_payout_requests from anon, authenticated;

create or replace function public.claim_referral_customer(
  p_phone_hash text,
  p_partner_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_partner_id uuid;
begin
  if p_phone_hash is null or length(p_phone_hash) < 32 then
    raise exception 'Invalid phone hash';
  end if;

  if not exists (
    select 1 from public.partners
    where id = p_partner_id and status = 'active'
  ) then
    raise exception 'Partner is not active';
  end if;

  insert into public.referral_customers(phone_hash, partner_id)
  values (p_phone_hash, p_partner_id)
  on conflict (phone_hash) do nothing;

  select partner_id into v_partner_id
  from public.referral_customers
  where phone_hash = p_phone_hash;

  return v_partner_id;
end;
$$;

revoke all on function public.claim_referral_customer(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_referral_customer(text, uuid) to service_role;

create or replace function public.sync_referral_commission_for_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_partner_id uuid;
begin
  select * into v_order
  from public.orders
  where id = p_order_id;

  if not found then
    return;
  end if;

  select partner_id into v_partner_id
  from public.referral_order_links
  where order_id = p_order_id;

  if v_partner_id is null then
    return;
  end if;

  if v_order.status = 'completed' then
    insert into public.referral_commissions
      (order_id, partner_id, subtotal, commission_amount, status)
    values
      (v_order.id, v_partner_id, v_order.subtotal,
       floor(v_order.subtotal * 0.10)::integer, 'available')
    on conflict (order_id) do update
      set status = case
        when public.referral_commissions.status = 'reversed' then 'reversed'
        else public.referral_commissions.status
      end,
      updated_at = now();
  elsif v_order.status = 'cancelled' then
    update public.referral_commissions
      set status = 'reversed', updated_at = now()
      where order_id = p_order_id and status <> 'paid';
  end if;
end;
$$;

create or replace function public.on_order_status_referral_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    perform public.sync_referral_commission_for_order(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists orders_referral_commission_status on public.orders;
create trigger orders_referral_commission_status
after update of status on public.orders
for each row execute function public.on_order_status_referral_change();

create or replace function public.on_referral_order_link_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_referral_commission_for_order(new.order_id);
  return new;
end;
$$;

drop trigger if exists referral_order_link_sync on public.referral_order_links;
create trigger referral_order_link_sync
after insert on public.referral_order_links
for each row execute function public.on_referral_order_link_insert();

revoke all on function public.sync_referral_commission_for_order(uuid) from public, anon, authenticated;
revoke all on function public.on_order_status_referral_change() from public, anon, authenticated;
revoke all on function public.on_referral_order_link_insert() from public, anon, authenticated;

-- Verify the expected existing order columns before relying on the integration.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='orders' and column_name='id'
      and data_type='uuid'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='orders' and column_name='subtotal'
      and data_type in ('integer','bigint','numeric')
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='orders' and column_name='status'
  ) then
    raise exception 'KuperShop referral migration expects public.orders(id uuid, subtotal numeric/integer, status). No existing order data was modified.';
  end if;
end;
$$;
