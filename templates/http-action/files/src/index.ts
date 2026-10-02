#!/usr/bin/env node
import { z } from 'zod';
import { start, TIMEOUT_MS, tool, ToolError } from './server.js';
import { registerTools } from './tools.js';

// Set at generation time. HTTP_ALLOWED_HOSTS replaces the list at runtime: that is the operator's
// env when registering the server, which the model calling the tool cannot change.
const ALLOWED_HOSTS = new Set(
  (process.env.HTTP_ALLOWED_HOSTS ?? {{allowedHosts|json}})
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);
const AUTH_HEADER = {{authHeader|json}};
const AUTH_SCHEME = {{authScheme|json}};
/** Plain http is only allowed to this machine; everything else must be https. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_RESPONSE_CHARS = 100_000;
/** `off` leaves out the generic `http_post` tool, so only `http_get` and spec-defined tools remain. */
const GENERIC_TOOLS: string = {{genericTools|json}};

/**
 * Sends one request with the guardrails every tool here shares: host allowlist, https only, auth
 * header from the env, no redirects, a timeout and a response size cap. `body` is sent as JSON.
 */
async function send(method: string, target: URL, body?: unknown) {
  // Checked before any network access, so a refused call sends nothing.
  if (!ALLOWED_HOSTS.has(target.hostname)) {
    throw new ToolError('HOST_NOT_ALLOWED', `${target.hostname} is not on this server's allowlist`);
  }
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && LOCAL_HOSTS.has(target.hostname))) {
    throw new ToolError('INSECURE_URL', 'only https URLs are allowed (plain http only to localhost)');
  }
  const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' };
  const token = process.env.HTTP_ACTION_TOKEN;
  if (token) headers[AUTH_HEADER] = AUTH_SCHEME ? `${AUTH_SCHEME} ${token}` : token;

  let response: Response;
  let text: string;
  try {
    // redirect: 'manual' keeps a 3xx from carrying the request to a host that isn't allowed.
    response = await fetch(target, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // ponytail: reads the whole response before truncating; stream with a byte cap if endpoints return huge bodies.
    text = await response.text();
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') throw new ToolError('TIMEOUT', `no response within ${TIMEOUT_MS}ms`);
    throw new ToolError('NETWORK_ERROR', (err as Error).message);
  }
  const truncated = text.length > MAX_RESPONSE_CHARS;
  if (truncated) text = text.slice(0, MAX_RESPONSE_CHARS);

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? 'none';
    throw new ToolError('HTTP_ERROR', `status ${response.status}, redirect not followed (location: ${location})`);
  }
  if (!response.ok) throw new ToolError('HTTP_ERROR', `status ${response.status}: ${text.slice(0, 500)}`);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: return the text as is.
  }
  return { status: response.status, body: parsed, ...(truncated && { truncated: true }) };
}

if (GENERIC_TOOLS === 'on') tool(
  'http_post',
  {
    description: `POST a JSON body to a URL on an allowed host (${[...ALLOWED_HOSTS].join(', ')}). Returns { status, body }; a JSON response body is parsed. Redirects are not followed.`,
    inputSchema: {
      url: z.url().describe('The full https URL to POST to'),
      body: z.unknown().describe('The JSON value to send as the request body'),
    },
    readOnly: false,
    destructive: true,
    openWorld: true,
  },
  ({ url, body }) => send('POST', new URL(url), body ?? null),
);

tool(
  'http_get',
  {
    description: `GET a URL on an allowed host (${[...ALLOWED_HOSTS].join(', ')}). Returns { status, body }; a JSON response body is parsed. Redirects are not followed.`,
    inputSchema: { url: z.url().describe('The full https URL to GET') },
    readOnly: true,
    openWorld: true,
  },
  ({ url }) => send('GET', new URL(url)),
);

// Spec-defined http tools: a fixed method and URL. {param} path segments are URL-encoded, and the
// other params go in the query string (GET) or the JSON body.
registerTools(
  {
    http: (def) => (args) => {
      const inPath = new Set<string>();
      const url = (def.url as string).replace(/\{(\w+)\}/g, (_, name: string) => {
        inPath.add(name);
        const value = String(args[name]);
        // URL parsing would resolve a "." or ".." segment (even encoded) and change the path.
        if (value === '.' || value === '..') throw new ToolError('INVALID_PARAM', `${name} cannot be "${value}"`);
        return encodeURIComponent(value);
      });
      const target = new URL(url);
      const rest = Object.fromEntries(Object.entries(args).filter(([name, v]) => !inPath.has(name) && v !== undefined));
      if (def.method !== 'GET') return send(def.method as string, target, rest);
      for (const [name, v] of Object.entries(rest)) target.searchParams.append(name, String(v));
      return send('GET', target);
    },
  },
  { openWorld: true },
);

await start();
