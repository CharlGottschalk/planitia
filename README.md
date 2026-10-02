# Planitia

Generate ready-to-run TypeScript [MCP](https://modelcontextprotocol.io) servers from
business-logic templates. Input validation, guardrails, a smoke test and a README are built into
every generated server, so you only fill in what is specific to your domain.

```sh
npx github:CharlGottschalk/planitia new --template database-query --name orders-db
```

Each generated server:

- uses the official `@modelcontextprotocol/sdk` over stdio
- validates every tool's input with zod, and returns a validation error instead of crashing
- logs structured errors to stderr only (stdout carries the protocol)
- applies a per-call timeout, plus optional rate limiting and caching (both off by default)
- sets MCP tool annotations (`readOnlyHint`, `destructiveHint`, …)
- reads secrets only from environment variables and lists them by name in `.env.example`
- ships a smoke test that starts the server, lists its tools and calls one
- has a README with its tools, inputs, guardrails and how to register it with Claude Code, Codex
  and Cursor

## Requirements

- Node.js 20 or newer (22.18+ to use `.ts` spec files)
- Git, which `npx github:…` uses to fetch the CLI.

## Install and run

The CLI runs straight from the git repository. No npm publish is needed. npm runs the `prepare`
script on install, which builds `dist/`.

```sh
npx github:CharlGottschalk/planitia new --help
```

Each `npx github:…` run checks the repository and uses its latest commit, so new templates arrive
without an update step. To pin a version, add a tag (once one exists), for example
`npx github:CharlGottschalk/planitia#v0.1.0 new …`.

For local development:

```sh
git clone https://github.com/CharlGottschalk/planitia.git
cd planitia
npm install        # also builds dist/ via prepare
npm link           # optional: puts `planitia` on your PATH
planitia new --help
```

## Usage

```
planitia new [options] [--<template-option> <value> ...]
planitia add-tool [options]      (see "Adding tools to a generated project")
planitia list-tools [--dir <dir>] [--json]
planitia guide                   (see "Agent / automation use")
planitia skill install [--claude] [--codex] [--project] [--json]
planitia new-template <dir> [--from <template>] [--json]   (see "Writing a template")

  --template <name>  Template to generate: a built-in name, a local template directory,
                     or github:owner/repo[/dir][#ref]
  --name <name>      Server/package name (lowercase letters, digits, ".", "_", "-")
  --spec <file>      Spec file (.json, or .ts on Node >= 22.18); flags override it
  --out <dir>        Target directory (default: ./<name>)
  --yes              Accept defaults; never prompt
```

You can provide options in three ways, and all three produce the same result:

1. **Flags**: `--template http-action --name hooks --allowedHosts hooks.example.com`
2. **Interactive prompts**: in a terminal without `--yes`, Planitia asks for anything missing.
   Without `--template`, it lists the templates with descriptions. Pick one by number or name,
   or enter a path or `github:` source, then answer its options. It never prompts for secrets.
3. **A spec file** for repeatable generation. The keys are `template`, `name` and the template's
   options:

   ```json
   {
     "template": "database-query",
     "name": "orders-db",
     "mode": "read-only",
     "tables": "public.orders,public.customers"
   }
   ```

   ```sh
   planitia new --spec planitia.config.json --yes
   ```

   A `.ts` spec file works the same way, with the object as its default export.

Then build and test the generated server:

```sh
cd orders-db
npm install
npm run build
npm test
```

Finally, register it with your MCP client. The generated README shows how for Claude Code, Codex
and Cursor.

## Agent / automation use

Agents should start with `planitia guide`. It prints [AGENT_GUIDE.md](AGENT_GUIDE.md), a
step-by-step playbook for creating and managing servers, with every command, JSON shape and error
code. It ships with the CLI, so it always matches the installed version.

To let Claude Code and Codex find Planitia on their own, install its skill. The skill is a short
`SKILL.md` that tells the agent to run `planitia guide`:

```sh
npx github:CharlGottschalk/planitia skill install            # Claude Code and Codex, for your user
npx github:CharlGottschalk/planitia skill install --project  # under the current directory instead
```

`--claude` or `--codex` limits it to one agent. It writes `SKILL.md` to
`~/.claude/skills/planitia/` (Claude Code) and `~/.agents/skills/planitia/` (Codex), or to
`.claude/skills/planitia/` and `.agents/skills/planitia/` with `--project`. It never overwrites a
different file, so remove the old one to reinstall. To install it by hand, copy
[skills/planitia/SKILL.md](skills/planitia/SKILL.md) to one of those folders.

Agents (for example one driving Planitia through a form UI or `AskUserQuestion`) can't answer
terminal prompts. They read what a template asks for, collect the answers themselves, and generate
from a spec. `template.json` is the single source for both the terminal prompts and these forms.

```sh
planitia templates --json                 # [{ "name", "description" }, ...]
planitia describe database-query --json   # { template, description, inputs, toolKinds, builtinTools }
planitia new --spec spec.json --yes --json
planitia list-tools --dir orders-db --json    # { dir, template, toolKinds, builtinTools, tools }
planitia add-tool --dir orders-db --from tool.json --json
```

With `--json`, stdout carries only the JSON (logs and warnings go to stderr), and a failure prints
`{ "ok": false, "error": { "code", "field", "message" } }`, exits 1 and changes nothing. The JSON
shapes and every error code are in [AGENT_GUIDE.md](AGENT_GUIDE.md).

## Templates

### `database-query` (Postgres)

A `query` tool that runs parameterized SQL, plus `list_tables` and `describe_table` (columns,
types, nullability and primary key), which are read-only.

| Option | Default | Description |
|--------|---------|-------------|
| `mode` | `read-only` | `read-only` or `read-write` |
| `tables` | *(empty, no allowlist)* | Comma-separated `schema.table` names the tool may touch |
| `genericTools` | `on` | `off` leaves out `query`, so only the helpers and spec-defined tools remain |
| `connection` | *(secret)* | Set as `DATABASE_URL` in the server's env |

Guardrails:
- Read-only mode runs every query inside a `READ ONLY` transaction that is always rolled back,
  so Postgres itself rejects writes. Write mode is opt-in and marked `destructiveHint`.
- Queries are parameterized only, and multiple statements are refused.
- The table allowlist is checked against the query plan, so views are checked against their
  underlying tables. `list_tables` only lists allowlisted tables, and `describe_table` refuses
  others.

### `http-action`

An `http_post` tool that POSTs JSON to webhooks or APIs, and a read-only `http_get`.

| Option | Default | Description |
|--------|---------|-------------|
| `allowedHosts` | `api.example.com` | Comma-separated hosts the tool may POST to |
| `authHeader` | `Authorization` | Header that carries the token |
| `authScheme` | `Bearer` | Prefix before the token (empty = token only) |
| `genericTools` | `on` | `off` leaves out `http_post`, so only `http_get` and spec-defined tools remain |
| `token` | *(secret)* | Set as `HTTP_ACTION_TOKEN` in the server's env |

Guardrails:
- A host that isn't on the allowlist is refused before any network request is made.
- `http_post` is marked `destructiveHint` and `openWorldHint`; `http_get` is read-only and
  follows the same allowlist, https-only and no-redirect rules.
- Calls have a timeout, and very large responses are truncated.

### `data-validation`

- `validate`: checks a payload against the zod schema in the generated `src/schema.ts`, which
  you edit.
- `validate_json_schema`: validates a payload against a JSON Schema sent with the call (uses ajv).

This template has no options of its own. Both tools are read-only.

### `data-transform`

- `csv_to_json`: parses CSV into JSON rows.
- `json_to_csv`: turns JSON rows back into CSV.

This template has no options of its own. The CSV parser is strict RFC 4180 (quoted fields,
embedded commas and newlines), and malformed input returns a validation error. Both tools are
read-only.

### `minimal`

- `greet`: returns a greeting for a name, using the `greeting` option (default `Hello`).

A starting point rather than a useful server: `planitia new-template` copies it so you can write
your own template (see [Writing a template](#writing-a-template)).

### Your own and third-party templates

`--template` (or the spec file's `template` key) also accepts:

- **A local directory**, such as `./my-template` or `/abs/path`. It holds a `template.json` and a
  `files/` tree, rendered over the built-in `_base` skeleton (see
  [Writing a template](#writing-a-template)).
- **A GitHub repository**, as `github:owner/repo[/dir][#ref]`, for example
  `github:acme/mcp-templates/crm-lookup#v1`. Planitia shallow-clones it into a temp directory
  (removed afterwards), with your git credentials for private repos. `#ref` is a branch or tag.
  Pin a tag to keep generation reproducible.

Third-party templates are code you haven't reviewed. Planitia prints a warning and asks you to
confirm; `--yes` skips the question but not the warning. Review the generated project before you
run it. Templates can't contain symlinks, so they can't copy files from outside themselves into
the output.

### Writing a template

Start from a copy of a built-in template:

```sh
planitia new-template my-template                        # copies minimal
planitia new-template my-template --from database-query  # or any other built-in
planitia new --template ./my-template --name test --yes  # generate from it
```

`new-template` refuses a directory that isn't empty. A template is two things:

- **`template.json`**: a `description` and the `inputs` that `new` asks for. Each input has an
  `id`, a `prompt`, and optionally a `default`, a regex `pattern` the whole value must match,
  fixed `choices`, `help` text for forms, or `secret: true` with an `env` name.
- **`files/`**: the files of the generated project, rendered over the built-in `_base` skeleton.
  `_base` provides `src/server.ts` (the `tool()` helper and its guardrails), `tsconfig.json`,
  `.gitignore` and `test/client.ts` (the smoke-test client). A file at the same path replaces the
  `_base` one. Your template supplies at least `package.json`, `src/index.ts` (register tools
  with `tool()`, then `await start()`), `test/smoke.test.ts` and `README.md`.

Rules for template files:

- `{{id}}` inserts an input's value as is, and `{{id|json}}` inserts it as a JSON string. Use
  `|json` for anything that lands in code. An unknown placeholder fails generation with
  `INVALID_TEMPLATE`. `{{name}}` and the `_base` options (`timeoutMs`, `rateLimitPerMinute`,
  `cacheTtlSeconds`) are always available.
- Secret inputs are never collected or rendered. Generation lists their `env` names in
  `.env.example`, and your code reads them from `process.env`.
- Name dotfiles with a leading `_` (`_gitignore`), because npm strips dotfiles from packages.
- Templates can't contain symlinks, and output must depend only on the inputs, so the same spec
  always generates the same files.

A template that supports spec-defined tools lists the kinds in `toolKinds` and its own tool names
in `builtinTools`, plus `genericTool` if a `genericTools` input can leave one out. It then gets
`_base`'s `src/tools.ts` and calls `registerTools({ <kind>: ... })` from its `src/index.ts`. Its
README can place `{{toolsReadme}}`, which renders the tools' docs, or nothing when there are none.
`database-query` and `http-action` are the worked examples.

### Spec-defined tools

`database-query` and `http-action` also accept narrow, named tools in the spec file's `tools`
array. They are data, not code: Planitia validates them, writes them to the generated
`src/tools.json`, and the server registers them at start-up with the same guardrails as its
built-in tool. Only a spec file can define tools; there are no flags or prompts for them.

```json
{
  "template": "database-query",
  "name": "orders-db",
  "tools": [
    {
      "name": "get_order",
      "kind": "sql",
      "description": "Fetch one order by id.",
      "readOnly": true,
      "params": { "id": { "type": "integer", "min": 1 } },
      "sql": "SELECT id, status, total FROM public.orders WHERE id = $1"
    }
  ]
}
```

Every tool has:

| Field | Description |
|-------|-------------|
| `name` | snake_case, unique, and not a built-in tool's name (e.g. `query`, `list_tables`, `http_get`) |
| `kind` | `sql` (database-query), `http` (http-action) or `custom` (both) |
| `description` | Shown to the model |
| `readOnly` | Required. Sets `readOnlyHint`; read-only results can be cached |
| `destructive` | Optional; defaults to `!readOnly`. Can't be true for a read-only tool |
| `params` | Optional map of param name to `{ "type": ... }`. Types: `string` (`maxLength`, `pattern`), `integer` and `number` (`min`, `max`), `boolean`, `enum` (`values`). Any param can be `"optional": true` |

Kinds:
- **`sql`** adds `sql`: fixed SQL text. Params are bound as `$1`, `$2`, ... in the order they are
  listed, never spliced into the text. The tool uses the server's mode, table allowlist and row
  cap. In read-only mode `readOnly` must be true, and the SQL runs in a `READ ONLY` transaction,
  so a write fails. In read-write mode a `readOnly` tool still runs `READ ONLY`.
- **`http`** adds `method` (`GET`, `POST`, `PUT`, `PATCH` or `DELETE`) and `url`. `{param}`
  placeholders may appear only in the URL's path; their values are URL-encoded and must be
  required params. Other params go in the query string for GET, and in the JSON body otherwise.
  The host must be on `allowedHosts`, and the same https-only and no-redirect rules apply.
- **`custom`** adds no fields. Planitia scaffolds `src/tools/<name>.ts`: a handler with a typed
  `Args` interface for the params, which throws `NOT_IMPLEMENTED` until you write it. The tool's
  description, params and annotations stay in `src/tools.json`, and it gets the same guardrails.

An invalid tool (unknown kind, a kind the template doesn't support, `$3` with two params, a
duplicate or built-in name, a bad param type, a host off the allowlist, ...) fails generation
with an error naming the tool and field, and nothing is written.

### Adding tools to a generated project

Every generated project has a `planitia.json`: the template source, the Planitia version and the
spec's non-secret options, plus the tool kinds and built-in tool names the template has, and the
generic tool that `genericTools: off` leaves out. It holds no secrets and no tools. `planitia
add-tool` and `list-tools` read it, so they don't need the template again.

```sh
cd orders-db
npx github:CharlGottschalk/planitia add-tool --kind sql --name get_order --description "One order" \
  --readOnly true --param id:integer --sql "SELECT * FROM public.orders WHERE id = $1"
npx github:CharlGottschalk/planitia add-tool --kind custom --name refund --description "Refund an order" \
  --readOnly false --param id:integer --param reason?:string
npm run build
```

- Flags, prompts (anything missing, in a terminal without `--yes`) or `--from tool.json` (one
  tool in the spec `tools` format, which also allows `min`, `max`, `maxLength` and `pattern`).
  `--param` takes `name:type`, `name?:type` (optional) or `name:enum=a,b`.
- The tool is validated exactly like spec-defined tools and appended to `src/tools.json`. A
  `custom` tool also gets its stub in `src/tools/<name>.ts`. No other file is changed, so your
  edits to `src/index.ts` and the README stay as they are (the README won't list the new tool).
- It refuses, changing nothing, when `planitia.json` is missing, the name is taken, the template
  doesn't support the kind, or the stub file already exists.

### Options shared by every template

| Option | Default | Description |
|--------|---------|-------------|
| `timeoutMs` | `10000` | Per-call timeout in milliseconds |
| `rateLimitPerMinute` | `0` (off) | Maximum tool calls per minute |
| `cacheTtlSeconds` | `0` (off) | How long read-only results are cached, in seconds |

## Guarantees

- **Deterministic.** The same spec always gives byte-identical output: no timestamps, no random
  values. Flags, prompts and an equivalent spec file give the same result.
- **No secrets on disk.** Secret options (connection strings, tokens) are never written to any
  generated file. Only the env var name appears, in `.env.example`, even if you pass the value on
  the command line.
- **Tools are data.** Spec-defined tools are written only to `src/tools.json` and the README.
  The one exception is a `custom` tool's stub, which holds its param names (validated
  identifiers) and types; descriptions, SQL, URLs and enum values never reach a `.ts` file.
- **No overwrites.** Generating into a non-empty directory exits with an error and changes
  nothing. Files are rendered in memory first, so a failed run never leaves a half-written project.

## Development

```sh
npm test                                     # build plus unit/CLI tests
PLANITIA_E2E=1 npm test                      # also generate, install, build and smoke test each template
PLANITIA_E2E=1 DATABASE_URL=postgres://… npm test   # include the database-query database tests
```

The database tests need a scratch Postgres. A throwaway container works, for example
`podman run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17-alpine`.

### Project layout

```
src/cli.ts          CLI: flags, prompts and spec files, normalized into one spec
src/generate.ts     Validates the spec, renders the templates in memory, writes the tree
templates/_base/    Server skeleton shared by every template
templates/<name>/   template.json (options) and files/ (rendered over _base)
test/               CLI tests and end-to-end template tests
```

To add a built-in template, create `templates/<name>/` as described in
[Writing a template](#writing-a-template). The end-to-end tests pick it up automatically.

## Status

This is an early MVP (v0.1.0). It supports stdio transport only and generates TypeScript
servers only.

## License

The CLI is [MIT](LICENSE). The templates under `templates/`, and the servers Planitia generates
from them, are [MIT-0](LICENSE-TEMPLATES): use generated servers under any terms, without
attribution.
