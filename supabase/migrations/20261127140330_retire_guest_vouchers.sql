begin;

-- Old links and cached web builds can no longer issue or claim a digital voucher.
drop function if exists public.drink_pass_register(jsonb, uuid, uuid, uuid);
drop function if exists public.drink_pass_voucher(uuid, text, uuid, uuid);
drop function if exists public.drink_pass_reset_invite(uuid, uuid);

update drink_pass.vouchers set status = 'cancelled' where status = 'open';

create or replace function drink_pass.event_json(e drink_pass.events)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', e.id, 'name', e.name, 'date', e.event_date, 'defaultVouchers', e.default_vouchers,
    'isDefault', e.id = drink_pass.event_id(null),
    'usesCards', exists (select 1 from drink_pass.card_events c where c.event_id = e.id)
  );
$$;

-- Keep the state RPC signature for existing operator clients.
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
        'id', r.id, 'guest', jsonb_build_object('fullName', r.response->>'name'),
        'drink', r.response->>'drink', 'scannedAt', extract(epoch from r.server_timestamp) * 1000,
        'remaining', r.response->'drinksLeft', 'bartender', d.label
      ) order by r.server_timestamp desc, r.id)
      into orders from drink_pass.redemptions r
      join drink_pass.devices d on d.event_id = r.event_id and d.id = r.device_id
      where r.event_id = scope_id and r.status = 'accepted';
    else
      select jsonb_agg(drink_pass.guest_json(g, false) - 'invite' order by g.full_name, g.id)
        into guests from drink_pass.guests g where g.event_id = scope_id;
      select jsonb_agg(drink_pass.order_json(o) order by o.scanned_at desc, o.id)
        into orders from drink_pass.orders o where o.event_id = scope_id;
    end if;
  end if;

  if uses_cards then
    select jsonb_agg(to_jsonb(d) order by d.name, d.id)
      into drinks from drink_pass.card_drinks d where d.event_id = scope_id;
  else
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
revoke all on function public.drink_pass_state(text, uuid, uuid) from public, anon;

create function public.drink_pass_card_menu(p_action text, p_values jsonb, p_event uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  drink_name text := btrim(p_values->>'name');
  drink_id uuid := (p_values->>'id')::uuid;
  enabled boolean := (p_values->>'enabled')::boolean;
begin
  if not exists (select 1 from drink_pass.operators where user_id = auth.uid() and role = 'admin') then
    raise exception using message = 'Admin access required.', errcode = '42501';
  end if;
  if not exists (select 1 from drink_pass.card_events where event_id = p_event) then
    raise exception 'This event does not use physical cards.';
  end if;

  if p_action = 'add' and nullif(drink_name, '') is not null then
    insert into drink_pass.card_drinks (event_id, name) values (p_event, drink_name)
      on conflict (event_id, lower(name)) do nothing;
    return found;
  elsif p_action = 'enable' and enabled is not null and drink_id is not null then
    update drink_pass.card_drinks set active = enabled where event_id = p_event and id = drink_id;
    if not found then raise exception 'This drink is no longer listed.'; end if;
    return true;
  end if;
  raise exception 'Enter valid drink details.';
end;
$$;
revoke all on function public.drink_pass_card_menu(text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.drink_pass_card_menu(text, jsonb, uuid) to authenticated;

create or replace function public.drink_pass_create_event(p_id uuid, p_name text, p_date date, p_default_vouchers integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  created drink_pass.events;
begin
  if not exists (select 1 from drink_pass.operators where user_id = auth.uid() and role = 'admin') then
    raise exception using message = 'Admin access required.', errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 100
    or p_date is null or p_default_vouchers is null or p_default_vouchers < 0
    or p_id is null or p_id = drink_pass.event_id(null) then
    raise exception 'Enter a valid event name, date, and drink allowance.';
  end if;

  insert into drink_pass.events (id, name, event_date, default_vouchers)
    values (p_id, btrim(p_name), p_date, p_default_vouchers)
    on conflict (id) do nothing returning * into created;
  if found then
    insert into drink_pass.card_events (event_id) values (created.id);
  else
    select * into created from drink_pass.events where id = p_id;
    if created.name <> btrim(p_name) or created.event_date <> p_date
      or created.default_vouchers <> p_default_vouchers then
      raise exception 'This request already created an event. Close the form and reload.';
    end if;
  end if;
  return drink_pass.event_json(created);
end;
$$;

commit;
