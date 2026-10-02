// Copied into a generated database-query project by e2e.test.ts and run there, after `npm test`.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { connect, text } from '../dist/test/client.js';

const url = process.env.DATABASE_URL;
const table = process.env.E2E_TABLE;
const skip = url ? false : 'set DATABASE_URL (a scratch database) to run the database tests';
const admin = new pg.Client({ connectionString: url });
const client = await connect(url ? { DATABASE_URL: url } : {});

before(async () => {
  if (skip) return;
  await admin.connect();
  await admin.query(`CREATE TABLE ${table} (id int PRIMARY KEY, total int)`);
  await admin.query(`INSERT INTO ${table} VALUES (1, 10), (2, 20)`);
});
after(async () => {
  await client.close();
  if (skip) return;
  await admin.query(`DROP TABLE IF EXISTS ${table}`);
  await admin.end();
});

test('get_order binds the id and returns the row', { skip }, async () => {
  const result = await client.callTool({ name: 'get_order', arguments: { id: 2 } });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(JSON.parse(text(result)).rows, [{ id: 2, total: 20 }]);
  const bad = await client.callTool({ name: 'get_order', arguments: { id: '2 OR 1=1' } });
  assert.match(text(bad), /Input validation error/);
});

test('a write in a sql tool is rejected in read-only mode', { skip }, async () => {
  const result = await client.callTool({ name: 'zero_order', arguments: { id: 1 } });
  assert.match(text(result), /^READ_ONLY:/);
  assert.deepEqual((await admin.query(`SELECT total FROM ${table} WHERE id = 1`)).rows, [{ total: 10 }]);
});
