begin;

create schema drink_pass;
revoke all on schema drink_pass from public, anon, authenticated;

create table drink_pass.operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'bartender')),
  label text not null check (btrim(label) <> '')
);

create table drink_pass.guests (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (btrim(full_name) <> ''),
  identifier text not null check (btrim(identifier) <> ''),
  identifier_type text not null check (identifier_type in ('Staff ID', 'Phone number', 'Personal ID')),
  department text not null check (btrim(department) <> ''),
  role text not null check (role in ('staff', 'manager')),
  allowance integer,
  remaining integer,
  invite uuid not null unique default gen_random_uuid(),
  session_hash text unique,
  check ((role = 'manager' and allowance is null and remaining is null) or
         (role = 'staff' and allowance is not null and remaining is not null and remaining between 0 and allowance))
);
create unique index guests_identifier on drink_pass.guests (role, identifier_type, lower(identifier));

create table drink_pass.drinks (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  stock integer not null check (stock >= 0),
  paused boolean not null default false
);
create unique index drinks_name on drink_pass.drinks (lower(name));

create table drink_pass.vouchers (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid not null references drink_pass.guests(id),
  drink_id uuid not null references drink_pass.drinks(id),
  expires_at timestamptz not null default (now() + interval '2 minutes'),
  status text not null default 'open' check (status in ('open', 'cancelled', 'expired', 'redeemed'))
);
create unique index vouchers_one_open on drink_pass.vouchers (guest_id) where status = 'open';

create table drink_pass.orders (
  id uuid primary key references drink_pass.vouchers(id),
  guest_id uuid not null references drink_pass.guests(id),
  guest_name text not null,
  drink text not null,
  scanned_at timestamptz not null,
  remaining integer,
  bartender text not null
);

alter table drink_pass.operators enable row level security;
alter table drink_pass.guests enable row level security;
alter table drink_pass.drinks enable row level security;
alter table drink_pass.vouchers enable row level security;
alter table drink_pass.orders enable row level security;

insert into drink_pass.drinks (name, stock)
values ('Ginger beer', 24), ('Sparkling water', 18), ('Passion juice', 18);

create function drink_pass.session_hash(session_id uuid)
returns text language sql immutable strict set search_path = '' as $$
  select encode(sha256(convert_to(session_id::text, 'UTF8')), 'hex');
$$;

create function drink_pass.guest_json(g drink_pass.guests, show_invite boolean)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', g.id, 'fullName', g.full_name, 'identifier', g.identifier,
    'identifierType', g.identifier_type, 'department', g.department, 'role', g.role,
    'allowance', g.allowance, 'remaining', g.remaining,
    'invite', case when show_invite and g.session_hash is null then g.invite end);
$$;

create function drink_pass.order_json(o drink_pass.orders)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', o.id, 'guest', jsonb_build_object('fullName', o.guest_name),
    'drink', o.drink, 'scannedAt', extract(epoch from o.scanned_at) * 1000,
    'remaining', o.remaining, 'bartender', o.bartender);
$$;

create function drink_pass.voucher_json(v drink_pass.vouchers, o drink_pass.orders)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', v.id, 'guestId', v.guest_id, 'drinkId', v.drink_id, 'status', v.status,
    'expiresAt', extract(epoch from v.expires_at) * 1000,
    'order', case when o.id is not null then drink_pass.order_json(o) end);
$$;

