// Copied into a generated database-query project by e2e.test.ts after add-tool, and run there.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { connect, text } from '../dist/test/client.js';

const client = await connect();
after(() => client.close());

test('add-tool tools are listed, and an unimplemented custom tool is an error result', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['query', 'list_tables', 'describe_table', 'count_rows', 'later']);
  for (let i = 0; i < 2; i++) {
    const result = await client.callTool({ name: 'later', arguments: { id: 1 } });
    assert.equal(result.isError, true);
    assert.match(text(result), /^NOT_IMPLEMENTED:/);
  }
});
