// Copied into a generated http-action project by e2e.test.ts and run there, after `npm test`.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { connect, text } from '../dist/test/client.js';

const received = [];
const target = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
});
await new Promise((resolve) => target.listen(Number(process.env.E2E_PORT), '127.0.0.1', resolve));
const client = await connect({ HTTP_ALLOWED_HOSTS: '127.0.0.1' });
// The runtime allowlist replaces the generated one; 127.0.0.1 is not on it here.
const elsewhere = await connect({ HTTP_ALLOWED_HOSTS: 'api.example.com' });
after(async () => {
  await client.close();
  await elsewhere.close();
  target.closeAllConnections();
  target.close();
});

test('GET encodes path params and puts the rest in the query string', async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.find((t) => t.name === 'get_item').annotations?.readOnlyHint, true);
  const result = await client.callTool({ name: 'get_item', arguments: { id: 'a b/c?d', expand: 'full' } });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(received.at(-1), { method: 'GET', url: '/items/a%20b%2Fc%3Fd?expand=full', body: '' });
});

test('POST sends non-path params as the JSON body', async () => {
  const result = await client.callTool({ name: 'add_note', arguments: { id: '7', note: 'hi', urgent: true } });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(received.at(-1), { method: 'POST', url: '/items/7/notes', body: '{"note":"hi","urgent":true}' });
});

test('dot segments and hosts off the allowlist are refused without a request', async () => {
  const before = received.length;
  assert.match(text(await client.callTool({ name: 'get_item', arguments: { id: '..' } })), /^INVALID_PARAM:/);
  assert.match(text(await elsewhere.callTool({ name: 'get_item', arguments: { id: '1' } })), /^HOST_NOT_ALLOWED:/);
  assert.equal(received.length, before);
});
