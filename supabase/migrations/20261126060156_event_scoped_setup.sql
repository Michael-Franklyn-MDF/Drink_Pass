begin;

create table drink_pass.events (
  id uuid primary key,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  event_date date not null,
  default_vouchers integer not null check (default_vouchers >= 0)
);
alter table drink_pass.events enable row level security;
revoke all on drink_pass.events from public, anon, authenticated;

-- Keep the original event accessible at existing URLs.
create function drink_pass.event_id(requested uuid)
returns uuid language sql immutable set search_path = '' as $$
  select coalesce(requested, '00000000-0000-4000-8000-000000000001'::uuid);
$$;

insert into drink_pass.events (id, name, event_date, default_vouchers)
select drink_pass.event_id(null), 'Two-phone rehearsal',
  coalesce(min((scanned_at at time zone 'Africa/Nairobi')::date), current_date), 5
from drink_pass.orders;

alter table drink_pass.guests add column event_id uuid references drink_pass.events(id);
alter table drink_pass.drinks add column event_id uuid references drink_pass.events(id);
alter table drink_pass.vouchers add column event_id uuid references drink_pass.events(id);
alter table drink_pass.orders add column event_id uuid references drink_pass.events(id);

update drink_pass.guests set event_id = drink_pass.event_id(null);
update drink_pass.drinks set event_id = drink_pass.event_id(null);
update drink_pass.vouchers set event_id = drink_pass.event_id(null);
update drink_pass.orders set event_id = drink_pass.event_id(null);

alter table drink_pass.guests alter column event_id set not null,
  add unique (event_id, id), drop constraint guests_session_hash_key;
alter table drink_pass.drinks alter column event_id set not null, add unique (event_id, id);
alter table drink_pass.vouchers alter column event_id set not null, add unique (event_id, id, guest_id),
  add foreign key (event_id, guest_id) references drink_pass.guests(event_id, id),
  add foreign key (event_id, drink_id) references drink_pass.drinks(event_id, id);
alter table drink_pass.orders alter column event_id set not null,
  add foreign key (event_id, id, guest_id) references drink_pass.vouchers(event_id, id, guest_id);

drop index drink_pass.guests_identifier;
drop index drink_pass.drinks_name;
create unique index guests_identifier on drink_pass.guests (event_id, role, identifier_type, lower(identifier));
create unique index guests_session on drink_pass.guests (event_id, session_hash) where session_hash is not null;
create unique index drinks_name on drink_pass.drinks (event_id, lower(name));
create index vouchers_event_guest on drink_pass.vouchers (event_id, guest_id);
create index orders_event_scanned on drink_pass.orders (event_id, scanned_at desc);

create function drink_pass.event_json(e drink_pass.events)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', e.id, 'name', e.name, 'date', e.event_date, 'defaultVouchers', e.default_vouchers,
    'isDefault', e.id = drink_pass.event_id(null)
  );
$$;

create function public.drink_pass_create_event(p_id uuid, p_name text, p_date date, p_default_vouchers integer)
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
  if not found then
    select * into created from drink_pass.events where id = p_id;
    if created.name <> btrim(p_name) or created.event_date <> p_date
      or created.default_vouchers <> p_default_vouchers then
      raise exception 'This request already created an event. Close the form and reload.';
    end if;
  end if;
  return drink_pass.event_json(created);
end;
$$;

-- Recreate RPCs with an optional event parameter so existing callers keep the rehearsal.
drop function public.drink_pass_state(text, uuid), public.drink_pass_register(jsonb, uuid, uuid),
  public.drink_pass_voucher(uuid, text, uuid), public.drink_pass_redeem(uuid),
  public.drink_pass_approve(jsonb), public.drink_pass_stock(text, jsonb);

