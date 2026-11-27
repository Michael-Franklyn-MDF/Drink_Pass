begin;

create table drink_pass.card_events (
  event_id uuid primary key references drink_pass.events(id)
);

create table drink_pass.card_drinks (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references drink_pass.card_events(event_id),
  name text not null check (btrim(name) <> ''),
  active boolean not null default true,
  unique (event_id, id)
);
create unique index card_drinks_name on drink_pass.card_drinks (event_id, lower(name));

create table drink_pass.cards (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references drink_pass.card_events(event_id),
  guest_id uuid not null,
  card_type text not null check (card_type in ('blue', 'gold')),
  status text not null default 'active' check (status in ('active', 'voided', 'replaced')),
  issued_at timestamptz not null default clock_timestamp(),
  voided_at timestamptz,
  unique (event_id, id, guest_id),
  foreign key (event_id, guest_id) references drink_pass.guests(event_id, id),
  check ((status = 'active') = (voided_at is null))
);
create unique index cards_one_active on drink_pass.cards (event_id, guest_id) where status = 'active';

create table drink_pass.devices (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references drink_pass.card_events(event_id),
  label text not null check (btrim(label) <> ''),
  bar text not null check (bar = btrim(bar) and bar <> ''),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  active boolean not null default true,
  unique (event_id, id)
);

create table drink_pass.redemptions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references drink_pass.card_events(event_id),
  guest_id uuid,
  card_id uuid,
  drink_id uuid,
  device_id uuid,
  bar text,
  request_id uuid not null,
  requested_card_id uuid,
  requested_drink_id uuid,
  server_timestamp timestamptz not null,
  status text not null check (status in (
    'accepted', 'unknown_device', 'invalid_signature', 'card_not_found', 'card_voided',
    'no_drinks_left', 'cooldown_active', 'already_redeemed', 'drink_unavailable'
  )),
  response jsonb not null,
  unique (device_id, request_id),
  foreign key (event_id, device_id) references drink_pass.devices(event_id, id),
  foreign key (event_id, drink_id) references drink_pass.card_drinks(event_id, id),
  foreign key (event_id, card_id, guest_id) references drink_pass.cards(event_id, id, guest_id),
  check (status <> 'accepted' or num_nonnulls(event_id, guest_id, card_id, drink_id, device_id) = 5)
);
create index redemptions_success_by_guest
  on drink_pass.redemptions (event_id, guest_id, server_timestamp desc, id desc) where status = 'accepted';
create index redemptions_by_card
  on drink_pass.redemptions (event_id, card_id, server_timestamp desc, id desc) where card_id is not null;

alter table drink_pass.card_events enable row level security;
alter table drink_pass.card_drinks enable row level security;
alter table drink_pass.cards enable row level security;
alter table drink_pass.devices enable row level security;
alter table drink_pass.redemptions enable row level security;
revoke all on drink_pass.card_events, drink_pass.card_drinks, drink_pass.cards,
  drink_pass.devices, drink_pass.redemptions from public, anon, authenticated;

-- Serialize card-event activation with legacy voucher issuance for that event.
create function drink_pass.check_card_event_mode()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform 1 from drink_pass.events e where e.id = new.event_id for no key update;
  if tg_table_name = 'card_events' then
    if exists (select 1 from drink_pass.vouchers v where v.event_id = new.event_id) then
      raise exception 'Card events must start without legacy vouchers.';
    end if;
  elsif exists (select 1 from drink_pass.card_events e where e.event_id = new.event_id) then
    raise exception 'This event uses physical cards.';
  end if;
  return new;
end;
$$;
revoke all on function drink_pass.check_card_event_mode() from public, anon, authenticated;
create trigger require_fresh_card_event before insert on drink_pass.card_events
  for each row execute function drink_pass.check_card_event_mode();
create trigger require_legacy_voucher_event before insert on drink_pass.vouchers
  for each row execute function drink_pass.check_card_event_mode();

