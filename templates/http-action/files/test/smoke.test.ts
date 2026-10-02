import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { TOOLS } from '../src/tools.js';
import { connect, text } from './client.js';

// A local target, so the test needs no network. It records every request it receives.
const received: { url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
const target = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push({ url: req.url, headers: req.headers, body });
    if (req.url?.startsWith('/get')) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ method: req.method, url: req.url }));
    else if (req.url === '/echo') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ got: JSON.parse(body) }));
    else if (req.url === '/fail') res.writeHead(500).end('boom');
    else if (req.url === '/redirect') res.writeHead(302, { location: 'https://elsewhere.example/' }).end();
    // /slow never answers, to exercise the timeout.
  });
});
await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;

const client = await connect({ HTTP_ALLOWED_HOSTS: '127.0.0.1', HTTP_ACTION_TOKEN: 'smoke-token', TOOL_TIMEOUT_MS: '1000' });
after(async () => {
  await client.close();
  target.closeAllConnections();
  target.close();
});

const post = (url: string, body: unknown = {}) => client.callTool({ name: 'http_post', arguments: { url, body } });
const get = (url: string) => client.callTool({ name: 'http_get', arguments: { url } });
const GENERIC_TOOLS: string = {{genericTools|json}};
// Tests that call the generic http_post tool, which genericTools=off leaves out.
const skipPost = GENERIC_TOOLS === 'on' ? false : 'genericTools is off';

test('lists http_post as destructive and http_get as read-only, plus any spec-defined tools', async () => {
  const { tools } = await client.listTools();
  const builtins = [...(GENERIC_TOOLS === 'on' ? ['http_post'] : []), 'http_get'];
  assert.deepEqual(tools.map((t) => t.name), [...builtins, ...TOOLS.map((t) => t.name)]);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  if (GENERIC_TOOLS === 'on') assert.deepEqual(byName.http_post, { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  assert.deepEqual(byName.http_get, { readOnlyHint: true, destructiveHint: false, openWorldHint: true });
});

test('http_get fetches with the auth header and keeps to the allowlist, https and no-redirect rules', async () => {
  const result = await get(`${base}/get?x=1`);
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(JSON.parse(text(result)), { status: 200, body: { method: 'GET', url: '/get?x=1' } });
  assert.equal(received.at(-1)!.headers.authorization, 'Bearer smoke-token');
  const before = received.length;
  assert.match(text(await get(base.replace('127.0.0.1', 'localhost') + '/get')), /^HOST_NOT_ALLOWED:/);
  assert.match(text(await get('https://blocked.example/')), /^HOST_NOT_ALLOWED:/);
  assert.equal(received.length, before);
  assert.match(text(await get(`${base}/redirect`)), /^HTTP_ERROR: status 302, redirect not followed/);
  assert.match(text(await get(`${base}/fail`)), /^HTTP_ERROR: status 500: boom/);
});

test('posts JSON with the auth header from the env var', { skip: skipPost }, async () => {
  const result = await post(`${base}/echo`, { event: 'ping', n: 1 });
  assert.equal(result.isError, undefined, text(result));
  assert.deepEqual(JSON.parse(text(result)), { status: 200, body: { got: { event: 'ping', n: 1 } } });
  const last = received.at(-1)!;
  assert.equal(last.headers.authorization, 'Bearer smoke-token');
  assert.equal(last.headers['content-type'], 'application/json');
});

test('refuses hosts that are not allowlisted without sending a request', { skip: skipPost }, async () => {
  const before = received.length;
  // localhost reaches the same server, but only 127.0.0.1 is on the allowlist.
  for (const url of [base.replace('127.0.0.1', 'localhost') + '/echo', 'https://blocked.example/hook']) {
    const refused = await post(url);
    assert.equal(refused.isError, true);
    assert.match(text(refused), /^HOST_NOT_ALLOWED:/);
  }
  assert.equal(received.length, before);
});

test('error statuses, redirects, timeouts and bad input are error results', { skip: skipPost }, async () => {
  assert.match(text(await post(`${base}/fail`)), /^HTTP_ERROR: status 500: boom/);
  assert.match(text(await post(`${base}/redirect`)), /^HTTP_ERROR: status 302, redirect not followed/);
  assert.match(text(await post(`${base}/slow`)), /^TIMEOUT:/);
  const bad = await client.callTool({ name: 'http_post', arguments: { url: 'not a url', body: {} } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /Input validation error/);
  const again = await post(`${base}/echo`);
  assert.equal(again.isError, undefined);
});
