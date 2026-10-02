import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { connect, text } from './client.js';

const client = await connect();
after(() => client.close());

test('lists the greet tool as read-only', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['greet']);
  assert.equal(tools[0].annotations?.readOnlyHint, true);
});

test('greet returns a message, and invalid input is an error result', async () => {
  const ok = await client.callTool({ name: 'greet', arguments: { name: 'Ada' } });
  assert.match(JSON.parse(text(ok)).message, /, Ada!$/);
  const bad = await client.callTool({ name: 'greet', arguments: { name: '' } });
  assert.equal(bad.isError, true);
});
