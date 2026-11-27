import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const database = process.env.DRINK_PASS_TEST_DATABASE_URL;
if (!database) throw new Error('Set DRINK_PASS_TEST_DATABASE_URL to a disposable database with the migrations applied.');

const url = new URL(database);
const env = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGSSLMODE: url.searchParams.get('sslmode') ?? 'prefer',
};
const psql = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
const execute = promisify(execFile);
async function query(sql, applicationName) {
  const { stdout } = await execute('psql', [...psql, '-c', sql], {
    env: { ...env, PGAPPNAME: applicationName },
    timeout: 12_000,
  });
  return stdout.trim();
}

const event = randomUUID();
const guest = randomUUID();
const card = randomUUID();
const drink = randomUUID();
const firstKey = randomBytes(32).toString('hex');
const secondKey = randomBytes(32).toString('hex');
const secondApplication = 'card-race-' + randomUUID();

function redeem(key) {
  return `select public.drink_pass_card_redeem('${key}', '${card}', '${drink}', '${randomUUID()}')->>'status';`;
}

await query(`
  insert into drink_pass.events (id, name, event_date, default_vouchers)
    values ('${event}', 'Concurrency test', current_date, 5);
  insert into drink_pass.card_events values ('${event}');
  insert into drink_pass.guests (id, event_id, full_name, identifier, identifier_type, department, role, allowance, remaining)
    values ('${guest}', '${event}', 'Test Guest', 'RACE', 'Staff ID', 'Test', 'staff', 5, 5);
  insert into drink_pass.cards (id, event_id, guest_id, card_type) values ('${card}', '${event}', '${guest}', 'blue');
  insert into drink_pass.card_drinks (id, event_id, name) values ('${drink}', '${event}', 'Tonic');
  insert into drink_pass.devices (event_id, label, bar, key_hash) values
    ('${event}', 'Phone A', 'Bar 1', '${firstKey}'), ('${event}', 'Phone B', 'Bar 2', '${secondKey}');
`);

const first = spawn('psql', psql, { env, stdio: ['pipe', 'pipe', 'inherit'] });
const firstExit = once(first, 'close');
const lines = createInterface({ input: first.stdout });
let second;
try {
  const result = Promise.race([
    once(lines, 'line').then(([status]) => status),
    firstExit.then(() => { throw new Error('The first database session closed early.'); }),
  ]);
  first.stdin.write(`begin; ${redeem(firstKey)}\n`);
  assert.equal(await result, 'accepted');

  second = query(redeem(secondKey), secondApplication);
  second.catch(() => {}); // The main task awaits it after releasing the first transaction.
  const deadline = Date.now() + 6000;
  let blocked = false;
  while (!blocked && Date.now() < deadline) {
    blocked = await query(`select exists (
      select 1 from pg_stat_activity where application_name = '${secondApplication}' and wait_event_type = 'Lock'
    );`) === 't';
    if (!blocked) await delay(40);
  }
  assert.ok(blocked, 'The second connection should wait for the first transaction');
  first.stdin.end('commit;\n');
  assert.equal((await firstExit)[0], 0);
  assert.equal(await second, 'already_redeemed');
  assert.equal(await query(`select count(*) from drink_pass.redemptions where guest_id = '${guest}' and status = 'accepted';`), '1');
  assert.equal(await query(`select public.drink_pass_card_lookup('${firstKey}', '${card}')->>'drinksLeft';`), '4');
  console.log('Passed: two overlapping requests recorded exactly one drink.');
} finally {
  first.stdin.end();
  await firstExit;
  await second?.catch(() => {});
  await query(`
    delete from drink_pass.redemptions where event_id = '${event}';
    delete from drink_pass.devices where event_id = '${event}';
    delete from drink_pass.cards where event_id = '${event}';
    delete from drink_pass.card_drinks where event_id = '${event}';
    delete from drink_pass.guests where event_id = '${event}';
    delete from drink_pass.card_events where event_id = '${event}';
    delete from drink_pass.events where id = '${event}';
  `);
}
