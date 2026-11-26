begin;

do $test$
declare
  admin_id uuid := gen_random_uuid();
  bartender_id uuid := gen_random_uuid();
  first_event uuid := gen_random_uuid();
  second_event uuid := gen_random_uuid();
  first_session uuid := gen_random_uuid();
  first_guest jsonb;
  second_guest jsonb;
  first_drink uuid;
  second_drink uuid;
  voucher_id uuid;
  legacy_state jsonb;
  state jsonb;
  profile jsonb := '{
    "fullName":"Event Isolation Guest", "identifier":"DP-EVENT-ISOLATION",
    "identifierType":"Staff ID", "department":"Development Test", "role":"staff"
  }';
begin
  insert into auth.users (id, email)
    values (admin_id, admin_id || '@example.invalid'), (bartender_id, bartender_id || '@example.invalid');
  insert into drink_pass.operators (user_id, role, label)
    values (admin_id, 'admin', 'Event isolation admin'), (bartender_id, 'bartender', 'Event isolation bartender');

  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  legacy_state := public.drink_pass_state('admin');
  if legacy_state->'event'->>'isDefault' is distinct from 'true' then
    raise exception 'Existing links must still select the rehearsal';
  end if;
  perform public.drink_pass_create_event(first_event, 'Isolation A', current_date, 3);
  perform public.drink_pass_create_event(first_event, 'Isolation A', current_date, 3);
  perform public.drink_pass_create_event(second_event, 'Isolation B', current_date, 2);

  state := public.drink_pass_state('admin', null, first_event);
  if state->'orders' <> '[]'::jsonb or state->'guests' <> '[]'::jsonb or state->'drinks' <> '[]'::jsonb
    or (select count(*) from jsonb_array_elements(state->'events') e where (e->>'id')::uuid = first_event) <> 1 then
    raise exception 'New events must be empty and a retried creation must be idempotent';
  end if;

  if public.drink_pass_approve(jsonb_build_array(profile), first_event) <> 1
    or public.drink_pass_approve(jsonb_build_array(profile), second_event) <> 1
    or public.drink_pass_approve(jsonb_build_array(profile), first_event) <> 0 then
    raise exception 'Guest deduplication must be limited to the selected event';
  end if;
  first_guest := public.drink_pass_state('admin', null, first_event)->'guests'->0;
  second_guest := public.drink_pass_state('admin', null, second_event)->'guests'->0;
  if first_guest->>'remaining' is distinct from '3' or second_guest->>'remaining' is distinct from '2'
    or first_guest->>'invite' = second_guest->>'invite' then
    raise exception 'Events must have their own allowances and invitations';
  end if;

  perform public.drink_pass_stock('add', '{"name":"Test tonic","stock":12}', first_event);
  perform public.drink_pass_stock('add', '{"name":"Test tonic","stock":8}', second_event);
  first_drink := (public.drink_pass_state('admin', null, first_event)->'drinks'->0->>'id')::uuid;
  second_drink := (public.drink_pass_state('admin', null, second_event)->'drinks'->0->>'id')::uuid;

  perform set_config('request.jwt.claim.sub', '', true);
  if public.drink_pass_register(profile, (first_guest->>'invite')::uuid, first_session, second_event)
    or not public.drink_pass_register(profile, (first_guest->>'invite')::uuid, first_session, first_event) then
    raise exception 'The invitation must work only in its own event';
  end if;
  if public.drink_pass_voucher(first_session, 'open', second_drink, first_event) is not null then
    raise exception 'Voucher issuance must reject stock from another event';
  end if;

  voucher_id := (public.drink_pass_voucher(first_session, 'open', first_drink, first_event)->>'id')::uuid;
  if voucher_id is null then raise exception 'Voucher was not issued'; end if;

  perform set_config('request.jwt.claim.sub', bartender_id::text, true);
  begin
    perform public.drink_pass_create_event(gen_random_uuid(), 'Forbidden', current_date, 1);
    raise exception 'Bartender created an event';
  exception when insufficient_privilege then null;
  end;
  if public.drink_pass_redeem(voucher_id, second_event)->>'status' is distinct from 'invalid'
    or public.drink_pass_redeem(voucher_id, first_event)->>'status' is distinct from 'accepted'
    or public.drink_pass_redeem(voucher_id, first_event)->>'status' is distinct from 'used' then
    raise exception 'A voucher must redeem once, within its own event';
  end if;

  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  state := public.drink_pass_state('admin', null, first_event);
  if jsonb_array_length(state->'orders') <> 1
    or state->'orders'->0->'guest' is distinct from '{"fullName":"Event Isolation Guest"}'::jsonb
    or state->'drinks'->0->>'stock' is distinct from '11'
    or state->'guests'->0->>'remaining' is distinct from '2' then
    raise exception 'Redemption must create one name-only order and deduct one from guest and stock';
  end if;
  state := public.drink_pass_state('admin', null, second_event);
  if state->'orders' <> '[]'::jsonb or state->'drinks'->0->>'stock' is distinct from '8'
    or state->'guests'->0->>'remaining' is distinct from '2' then
    raise exception 'Redemption changed another event';
  end if;
  if public.drink_pass_state('admin')->'orders' is distinct from legacy_state->'orders' then
    raise exception 'Existing rehearsal orders changed';
  end if;
end;
$test$;

rollback;
