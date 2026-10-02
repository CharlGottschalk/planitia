import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { connect, text } from './client.js';

const client = await connect();
after(() => client.close());

test('lists both tools with read-only annotations', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['validate', 'validate_json_schema']);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true);
});

test('validate checks the built-in schema and reports failing paths', async () => {
  const ok = await client.callTool({ name: 'validate', arguments: { payload: { email: 'a@example.com', age: 30 } } });
  assert.deepEqual(JSON.parse(text(ok)), { valid: true, errors: [] });
  const bad = JSON.parse(text(await client.callTool({ name: 'validate', arguments: { payload: { email: 'nope', age: -1 } } })));
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.errors.map((e: { path: string }) => e.path).sort(), ['/age', '/email']);
});

test('validate_json_schema checks a schema sent with the call', async () => {
  const schema = { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } };
  const ok = await client.callTool({ name: 'validate_json_schema', arguments: { schema, payload: { id: 1 } } });
  assert.deepEqual(JSON.parse(text(ok)), { valid: true, errors: [] });
  const bad = JSON.parse(text(await client.callTool({ name: 'validate_json_schema', arguments: { schema, payload: { id: 'x' } } })));
  assert.deepEqual(bad.errors.map((e: { path: string }) => e.path), ['/id']);
});

test('invalid tool input returns an error result and the server stays up', async () => {
  const bad = await client.callTool({ name: 'validate_json_schema', arguments: { schema: 'not an object', payload: 1 } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /Input validation error/);
  const broken = await client.callTool({ name: 'validate_json_schema', arguments: { schema: { type: 'nonsense' }, payload: 1 } });
  assert.equal(broken.isError, true);
  assert.match(text(broken), /^INVALID_SCHEMA:/);
  const again = await client.callTool({ name: 'validate', arguments: { payload: { email: 'a@example.com', age: 1 } } });
  assert.equal(again.isError, undefined);
});