create function public.drink_pass_state(p_role text, p_session uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  guest drink_pass.guests;
  guests jsonb;
  vouchers jsonb;
  orders jsonb;
begin
  if p_role in ('admin', 'bartender') then
    if not exists (
      select 1 from drink_pass.operators where user_id = auth.uid() and role = p_role
    ) then
      raise exception using message = 'This account does not have access to this role.', errcode = '42501';
    end if;

    if p_role = 'admin' then
      select jsonb_agg(drink_pass.guest_json(g, true) order by g.full_name, g.id)
        into guests from drink_pass.guests g;
      select jsonb_agg(drink_pass.order_json(o) order by o.scanned_at desc, o.id)
        into orders from drink_pass.orders o;
    end if;
  elsif p_role in ('staff', 'manager') then
    select * into guest from drink_pass.guests
      where role = p_role and session_hash = drink_pass.session_hash(p_session);
    if found then
      guests := jsonb_build_array(drink_pass.guest_json(guest, false));
      select jsonb_object_agg(v.id, drink_pass.voucher_json(v, o))
        into vouchers from drink_pass.vouchers v
        left join drink_pass.orders o on o.id = v.id
        where v.guest_id = guest.id;
    end if;
  else
    raise exception 'Unknown Drink Pass role.';
  end if;

  return jsonb_build_object(
    'guests', coalesce(guests, '[]'::jsonb),
    'drinks', case when p_role in ('admin', 'bartender') or guest.id is not null then
      coalesce((select jsonb_agg(to_jsonb(d) order by d.name, d.id) from drink_pass.drinks d), '[]'::jsonb)
      else '[]'::jsonb end,
    'vouchers', coalesce(vouchers, '{}'::jsonb),
    'orders', coalesce(orders, '[]'::jsonb),
    'sessions', case when guest.id is null then '{}'::jsonb else jsonb_build_object(p_role, guest.id) end);
end;
$$;

create function public.drink_pass_register(p_profile jsonb, p_invite uuid, p_session uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  claimed uuid;
begin
  if p_invite is null or p_session is null then return false; end if;
  update drink_pass.guests
    set session_hash = drink_pass.session_hash(p_session)
    where invite = p_invite
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

create function public.drink_pass_voucher(p_session uuid, p_action text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  guest drink_pass.guests;
  voucher drink_pass.vouchers;
  existing_id uuid;
begin
  select * into guest from drink_pass.guests
    where session_hash = drink_pass.session_hash(p_session) for update;
  if not found then return null; end if;

  if p_action = 'cancel' then
    update drink_pass.vouchers set status = 'cancelled'
      where id = p_id and guest_id = guest.id and status = 'open' and expires_at > clock_timestamp();
    return (select to_jsonb(v.status) from drink_pass.vouchers v where v.id = p_id and v.guest_id = guest.id);
  end if;

  if p_action <> 'open' or p_action is null then raise exception 'Unknown voucher action.'; end if;
  if guest.remaining = 0 or not exists (
    select 1 from drink_pass.drinks where id = p_id and stock > 0 and not paused
  ) then return null; end if;

  select id into existing_id from drink_pass.vouchers
    where guest_id = guest.id and status = 'open' and drink_id = p_id and expires_at > clock_timestamp();
  if found then
    select * into voucher from drink_pass.vouchers where id = existing_id;
  else
    update drink_pass.vouchers
      set status = case when expires_at <= clock_timestamp() then 'expired' else 'cancelled' end
      where guest_id = guest.id and status = 'open';
    insert into drink_pass.vouchers (guest_id, drink_id, expires_at)
      values (guest.id, p_id, clock_timestamp() + interval '2 minutes') returning * into voucher;
  end if;
  return drink_pass.voucher_json(voucher, null::drink_pass.orders);
end;
$$;

create function public.drink_pass_redeem(p_voucher uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
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

  select guest_id into linked_guest from drink_pass.vouchers where id = p_voucher;
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
  insert into drink_pass.orders (id, guest_id, guest_name, drink, scanned_at, remaining, bartender)
    values (voucher.id, guest.id, guest.full_name, drink_name, scan_time, guest.remaining, operator_label)
    returning * into served;
  update drink_pass.vouchers set status = 'redeemed' where id = voucher.id;
  return jsonb_build_object('status', 'accepted', 'order', drink_pass.order_json(served));
end;
$$;

create function public.drink_pass_approve(p_profiles jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  added integer;
begin
  if not exists (select 1 from drink_pass.operators where user_id = auth.uid() and role = 'admin') then
    raise exception using message = 'Admin access required.', errcode = '42501';
  end if;
  insert into drink_pass.guests (full_name, identifier, identifier_type, department, role, allowance, remaining)
    select btrim(p->>'fullName'), btrim(p->>'identifier'), p->>'identifierType', btrim(p->>'department'),
      p->>'role', balance, balance
    from jsonb_array_elements(p_profiles) p
    cross join lateral (select case when p->>'role' = 'staff' then (p->>'remaining')::integer end as balance) v
    on conflict (role, identifier_type, lower(identifier)) do nothing;
  get diagnostics added = row_count;
  return added;
end;
$$;

create function public.drink_pass_stock(p_action text, p_values jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  drink_id uuid := (p_values->>'id')::uuid;
  bottles integer := (p_values->>'stock')::integer;
  enabled boolean := (p_values->>'enabled')::boolean;
begin
  if not exists (select 1 from drink_pass.operators where user_id = auth.uid() and role in ('admin', 'bartender')) then
    raise exception using message = 'Admin or bartender access required.', errcode = '42501';
  end if;
  if p_action = 'add' then
    insert into drink_pass.drinks (name, stock) values (btrim(p_values->>'name'), bottles)
      on conflict (lower(name)) do nothing;
    return found;
  elsif p_action = 'set' then
    update drink_pass.drinks set stock = bottles where id = drink_id;
  elsif p_action = 'restock' and bottles > 0 then
    update drink_pass.drinks set stock = stock + bottles where id = drink_id;
  elsif p_action = 'enable' and enabled is not null then
    update drink_pass.drinks set paused = not enabled where id = drink_id and (not enabled or stock > 0);
  else
    raise exception 'Invalid stock update.';
  end if;
  if not found then raise exception 'This drink is unavailable or out of stock.'; end if;
  return true;
end;
$$;

revoke all on function public.drink_pass_state(text, uuid), public.drink_pass_register(jsonb, uuid, uuid),
  public.drink_pass_voucher(uuid, text, uuid), public.drink_pass_redeem(uuid),
  public.drink_pass_approve(jsonb), public.drink_pass_stock(text, jsonb) from public, anon, authenticated;
grant execute on function public.drink_pass_state(text, uuid), public.drink_pass_register(jsonb, uuid, uuid),
  public.drink_pass_voucher(uuid, text, uuid) to anon, authenticated;
grant execute on function public.drink_pass_redeem(uuid), public.drink_pass_approve(jsonb),
  public.drink_pass_stock(text, jsonb) to authenticated;

commit;
