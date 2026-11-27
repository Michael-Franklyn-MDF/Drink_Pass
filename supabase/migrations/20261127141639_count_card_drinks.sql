begin;

-- Keep historical drink references and allow new redemptions without a menu item.
alter table drink_pass.redemptions drop constraint redemptions_check;
alter table drink_pass.redemptions add constraint accepted_redemption_has_references
  check (status <> 'accepted' or num_nonnulls(event_id, guest_id, card_id, device_id) = 4);

alter table drink_pass.devices add column bartender_name text check (btrim(bartender_name) <> '');
update drink_pass.devices set bartender_name = label;
alter table drink_pass.devices alter column bartender_name set not null;

-- Older confirmations recorded the device label. Preserve that attribution.
update drink_pass.redemptions r
set response = r.response || jsonb_build_object(
  'staffId', case when g.identifier_type = 'Staff ID' then g.identifier end,
  'role', g.role, 'bartender', d.bartender_name
)
from drink_pass.guests g, drink_pass.devices d
where r.status = 'accepted' and g.id = r.guest_id and d.id = r.device_id;

drop function public.drink_pass_card_menu(text, jsonb, uuid);
drop function public.drink_pass_card_redeem(text, uuid, uuid, uuid);
drop function drink_pass.card_redeem(text, uuid, uuid, uuid);

create function drink_pass.require_card_guest_staff_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.identifier_type <> 'Staff ID'
    and exists (select 1 from drink_pass.card_events where event_id = new.event_id) then
    raise exception 'Enter a staff ID for each guest at a physical-card event.';
  end if;
  return new;
end;
$$;
revoke all on function drink_pass.require_card_guest_staff_id() from public, anon, authenticated;
create trigger card_guest_staff_id before insert or update of event_id, identifier_type on drink_pass.guests
  for each row execute function drink_pass.require_card_guest_staff_id();

