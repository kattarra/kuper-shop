-- KuperShop: reserve available partner commissions for a manual payout request.
-- Run in Supabase SQL Editor after the partner referral tables exist.

create or replace function public.request_partner_payout(p_partner_id uuid)
returns table(payout_request_id uuid, amount integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available bigint;
  v_reserved bigint;
  v_amount integer;
begin
  if p_partner_id is null then
    raise exception 'Partner is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_partner_id::text, 0));

  if not exists (
    select 1 from public.partners
    where id = p_partner_id and status = 'active'
  ) then
    raise exception 'Partner is not active';
  end if;

  select coalesce(sum(commission_amount), 0)
    into v_available
    from public.referral_commissions
    where partner_id = p_partner_id and status = 'available';

  select coalesce(sum(amount), 0)
    into v_reserved
    from public.partner_payout_requests
    where partner_id = p_partner_id and status = 'requested';

  v_amount := greatest(0, v_available - v_reserved)::integer;

  if v_amount <= 0 then
    return;
  end if;

  return query
  insert into public.partner_payout_requests(partner_id, amount, status)
  values (p_partner_id, v_amount, 'requested')
  returning id, partner_payout_requests.amount;
end;
$$;

revoke all on function public.request_partner_payout(uuid)
  from public, anon, authenticated;
grant execute on function public.request_partner_payout(uuid)
  to service_role;