-- One row per later attempt, linked to the most recent attempt at another bar.
create view drink_pass.card_flags with (security_invoker = true) as
select r.event_id, r.card_id, r.id as attempt_id, r.bar, r.server_timestamp,
  earlier.id as prior_attempt_id, earlier.bar as prior_bar, earlier.server_timestamp as prior_timestamp
from drink_pass.redemptions r
cross join lateral (
  select p.id, p.bar, p.server_timestamp
  from drink_pass.redemptions p
  where p.event_id = r.event_id and p.card_id = r.card_id and p.bar <> r.bar
    and (p.server_timestamp, p.id) < (r.server_timestamp, r.id)
    and p.server_timestamp >= r.server_timestamp - interval '5 minutes'
  order by p.server_timestamp desc, p.id desc
  limit 1
) earlier
where r.card_id is not null;
revoke all on drink_pass.card_flags from public, anon, authenticated;

create function drink_pass.card_lookup(p_key_hash text, p_card uuid)
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
    'drinksLeft', drinks_left, 'drinks', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) order by d.name, d.id)
      from drink_pass.card_drinks d where d.event_id = card.event_id and d.active
    ), '[]'::jsonb));
end;
$$;

create function drink_pass.card_redeem(p_key_hash text, p_card uuid, p_drink uuid, p_request uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  device drink_pass.devices;
  card drink_pass.cards;
  guest drink_pass.guests;
  drink drink_pass.card_drinks;
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
      if prior.requested_card_id is distinct from p_card or prior.requested_drink_id is distinct from p_drink then
        return jsonb_build_object('status', 'request_conflict');
      end if;
      return prior.response;
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
          select * into drink from drink_pass.card_drinks d
            where d.id = p_drink and d.event_id = card.event_id and d.active for share;
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
          elsif drink.id is null then
            outcome := 'drink_unavailable';
          else
            outcome := 'accepted';
            result := jsonb_build_object('status', outcome, 'name', guest.full_name,
              'drink', drink.name, 'servedAt', decided_at, 'drinksLeft', drinks_left - 1);
          end if;
        end if;
      end if;
    end if;
  end if;

  result := coalesce(result, jsonb_build_object('status', outcome));
  insert into drink_pass.redemptions (
    event_id, guest_id, card_id, drink_id, device_id, bar, request_id, requested_card_id,
    requested_drink_id, server_timestamp, status, response
  ) values (
    device.event_id, card.guest_id, card.id, drink.id, device.id, device.bar, p_request,
    case when device.id is not null then p_card end, case when device.id is not null then p_drink end,
    coalesce(decided_at, clock_timestamp()), outcome, result
  );
  return result;
end;
$$;

-- Only the Edge Functions can call the public wrappers. A null card means
-- the Edge Function could not authenticate the QR signature.
create function public.drink_pass_card_lookup(p_key_hash text, p_card uuid)
returns jsonb language sql stable set search_path = '' as $$
  select drink_pass.card_lookup(p_key_hash, p_card);
$$;
create function public.drink_pass_card_redeem(p_key_hash text, p_card uuid, p_drink uuid, p_request uuid)
returns jsonb language sql set search_path = '' as $$
  select drink_pass.card_redeem(p_key_hash, p_card, p_drink, p_request);
$$;
revoke all on function drink_pass.card_lookup(text, uuid), drink_pass.card_redeem(text, uuid, uuid, uuid),
  public.drink_pass_card_lookup(text, uuid), public.drink_pass_card_redeem(text, uuid, uuid, uuid)
  from public, anon, authenticated;
grant usage on schema drink_pass to service_role;
grant execute on function drink_pass.card_lookup(text, uuid), drink_pass.card_redeem(text, uuid, uuid, uuid),
  public.drink_pass_card_lookup(text, uuid), public.drink_pass_card_redeem(text, uuid, uuid, uuid)
  to service_role;

commit;