create or replace function drink_pass.card_lookup(p_key_hash text, p_card uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  device drink_pass.devices;
  card drink_pass.cards;
  guest drink_pass.guests;
  drinks_left integer;
begin
  select * into device from drink_pass.devices where key_hash = p_key_hash and active;
  if not found then return jsonb_build_object('status', 'unknown_device'); end if;
  if p_card is null then return jsonb_build_object('status', 'invalid_signature'); end if;

  select * into card from drink_pass.cards where id = p_card and event_id = device.event_id;
  if not found then return jsonb_build_object('status', 'card_not_found'); end if;
  if card.status <> 'active' then return jsonb_build_object('status', 'card_voided'); end if;

  select * into strict guest from drink_pass.guests where id = card.guest_id;
  if guest.role = 'staff' then
    select guest.allowance - count(*) into drinks_left from drink_pass.redemptions r
      where r.event_id = card.event_id and r.guest_id = guest.id and r.status = 'accepted';
    drinks_left := greatest(0, drinks_left);
  end if;

  return jsonb_build_object('status', 'eligible', 'name', guest.full_name,
    'department', guest.department, 'cardType', card.card_type, 'role', guest.role,
    'staffId', case when guest.identifier_type = 'Staff ID' then guest.identifier end,
    'drinksLeft', drinks_left);
end;
$$;

create function drink_pass.card_redeem(p_key_hash text, p_card uuid, p_request uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  device drink_pass.devices;
  card drink_pass.cards;
  guest drink_pass.guests;
  prior drink_pass.redemptions;
  latest drink_pass.redemptions;
  latest_seen uuid;
  drinks_left integer;
  decided_at timestamptz;
  outcome text;
  result jsonb;
begin
  if p_request is null then return jsonb_build_object('status', 'invalid_request'); end if;
  select * into device from drink_pass.devices where key_hash = p_key_hash and active for share;
  if not found then
    outcome := 'unknown_device';
  else
    -- The same device can retry a confirmation while its first request is still in flight.
    perform pg_advisory_xact_lock(hashtextextended(device.id::text || p_request::text, 0));
    select * into prior from drink_pass.redemptions r
      where r.device_id = device.id and r.request_id = p_request;
    if found then
      if prior.requested_card_id is distinct from p_card then
        return jsonb_build_object('status', 'request_conflict');
      end if;
      return prior.response - 'drink';
    end if;

    if p_card is null then
      outcome := 'invalid_signature';
    else
      select * into card from drink_pass.cards where id = p_card and event_id = device.event_id;
      if not found then
        outcome := 'card_not_found';
      else
        select r.id into latest_seen from drink_pass.redemptions r
          where r.event_id = card.event_id and r.guest_id = card.guest_id and r.status = 'accepted'
          order by r.server_timestamp desc, r.id desc limit 1;

        -- Always lock guest before card. Card reissue must follow the same order.
        select * into strict guest from drink_pass.guests where id = card.guest_id for update;
        select * into strict card from drink_pass.cards where id = p_card for share;
        if card.status <> 'active' then
          outcome := 'card_voided';
        else
          decided_at := clock_timestamp();

          select * into latest from drink_pass.redemptions r
            where r.event_id = card.event_id and r.guest_id = guest.id and r.status = 'accepted'
            order by r.server_timestamp desc, r.id desc limit 1;
          if guest.role = 'staff' then
            select guest.allowance - count(*) into drinks_left from drink_pass.redemptions r
              where r.event_id = card.event_id and r.guest_id = guest.id and r.status = 'accepted';
          end if;

          if latest.server_timestamp > decided_at - interval '5 minutes' then
            outcome := case when latest.id is distinct from latest_seen then 'already_redeemed' else 'cooldown_active' end;
          elsif drinks_left <= 0 then
            outcome := 'no_drinks_left';

          else
            outcome := 'accepted';
            result := jsonb_build_object('status', outcome, 'name', guest.full_name,
              'staffId', case when guest.identifier_type = 'Staff ID' then guest.identifier end,
              'role', guest.role, 'bartender', device.bartender_name,
              'servedAt', decided_at, 'drinksLeft', drinks_left - 1);
          end if;
        end if;
      end if;
    end if;
  end if;

  result := coalesce(result, jsonb_build_object('status', outcome));
  insert into drink_pass.redemptions (
    event_id, guest_id, card_id, device_id, bar, request_id, requested_card_id,
    server_timestamp, status, response
  ) values (
    device.event_id, card.guest_id, card.id, device.id, device.bar, p_request,
    case when device.id is not null then p_card end,
    coalesce(decided_at, clock_timestamp()), outcome, result
  );
  return result;
end;
$$;

create function public.drink_pass_card_redeem(p_key_hash text, p_card uuid, p_request uuid)
returns jsonb language sql set search_path = '' as $$
  select drink_pass.card_redeem(p_key_hash, p_card, p_request);
$$;
revoke all on function drink_pass.card_redeem(text, uuid, uuid),
  public.drink_pass_card_redeem(text, uuid, uuid) from public, anon, authenticated;
grant execute on function drink_pass.card_redeem(text, uuid, uuid),
  public.drink_pass_card_redeem(text, uuid, uuid) to service_role;

create or replace function public.drink_pass_state(p_role text, p_session uuid default null, p_event uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  scope_id uuid := drink_pass.event_id(p_event);
  selected drink_pass.events;
  uses_cards boolean;
  events jsonb;
  guests jsonb;
  orders jsonb;
  drinks jsonb;
begin
  if p_role is null or p_role not in ('admin', 'bartender') or not exists (
    select 1 from drink_pass.operators where user_id = auth.uid() and role = p_role
  ) then
    raise exception using message = 'This account does not have access to this role.', errcode = '42501';
  end if;

  select * into selected from drink_pass.events where id = scope_id;
  if not found then raise exception 'This event link is no longer valid.'; end if;
  uses_cards := exists (select 1 from drink_pass.card_events where event_id = scope_id);
  if uses_cards and p_role = 'bartender' then
    raise exception using message = 'Use the Flutter bartender app for this event.', errcode = '42501';
  end if;

  if p_role = 'admin' then
    select jsonb_agg(drink_pass.event_json(e) order by e.event_date desc, e.name, e.id)
      into events from drink_pass.events e;
    if uses_cards then
      select jsonb_agg((drink_pass.guest_json(g, false) - 'invite') || jsonb_build_object(
        'remaining', case when g.role = 'staff' then greatest(0, g.allowance - coalesce(served.total, 0)) end
      ) order by g.full_name, g.id)
      into guests
      from drink_pass.guests g
      left join (
        select r.guest_id, count(*) as total from drink_pass.redemptions r
        where r.event_id = scope_id and r.status = 'accepted' group by r.guest_id
      ) served on served.guest_id = g.id
      where g.event_id = scope_id;

      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'guest', jsonb_build_object(
          'id', r.guest_id, 'fullName', r.response->>'name',
          'staffId', r.response->>'staffId', 'role', r.response->>'role'
        ),
        'scannedAt', extract(epoch from r.server_timestamp) * 1000,
        'remaining', r.response->'drinksLeft', 'bartender', r.response->>'bartender'
      ) order by r.server_timestamp desc, r.id)
      into orders from drink_pass.redemptions r
      where r.event_id = scope_id and r.status = 'accepted';
    else
      select jsonb_agg(drink_pass.guest_json(g, false) - 'invite' order by g.full_name, g.id)
        into guests from drink_pass.guests g where g.event_id = scope_id;
      select jsonb_agg(drink_pass.order_json(o) order by o.scanned_at desc, o.id)
        into orders from drink_pass.orders o where o.event_id = scope_id;
    end if;
  end if;

  if not uses_cards then
    select jsonb_agg(to_jsonb(d) order by d.name, d.id)
      into drinks from drink_pass.drinks d where d.event_id = scope_id;
  end if;

  return jsonb_build_object(
    'event', drink_pass.event_json(selected), 'events', coalesce(events, '[]'::jsonb),
    'guests', coalesce(guests, '[]'::jsonb), 'drinks', coalesce(drinks, '[]'::jsonb),
    'orders', coalesce(orders, '[]'::jsonb)
  );
end;
$$;
commit;
