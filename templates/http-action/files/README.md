# {{name}}

An MCP server (stdio) that POSTs JSON to allowlisted HTTP endpoints, e.g. webhooks. Generated
by planitia from the `http-action` template.

## Setup

```sh
npm install
npm run build
npm test        # smoke test: starts the server and calls it against a local HTTP server
```

Set `HTTP_ACTION_TOKEN` in the env of the MCP client entry (see below). The server reads real env
vars and does not load `.env`. `.env.example` lists the variable name only.

## Tools

### `http_post`

POSTs a JSON body to a URL on an allowed host. It is marked `destructiveHint: true` and
`openWorldHint: true`, so clients can ask before running it.

| Input | Type | Description |
|-------|------|-------------|
| `url` | string (URL) | The full https URL to POST to |
| `body` | any JSON value | The request body, sent as `application/json` |

Returns `{ "status": 200, "body": ... }`. A JSON response body is parsed, and any other body is
returned as text. Response bodies over 100,000 characters are cut and marked
`"truncated": true`.

`http_post` is generated only with `genericTools` set to `on` (this server: **{{genericTools}}**).
With `off`, the model can use only `http_get` and any spec-defined tools.

### `http_get`

GETs a URL on an allowed host. It is marked `readOnlyHint: true` and `openWorldHint: true`.

| Input | Type | Description |
|-------|------|-------------|
| `url` | string (URL) | The full https URL to GET |

Returns `{ "status": 200, "body": ... }`, like `http_post`, with the same host allowlist, https-only,
no-redirect, auth header, timeout and response-size rules.

Allowed hosts: `{{allowedHosts}}`. The auth header is `{{authHeader}}: {{authScheme}} <HTTP_ACTION_TOKEN>`,
sent only when `HTTP_ACTION_TOKEN` is set.

{{toolsReadme}}### Adding tools

Add a `http` or `custom` tool with Planitia's `add-tool`, run in this directory:

```sh
npx github:CharlGottschalk/planitia add-tool --kind http --name get_item --description "Fetch an item" --readOnly true \
  --method GET --url https://api.example.com/items/{id} --param id:string
npx github:CharlGottschalk/planitia add-tool --kind custom --name my_tool --description "..." --readOnly false --param id:integer
```

It adds the tool to `src/tools.json` (and, for `custom`, a handler stub in `src/tools/<name>.ts`
that returns `NOT_IMPLEMENTED` until you write it). It reads `planitia.json` and changes no other
file. Run `npm run build` afterwards. `add-tool --help` lists every option.

## Guardrails

- **Input validation:** every tool's inputs are checked with zod before it runs. Bad input
  returns an error result (`isError: true`), and the server keeps running.
- **Host allowlist:** the URL's host must be on the allowlist (`{{allowedHosts}}`), checked
  before any network access. Anything else fails with `HOST_NOT_ALLOWED`, and no request is
  sent. `HTTP_ALLOWED_HOSTS` (comma-separated) replaces the list at runtime. It is set in the
  client entry's env, which the model calling the tool cannot change.
- **https only:** plain http is refused (`INSECURE_URL`) except to `localhost`, `127.0.0.1` and
  `[::1]`.
- **No redirects:** a 3xx response is returned as an `HTTP_ERROR` and is not followed, so a
  redirect cannot carry the request (or the token) to a host that isn't allowed.
- **Errors:** failures come back as error results with a code prefix: `HOST_NOT_ALLOWED`,
  `INSECURE_URL`, `HTTP_ERROR` (non-2xx status), `NETWORK_ERROR`, `TIMEOUT`, `RATE_LIMITED` or
  `TOOL_ERROR`.
- **Logging:** JSON lines on stderr only. stdout carries the MCP protocol.
- **Timeout:** each call is limited to `TOOL_TIMEOUT_MS` (default {{timeoutMs}} ms).
  The request is aborted when the timeout expires.
- **Rate limit:** at most `RATE_LIMIT_PER_MINUTE` calls per minute across all tools
  (default {{rateLimitPerMinute}}; 0 = off).
- **Cache:** `http_get` results are cached for `CACHE_TTL_SECONDS` (0 = off), so they can be
  stale. `http_post` is not read-only, so its results are never cached.
- **Secrets:** the token is read from `HTTP_ACTION_TOKEN` at call time. It is never written to
  generated files or logs; `.env.example` holds only the variable name.

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `HTTP_ACTION_TOKEN` | (unset) | Auth token; no auth header is sent when unset |
| `HTTP_ALLOWED_HOSTS` | `{{allowedHosts}}` | Replaces the host allowlist, comma-separated |
| `TOOL_TIMEOUT_MS` | {{timeoutMs}} | Per-call timeout |
| `RATE_LIMIT_PER_MINUTE` | {{rateLimitPerMinute}} | Max calls per minute, 0 = off |
| `CACHE_TTL_SECONDS` | {{cacheTtlSeconds}} | Result cache lifetime for `http_get` and read-only spec-defined tools, 0 = off |

## Register with an MCP client

Build first, then use the absolute path to `dist/src/index.js`.

**Claude Code**

```sh
claude mcp add {{name}} -e HTTP_ACTION_TOKEN=your-token -- node "$(pwd)/dist/src/index.js"
claude mcp list   # should show {{name}} as connected
```

Add `-e` for each other env var. `--scope project` shares the entry through `.mcp.json`, and the
token with it, so use it only if that file stays out of version control.

**Codex**

```sh
codex mcp add {{name}} --env HTTP_ACTION_TOKEN=your-token -- node "$(pwd)/dist/src/index.js"
```

Or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.{{name|json}}]
command = "node"
args = ["/absolute/path/to/{{name}}/dist/src/index.js"]
env = { HTTP_ACTION_TOKEN = "your-token" }
```

**Cursor**

Add this to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    {{name|json}}: {
      "command": "node",
      "args": ["/absolute/path/to/{{name}}/dist/src/index.js"],
      "env": { "HTTP_ACTION_TOKEN": "your-token" }
    }
  }
}
```
