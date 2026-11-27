begin;

do $test$
declare
  admin_id uuid := gen_random_uuid();
  bartender_id uuid := gen_random_uuid();
  first_event uuid := gen_random_uuid();
  second_event uuid := gen_random_uuid();
  first_guest uuid;
  card_id uuid := gen_random_uuid();
  tonic_id uuid;
  device_hash text := repeat('e', 64);
  rehearsal jsonb;
  state jsonb;
  profiles jsonb := '[
    {"fullName":"Staff Guest","identifier":"E-STF","identifierType":"Staff ID","department":"Test","role":"staff"},
    {"fullName":"Manager Guest","identifier":"E-MGR","identifierType":"Staff ID","department":"Test","role":"manager"}
  ]';
begin
  insert into auth.users (id, email)
    values (admin_id, admin_id || '@example.invalid'), (bartender_id, bartender_id || '@example.invalid');
  insert into drink_pass.operators (user_id, role, label)
    values (admin_id, 'admin', 'Test admin'), (bartender_id, 'bartender', 'Rehearsal bartender');

  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  rehearsal := public.drink_pass_state('admin');
  if rehearsal->'event'->>'isDefault' is distinct from 'true' then
    raise exception 'Old operator links must still resolve to the rehearsal';
  end if;

  if has_function_privilege('anon', 'public.drink_pass_state(text,uuid,uuid)', 'execute')
     or to_regprocedure('public.drink_pass_register(jsonb,uuid,uuid,uuid)') is not null
     or to_regprocedure('public.drink_pass_voucher(uuid,text,uuid,uuid)') is not null
     or to_regprocedure('public.drink_pass_reset_invite(uuid,uuid)') is not null then
    raise exception 'Retired guest APIs are still callable';
  end if;
  begin
    perform public.drink_pass_state('staff');
    raise exception 'Staff mode is still available';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.drink_pass_state('manager');
    raise exception 'Manager mode is still available';
  exception when insufficient_privilege then null;
  end;

  if public.drink_pass_create_event(first_event, 'Cards A', current_date, 5)->>'usesCards' is distinct from 'true' then
    raise exception 'New events must use physical cards';
  end if;
  perform public.drink_pass_create_event(first_event, 'Cards A', current_date, 5);
  perform public.drink_pass_create_event(second_event, 'Cards B', current_date, 5);
  state := public.drink_pass_state('admin', p_event => first_event);
  if state->'orders' <> '[]'::jsonb or state->'guests' <> '[]'::jsonb or state->'drinks' <> '[]'::jsonb
    or (select count(*) from jsonb_array_elements(state->'events') e where e->>'id' = first_event::text) <> 1 then
    raise exception 'New events must be empty and creation must be idempotent';
  end if;

  if public.drink_pass_approve(profiles, first_event) <> 2
     or public.drink_pass_approve(profiles, second_event) <> 2
     or public.drink_pass_approve(profiles, first_event) <> 0 then
    raise exception 'Admin must manage staff and manager guests independently per event';
  end if;

  perform public.drink_pass_card_menu('add', '{"name":"Tonic"}', first_event);
  perform public.drink_pass_card_menu('add', '{"name":"Lime"}', second_event);
  state := public.drink_pass_state('admin', p_event => first_event);
  tonic_id := (state->'drinks'->0->>'id')::uuid;
  if tonic_id is null or state->'drinks'->0 ? 'stock' or state->'drinks'->0->>'active' is distinct from 'true'
    or exists (select 1 from jsonb_array_elements(state->'guests') g where g ? 'invite')
    or state->'guests'->0->>'remaining' is not null or state->'guests'->1->>'remaining' is distinct from '5' then
    raise exception 'Card event Admin state must show a stock-free menu, balances and no invitation codes';
  end if;

  perform public.drink_pass_card_menu('enable', jsonb_build_object('id', tonic_id, 'enabled', false), first_event);
  if public.drink_pass_state('admin', p_event => first_event)->'drinks'->0->>'active' is distinct from 'false' then
    raise exception 'Admin could not disable a card-menu drink';
  end if;
  perform public.drink_pass_card_menu('enable', jsonb_build_object('id', tonic_id, 'enabled', true), first_event);

  first_guest := (state->'guests'->1->>'id')::uuid;
  insert into drink_pass.cards (id, event_id, guest_id, card_type) values (card_id, first_event, first_guest, 'blue');
  insert into drink_pass.devices (event_id, label, bar, key_hash) values (first_event, 'Phone A', 'Bar 1', device_hash);
  if public.drink_pass_card_redeem(device_hash, card_id, tonic_id, gen_random_uuid())->>'status' is distinct from 'accepted' then
    raise exception 'Card redemption failed';
  end if;
  state := public.drink_pass_state('admin', p_event => first_event);
  if jsonb_array_length(state->'orders') <> 1
    or state->'orders'->0->'guest' is distinct from '{"fullName":"Staff Guest"}'::jsonb
    or state->'guests'->1->>'remaining' is distinct from '4' then
    raise exception 'Admin must see successful card orders and the resulting balance';
  end if;
  state := public.drink_pass_state('admin', p_event => second_event);
  if state->'orders' <> '[]'::jsonb or state->'drinks'->0->>'name' is distinct from 'Lime'
    or state->'guests'->1->>'remaining' is distinct from '5' then
    raise exception 'Card activity changed another event';
  end if;
  if public.drink_pass_state('admin')->'orders' is distinct from rehearsal->'orders'
     or exists (select 1 from drink_pass.vouchers where status = 'open') then
    raise exception 'Rehearsal order history must survive and outstanding digital vouchers must be retired';
  end if;

  perform set_config('request.jwt.claim.sub', bartender_id::text, true);
  perform public.drink_pass_state('bartender');
  begin
    perform public.drink_pass_state('bartender', p_event => first_event);
    raise exception 'Web bartender must use Flutter for card events';
  exception when insufficient_privilege then null;
  end;
end;
$test$;

rollback;
