import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { TOOLS } from '../src/tools.js';
import { connect, text } from './client.js';

// The database tests need DATABASE_URL pointing at a scratch database. They create one
// uniquely named table and drop it again.
const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL (a scratch database) to run the database tests';
const GENERIC_TOOLS: string = {{genericTools|json}};
// Tests that call the generic query tool, which genericTools=off leaves out.
const skipQuery = skip || (GENERIC_TOOLS === 'on' ? false : 'genericTools is off');
const table = `planitia_smoke_${process.pid}`;
const admin = new pg.Client({ connectionString: url });

// The MCP SDK passes only a safe subset of env vars to the server, so pass DATABASE_URL on.
const env: Record<string, string> = url ? { DATABASE_URL: url } : {};
// No allowlist here, whatever the server was generated with, so the tests can use their own table.
const client = await connect({ ...env, DB_ALLOWED_TABLES: '' });
// A second server whose table allowlist holds only the fixture table.
const allowlisted = await connect({ ...env, DB_ALLOWED_TABLES: `public.${table}` });

before(async () => {
  if (skip) return;
  await admin.connect();
  await admin.query(`CREATE TABLE public.${table} (id int PRIMARY KEY, name text)`);
  await admin.query(`INSERT INTO public.${table} VALUES (1, 'ada'), (2, 'grace')`);
});
after(async () => {
  await client.close();
  await allowlisted.close();
  if (skip) return;
  await admin.query(`DROP TABLE IF EXISTS public.${table}`);
  await admin.end();
});

const query = (c: typeof client, sql: string, params: unknown[] = []) => c.callTool({ name: 'query', arguments: { sql, params } });
const count = async () => (await admin.query(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n;

test('lists the built-in tools as read-only, plus any spec-defined tools', async () => {
  const { tools } = await client.listTools();
  const builtins = [...(GENERIC_TOOLS === 'on' ? ['query'] : []), 'list_tables', 'describe_table'];
  assert.deepEqual(tools.map((t) => t.name), [...builtins, ...TOOLS.map((t) => t.name)]);
  for (const t of tools.slice(0, builtins.length)) {
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.equal(t.annotations?.destructiveHint, false, t.name);
  }
});

const call = (c: typeof client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args });

test('list_tables lists visible tables, filtered by the allowlist', { skip }, async () => {
  const all = JSON.parse(text(await call(client, 'list_tables'))).tables;
  assert.ok(all.includes(`public.${table}`), all.join(', '));
  assert.ok(!all.some((t: string) => t.startsWith('pg_catalog.')));
  assert.deepEqual(JSON.parse(text(await call(allowlisted, 'list_tables'))), { tables: [`public.${table}`] });
});

test('describe_table returns columns and primary key, and keeps to the allowlist', { skip }, async () => {
  const result = await call(allowlisted, 'describe_table', { table: `public.${table}` });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(JSON.parse(text(result)), {
    table: `public.${table}`,
    columns: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'name', type: 'text', nullable: true },
    ],
    primaryKey: ['id'],
  });
  assert.match(text(await call(allowlisted, 'describe_table', { table: 'pg_catalog.pg_class' })), /^TABLE_NOT_ALLOWED:/);
  assert.match(text(await call(client, 'describe_table', { table: 'public.no_such_table' })), /^NOT_FOUND:/);
  assert.match(text(await call(client, 'describe_table', { table: 'no dot' })), /Input validation error/);
});

test('runs a parameterized SELECT', { skip: skipQuery }, async () => {
  const result = await query(client, `SELECT id, name FROM ${table} WHERE name = $1`, ['grace']);
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(JSON.parse(text(result)), { rowCount: 1, fields: ['id', 'name'], rows: [{ id: 2, name: 'grace' }] });
});

test('read-only mode rejects writes, and the data is unchanged', { skip: skipQuery }, async () => {
  for (const sql of [
    `INSERT INTO ${table} VALUES (3, 'x')`,
    `UPDATE ${table} SET name = 'x'`,
    `DELETE FROM ${table}`,
    `CREATE TABLE ${table}_new (id int)`,
    `WITH gone AS (DELETE FROM ${table} RETURNING id) SELECT count(*) FROM gone`,
  ]) {
    const result = await query(client, sql);
    assert.equal(result.isError, true, sql);
    assert.match(text(result), /^READ_ONLY:/, sql);
  }
  assert.equal(await count(), 2);
});

test('only one statement runs per call', { skip: skipQuery }, async () => {
  const result = await query(client, `SELECT 1; DELETE FROM ${table}`);
  assert.equal(result.isError, true);
  assert.match(text(result), /^DB_ERROR: 42601 cannot insert multiple commands/);
  assert.equal(await count(), 2);
});

test('the table allowlist rejects other tables', { skip: skipQuery }, async () => {
  const ok = await query(allowlisted, `SELECT count(*)::int AS n FROM ${table}`);
  assert.deepEqual(JSON.parse(text(ok)).rows, [{ n: 2 }]);
  const other = await query(allowlisted, 'SELECT relname FROM pg_class LIMIT 1');
  assert.match(text(other), /^TABLE_NOT_ALLOWED: not on the allowlist: pg_catalog\.pg_class/);
  const ddl = await query(allowlisted, `TRUNCATE ${table}`);
  assert.match(text(ddl), /^TABLE_NOT_ALLOWED: only statements Postgres can EXPLAIN/);
});

test('invalid input and SQL errors are error results, and the server stays up', { skip: skipQuery }, async () => {
  const bad = await client.callTool({ name: 'query', arguments: { sql: 42 } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /Input validation error/);
  assert.match(text(await query(client, 'SELECT * FROM no_such_table')), /^DB_ERROR: 42P01/);
  const again = await query(client, 'SELECT $1::int + 1 AS n', [41]);
  assert.deepEqual(JSON.parse(text(again)).rows, [{ n: 42 }]);
});
