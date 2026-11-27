begin;

do $test$
<<card_redemption>>
declare
  event_id uuid := gen_random_uuid();
  other_event uuid := gen_random_uuid();
  staff_id uuid := gen_random_uuid();
  empty_id uuid := gen_random_uuid();
  manager_id uuid := gen_random_uuid();
  staff_card uuid := gen_random_uuid();
  new_card uuid := gen_random_uuid();
  empty_card uuid := gen_random_uuid();
  manager_card uuid := gen_random_uuid();
  first_device uuid := gen_random_uuid();
  second_device uuid := gen_random_uuid();
  inactive_device uuid := gen_random_uuid();
  request_id uuid := gen_random_uuid();
  first_hash text := repeat('a', 64);
  second_hash text := repeat('b', 64);
  response jsonb;
  served jsonb;
begin
  insert into drink_pass.events (id, name, event_date, default_vouchers) values
    (event_id, 'Card test', current_date, 5), (other_event, 'Other card test', current_date, 5);
  insert into drink_pass.card_events (event_id) values (event_id), (other_event);
  insert into drink_pass.guests (id, event_id, full_name, identifier, identifier_type, department, role, allowance, remaining)
  values (staff_id, event_id, 'Test Staff', 'staff', 'Staff ID', 'Test', 'staff', 5, 5),
    (empty_id, event_id, 'Empty Guest', 'empty', 'Staff ID', 'Test', 'staff', 0, 0),
    (manager_id, event_id, 'Test Manager', 'manager', 'Staff ID', 'Test', 'manager', null, null);
  insert into drink_pass.cards (id, event_id, guest_id, card_type) values
    (staff_card, event_id, staff_id, 'blue'), (empty_card, event_id, empty_id, 'blue'),
    (manager_card, event_id, manager_id, 'gold');
  insert into drink_pass.devices (id, event_id, label, bartender_name, bar, key_hash, active) values
    (first_device, event_id, 'Phone A', 'Amina', 'Bar 1', first_hash, true),
    (second_device, event_id, 'Phone B', 'Brian', 'Bar 2', second_hash, true),
    (inactive_device, event_id, 'Phone C', 'Cara', 'Bar 2', repeat('c', 64), false);

  response := public.drink_pass_card_lookup(first_hash, staff_card);
  if response->>'status' is distinct from 'eligible'
     or response->>'drinksLeft' is distinct from '5'
     or response->>'name' is distinct from 'Test Staff'
     or response ? 'drinks' or response->>'staffId' is distinct from 'staff'
     or exists (select 1 from drink_pass.redemptions r where r.event_id = card_redemption.event_id) then
    raise exception 'Lookup must show guest identity and balance without recording anything';
  end if;

  if public.drink_pass_card_redeem(repeat('d', 64), staff_card, gen_random_uuid())->>'status' is distinct from 'unknown_device'
     or public.drink_pass_card_redeem(repeat('c', 64), staff_card, gen_random_uuid())->>'status' is distinct from 'unknown_device'
     or public.drink_pass_card_redeem(first_hash, null, gen_random_uuid())->>'status' is distinct from 'invalid_signature'
     or public.drink_pass_card_redeem(first_hash, gen_random_uuid(), gen_random_uuid())->>'status' is distinct from 'card_not_found'
     or public.drink_pass_card_redeem(first_hash, empty_card, gen_random_uuid())->>'status' is distinct from 'no_drinks_left' then
    raise exception 'Expected clear refusal reasons for invalid inputs';
  end if;

  served := public.drink_pass_card_redeem(first_hash, staff_card, request_id);
  if served->>'status' is distinct from 'accepted' or served->>'drinksLeft' is distinct from '4'
     or served ? 'drink' or served->>'staffId' is distinct from 'staff'
     or served->>'role' is distinct from 'staff' or served->>'bartender' is distinct from 'Amina'
     or not exists (select 1 from drink_pass.redemptions r where r.card_id = staff_card
        and r.status = 'accepted' and r.drink_id is null and r.server_timestamp = (served->>'servedAt')::timestamptz
        and r.server_timestamp between transaction_timestamp() and clock_timestamp()) then
    raise exception 'Successful redemption must deduct one drink and store the server timestamp';
  end if;
  if public.drink_pass_card_redeem(first_hash, staff_card, request_id) is distinct from served then
    raise exception 'Retry must return the original result';
  end if;
  if public.drink_pass_card_redeem(second_hash, staff_card, gen_random_uuid())->>'status' is distinct from 'cooldown_active' then
    raise exception 'Second bar must be refused during the cooldown';
  end if;
  if (select count(*) from drink_pass.redemptions r where r.card_id = staff_card and r.status = 'accepted') <> 1
     or not exists (select 1 from drink_pass.card_flags f where f.card_id = staff_card) then
    raise exception 'Expected exactly one successful redemption and a cross-bar flag';
  end if;

  update drink_pass.cards set status = 'replaced', voided_at = clock_timestamp() where id = staff_card;
  insert into drink_pass.cards (id, event_id, guest_id, card_type) values (new_card, event_id, staff_id, 'blue');
  if public.drink_pass_card_redeem(first_hash, staff_card, gen_random_uuid())->>'status' is distinct from 'card_voided'
     or public.drink_pass_card_lookup(first_hash, new_card)->>'drinksLeft' is distinct from '4'
     or public.drink_pass_card_redeem(first_hash, new_card, gen_random_uuid())->>'status' is distinct from 'cooldown_active' then
    raise exception 'Reissue must void the old QR and carry forward the allowance and cooldown';
  end if;

  if public.drink_pass_card_lookup(first_hash, manager_card)->>'drinksLeft' is not null
     or public.drink_pass_card_redeem(first_hash, manager_card, gen_random_uuid())->>'status' is distinct from 'accepted'
     or public.drink_pass_card_redeem(first_hash, manager_card, gen_random_uuid())->>'status' is distinct from 'cooldown_active' then
    raise exception 'Manager allowance must be uncapped while the cooldown still applies';
  end if;

  update drink_pass.redemptions r set server_timestamp = clock_timestamp() - interval '5 minutes'
    where r.card_id = manager_card and r.status = 'accepted';
  if public.drink_pass_card_redeem(first_hash, manager_card, gen_random_uuid())->>'status' is distinct from 'accepted' then
    raise exception 'Cooldown must expire after five minutes';
  end if;

  if has_function_privilege('anon', 'public.drink_pass_card_lookup(text,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.drink_pass_card_redeem(text,uuid,uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.drink_pass_card_redeem(text,uuid,uuid)', 'execute') then
    raise exception 'Card RPCs must be restricted to the backend';
  end if;
end;
$test$;

rollback;