create function public.drink_pass_state(p_role text, p_session uuid default null, p_event uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  scope_id uuid := drink_pass.event_id(p_event);
  selected drink_pass.events;
  events jsonb;
  guest drink_pass.guests;
  guests jsonb;
  vouchers jsonb;
  orders jsonb;
begin
  select * into selected from drink_pass.events where id = scope_id;
  if not found then raise exception 'This event link is no longer valid.'; end if;

  if p_role in ('admin', 'bartender') then
    if not exists (
      select 1 from drink_pass.operators where user_id = auth.uid() and role = p_role
    ) then
      raise exception using message = 'This account does not have access to this role.', errcode = '42501';
    end if;

    if p_role = 'admin' then
      select jsonb_agg(drink_pass.event_json(e) order by e.event_date desc, e.name, e.id)
        into events from drink_pass.events e;
      select jsonb_agg(drink_pass.guest_json(g, true) order by g.full_name, g.id)
        into guests from drink_pass.guests g where g.event_id = scope_id;
      select jsonb_agg(drink_pass.order_json(o) order by o.scanned_at desc, o.id)
        into orders from drink_pass.orders o where o.event_id = scope_id;
    end if;
  elsif p_role in ('staff', 'manager') then
    select * into guest from drink_pass.guests
      where event_id = scope_id and role = p_role and session_hash = drink_pass.session_hash(p_session);
    if found then
      guests := jsonb_build_array(drink_pass.guest_json(guest, false));
      select jsonb_object_agg(v.id, drink_pass.voucher_json(v, o))
        into vouchers from drink_pass.vouchers v
        left join drink_pass.orders o on o.id = v.id
        where v.event_id = scope_id and v.guest_id = guest.id;
    end if;
  else
    raise exception 'Unknown Drink Pass role.';
  end if;

  return jsonb_build_object(
    'event', drink_pass.event_json(selected),
    'events', coalesce(events, '[]'::jsonb),
    'guests', coalesce(guests, '[]'::jsonb),
    'drinks', case when p_role in ('admin', 'bartender') or guest.id is not null then
      coalesce((select jsonb_agg(to_jsonb(d) order by d.name, d.id) from drink_pass.drinks d where d.event_id = scope_id), '[]'::jsonb)
      else '[]'::jsonb end,
    'vouchers', coalesce(vouchers, '{}'::jsonb),
    'orders', coalesce(orders, '[]'::jsonb),
    'sessions', case when guest.id is null then '{}'::jsonb else jsonb_build_object(p_role, guest.id) end);
end;
$$;

create function public.drink_pass_register(p_profile jsonb, p_invite uuid, p_session uuid, p_event uuid default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  scope_id uuid := drink_pass.event_id(p_event);
  claimed uuid;
begin
  if p_invite is null or p_session is null then return false; end if;
  update drink_pass.guests
    set session_hash = drink_pass.session_hash(p_session)
    where event_id = scope_id and invite = p_invite
      and (session_hash is null or session_hash = drink_pass.session_hash(p_session))
      and role = p_profile->>'role'
      and identifier_type = p_profile->>'identifierType'
      and lower(identifier) = lower(btrim(p_profile->>'identifier'))
      and lower(full_name) = lower(btrim(p_profile->>'fullName'))
      and lower(department) = lower(btrim(p_profile->>'department'))
    returning id into claimed;
  return claimed is not null;
end;
$$;

create function public.drink_pass_voucher(p_session uuid, p_action text, p_id uuid, p_event uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  scope_id uuid := drink_pass.event_id(p_event);
  guest drink_pass.guests;
  voucher drink_pass.vouchers;
  existing_id uuid;
begin
  select * into guest from drink_pass.guests
    where event_id = scope_id and session_hash = drink_pass.session_hash(p_session) for update;
  if not found then return null; end if;

  if p_action = 'cancel' then
    update drink_pass.vouchers set status = 'cancelled'
      where id = p_id and guest_id = guest.id and status = 'open' and expires_at > clock_timestamp();
    return (select to_jsonb(v.status) from drink_pass.vouchers v where v.id = p_id and v.guest_id = guest.id);
  end if;

  if p_action <> 'open' or p_action is null then raise exception 'Unknown voucher action.'; end if;
  if guest.remaining = 0 or not exists (
    select 1 from drink_pass.drinks where event_id = scope_id and id = p_id and stock > 0 and not paused
  ) then return null; end if;

  select id into existing_id from drink_pass.vouchers
    where guest_id = guest.id and status = 'open' and drink_id = p_id and expires_at > clock_timestamp();
  if found then
    select * into voucher from drink_pass.vouchers where id = existing_id;
  else
    update drink_pass.vouchers
      set status = case when expires_at <= clock_timestamp() then 'expired' else 'cancelled' end
      where guest_id = guest.id and status = 'open';
    insert into drink_pass.vouchers (event_id, guest_id, drink_id, expires_at)
      values (scope_id, guest.id, p_id, clock_timestamp() + interval '2 minutes') returning * into voucher;
  end if;
  return drink_pass.voucher_json(voucher, null::drink_pass.orders);
end;
$$;

create function public.drink_pass_redeem(p_voucher uuid, p_event uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  scope_id uuid := drink_pass.event_id(p_event);
  operator_label text;
  linked_guest uuid;
  guest drink_pass.guests;
  voucher drink_pass.vouchers;
  served drink_pass.orders;
  drink_name text;
  scan_time timestamptz;
begin
  select label into operator_label from drink_pass.operators
    where user_id = auth.uid() and role = 'bartender';
  if not found then raise exception using message = 'Bartender access required.', errcode = '42501'; end if;

  select guest_id into linked_guest from drink_pass.vouchers where id = p_voucher and event_id = scope_id;
  if not found then return '{"status":"invalid"}'::jsonb; end if;

  -- Issuing, cancelling and redeeming all take the guest lock before the voucher lock.
  select * into guest from drink_pass.guests where id = linked_guest for update;
  select * into voucher from drink_pass.vouchers where id = p_voucher for update;
  if voucher.status = 'redeemed' then
    select * into served from drink_pass.orders where id = voucher.id;
    return jsonb_build_object('status', 'used', 'order', drink_pass.order_json(served));
  end if;
  if voucher.status = 'cancelled' or guest.remaining = 0 then return '{"status":"invalid"}'::jsonb; end if;

  -- Check expiry after taking the stock lock so waiting behind an update cannot extend a QR.
  perform 1 from drink_pass.drinks where id = voucher.drink_id for update;
  scan_time := clock_timestamp();
  if voucher.status = 'expired' or voucher.expires_at <= scan_time then
    update drink_pass.vouchers set status = 'expired' where id = voucher.id;
    return '{"status":"expired"}'::jsonb;
  end if;

  update drink_pass.drinks set stock = stock - 1
    where id = voucher.drink_id and stock > 0 and not paused returning name into drink_name;
  if not found then return '{"status":"unavailable"}'::jsonb; end if;
  update drink_pass.guests set remaining = remaining - 1
    where id = guest.id returning remaining into guest.remaining;
  insert into drink_pass.orders (event_id, id, guest_id, guest_name, drink, scanned_at, remaining, bartender)
    values (scope_id, voucher.id, guest.id, guest.full_name, drink_name, scan_time, guest.remaining, operator_label)
    returning * into served;
  update drink_pass.vouchers set status = 'redeemed' where id = voucher.id;
  return jsonb_build_object('status', 'accepted', 'order', drink_pass.order_json(served));
end;
$$;

create function public.drink_pass_approve(p_profiles jsonb, p_event uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  scope_id uuid := drink_pass.event_id(p_event);
  added integer;
  default_balance integer;
begin
  if not exists (select 1 from drink_pass.operators where user_id = auth.uid() and role = 'admin') then
    raise exception using message = 'Admin access required.', errcode = '42501';
  end if;
  select default_vouchers into default_balance from drink_pass.events where id = scope_id;
  if not found then raise exception 'This event link is no longer valid.'; end if;
  insert into drink_pass.guests (event_id, full_name, identifier, identifier_type, department, role, allowance, remaining)
    select scope_id, btrim(p->>'fullName'), btrim(p->>'identifier'), p->>'identifierType', btrim(p->>'department'),
      p->>'role', balance, balance
    from jsonb_array_elements(p_profiles) p
    cross join lateral (select case when p->>'role' = 'staff' then coalesce((p->>'remaining')::integer, default_balance) end as balance) v
    on conflict (event_id, role, identifier_type, lower(identifier)) do nothing;
  get diagnostics added = row_count;
  return added;
end;
$$;

create function public.drink_pass_stock(p_action text, p_values jsonb, p_event uuid default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  scope_id uuid := drink_pass.event_id(p_event);
  drink_id uuid := (p_values->>'id')::uuid;
  bottles integer := (p_values->>'stock')::integer;
  enabled boolean := (p_values->>'enabled')::boolean;
begin
  if not exists (select 1 from drink_pass.operators where user_id = auth.uid() and role in ('admin', 'bartender')) then
    raise exception using message = 'Admin or bartender access required.', errcode = '42501';
  end if;
  if p_action = 'add' then
    insert into drink_pass.drinks (event_id, name, stock) values (scope_id, btrim(p_values->>'name'), bottles)
      on conflict (event_id, lower(name)) do nothing;
    return found;
  elsif p_action = 'set' then
    update drink_pass.drinks set stock = bottles where event_id = scope_id and id = drink_id;
  elsif p_action = 'restock' and bottles > 0 then
    update drink_pass.drinks set stock = stock + bottles where event_id = scope_id and id = drink_id;
  elsif p_action = 'enable' and enabled is not null then
    update drink_pass.drinks set paused = not enabled where event_id = scope_id and id = drink_id and (not enabled or stock > 0);
  else
    raise exception 'Invalid stock update.';
  end if;
  if not found then raise exception 'This drink is unavailable or out of stock.'; end if;
  return true;
end;
$$;

revoke all on function public.drink_pass_state(text, uuid, uuid),
  public.drink_pass_register(jsonb, uuid, uuid, uuid), public.drink_pass_voucher(uuid, text, uuid, uuid),
  public.drink_pass_redeem(uuid, uuid), public.drink_pass_approve(jsonb, uuid),
  public.drink_pass_stock(text, jsonb, uuid), public.drink_pass_create_event(uuid, text, date, integer)
  from public, anon, authenticated;
grant execute on function public.drink_pass_state(text, uuid, uuid),
  public.drink_pass_register(jsonb, uuid, uuid, uuid), public.drink_pass_voucher(uuid, text, uuid, uuid)
  to anon, authenticated;
grant execute on function public.drink_pass_redeem(uuid, uuid), public.drink_pass_approve(jsonb, uuid),
  public.drink_pass_stock(text, jsonb, uuid), public.drink_pass_create_event(uuid, text, date, integer)
  to authenticated;

commit;
