import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { connect, text } from './client.js';

const client = await connect();
after(() => client.close());

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, text(result));
  return JSON.parse(text(result));
}

test('lists both tools with read-only annotations', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['csv_to_json', 'json_to_csv']);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true);
});

test('CSV -> JSON -> CSV round-trips quoted fields', async () => {
  const csv = 'id,name,note\n1,"Smith, Jo","says ""hi"""\n2,Lee,"two\nlines"\n';
  const { rows } = await call('csv_to_json', { csv });
  assert.deepEqual(rows, [
    { id: '1', name: 'Smith, Jo', note: 'says "hi"' },
    { id: '2', name: 'Lee', note: 'two\nlines' },
  ]);
  assert.equal((await call('json_to_csv', { rows })).csv, csv);
});

test('delimiter, header=false, CRLF and non-string values', async () => {
  const { rows } = await call('csv_to_json', { csv: 'a;b\r\n"x;y";\r\n', delimiter: ';', header: false });
  assert.deepEqual(rows, [['a', 'b'], ['x;y', '']]);
  const { csv } = await call('json_to_csv', { rows: [{ n: 1, ok: true }, { n: null, extra: 'z' }] });
  assert.equal(csv, 'n,ok,extra\n1,true,\n,,z\n');
});

test('malformed input returns a validation error and the server stays up', async () => {
  for (const [args, pattern] of [
    [{ csv: 'a,b\n1,2,3\n' }, /^INVALID_CSV: row 2: expected 2 fields, got 3/],
    [{ csv: 'a\n"open\n' }, /^INVALID_CSV: row 2: unterminated quoted field/],
    [{ csv: 'a\nx"y\n' }, /^INVALID_CSV: row 2: quote inside an unquoted field/],
    [{ csv: 'a,a\n1,2\n' }, /^INVALID_CSV: row 1: duplicate column name/],
    [{ csv: 42 }, /Input validation error/],
    [{ csv: 'a', delimiter: '"' }, /Input validation error/],
  ] as const) {
    const bad = await client.callTool({ name: 'csv_to_json', arguments: args });
    assert.equal(bad.isError, true);
    assert.match(text(bad), pattern);
  }
  const nested = await client.callTool({ name: 'json_to_csv', arguments: { rows: [{ a: { b: 1 } }] } });
  assert.match(text(nested), /Input validation error/);
  assert.deepEqual(await call('csv_to_json', { csv: 'a\n1\n' }), { rows: [{ a: '1' }] });
});
