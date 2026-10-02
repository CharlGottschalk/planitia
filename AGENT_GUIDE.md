# Planitia agent guide

Follow these steps exactly to create and manage MCP servers with Planitia. Planitia generates
TypeScript MCP servers (stdio transport) from templates. The guide is printed by `planitia guide`
and always matches the installed version.

In this guide `planitia` means the installed command, or `npx -y planitia`
when it isn't installed. Always pass `--json` where a command accepts it, and parse stdout as JSON.
Logs and warnings go to stderr. A command that fails exits 1 and changes nothing.

## Rules

1. **Never handle secrets.** Inputs with `"secret": true` (connection strings, tokens) are never
   asked for, passed on the command line, written to a spec file or shown in chat. Tell the user
   the `env` name to set in their MCP client entry, and let them set the value.
2. **Ask the user, don't guess.** Ask for every required input and every choice that changes
   behaviour (`mode`, `tables`, `allowedHosts`, `genericTools`). Defaults are fine only for
   inputs the user doesn't care about.
3. **Third-party templates** (`github:` or a local path that isn't yours) are code the user hasn't
   reviewed. Show the warning from stderr and get the user's explicit confirmation first.
4. **Prefer narrow tools.** When the user knows the operations they need, define them as
   spec-defined tools and set `genericTools` to `off`, so the model gets no free-form SQL or POST.
5. **Never write into a non-empty directory**, and never edit `planitia.json`.

## 1. Create a server

1. List the templates and pick one with the user:

   ```sh
   planitia templates --json
   ```

   Prints `[{ "name", "description" }]`.

2. Read what the template asks for:

   ```sh
   planitia describe <template> --json
   ```

   Prints `{ template, description, inputs, toolKinds, builtinTools }`. Each input has `id`,
   `prompt`, `default`, `pattern` (a regex the whole value must match), `choices`, `help`,
   `secret`, `env` and `required`.
   - Ask the user for each input with `secret: false`. Offer `choices` as options, use `help` as
     the explanation, and check answers against `pattern` before you continue.
   - For each input with `secret: true`, note its `env` name for step 5.
   - `toolKinds` are the tool kinds you may define (see section 2). `builtinTools` are all the
     template's own tools, including the generic one that `genericTools: off` leaves out. Don't
     reuse their names.

3. Write a spec file, for example `planitia.spec.json` in the current directory. All option
   values are strings. The server is generated into `./<name>` (or `--out <dir>`), which must not
   exist yet or must be empty:

   ```json
   {
     "template": "database-query",
     "name": "orders-db",
     "mode": "read-only",
     "tables": "public.orders",
     "genericTools": "off",
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

4. Generate:

   ```sh
   planitia new --spec planitia.spec.json --yes --json
   ```

   - Success: `{ "ok": true, "dir": "...", "envVars": ["DATABASE_URL"] }`.
   - Failure: `{ "ok": false, "error": { "code", "field", "message" } }`. Handle it with the error
     table below, then run the command again. Nothing was written.

5. Build, test and register (section 4). Then tell the user which `envVars` to set.

## 2. Tools

A spec's `tools` array (at creation) and `add-tool` (later) take the same tool definitions. Tools
are data: Planitia validates them and stores them in `src/tools.json`.

| Field | Rules |
|-------|-------|
| `name` | snake_case, starting with a letter; unique; not in `builtinTools` |
| `kind` | one of the template's `toolKinds`: `sql` (database-query), `http` (http-action), `custom` (both) |
| `description` | Non-empty. The model reads it to decide when to call the tool, so say what it does and returns |
| `readOnly` | Required, `true` or `false` |
| `destructive` | Optional; defaults to the opposite of `readOnly`; can't be `true` when `readOnly` is |
| `params` | Optional map of name to `{ "type": ... }`. Types: `string` (`maxLength`, `pattern`), `integer` and `number` (`min`, `max`), `boolean`, `enum` (`values`: a list of strings). Any param can be `"optional": true` |

Kinds:

- **`sql`** adds `sql`: one statement, with params bound as `$1`, `$2`, ... in the order they are
  listed in `params`. Never splice values into the SQL text. In `read-only` mode `readOnly` must
  be `true`.
- **`http`** adds `method` (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) and `url`. The host must be on
  `allowedHosts`, and the URL must be https (plain http only to localhost). `{param}` placeholders
  may appear only in the path and must name required params. Other params go in the query string
  for GET and in the JSON body otherwise.
- **`custom`** adds no fields. Planitia writes a stub at `src/tools/<name>.ts` with a typed `Args`
  interface; it throws `NOT_IMPLEMENTED` until you implement it. Use `custom` only when `sql` or
  `http` can't express the operation.

## 3. Manage an existing server

Run these in the generated project's directory, or pass `--dir <dir>`. A project is a directory
with a `planitia.json`.

- See what the server exposes:

  ```sh
  planitia list-tools --json
  ```

  Prints `{ ok, dir, template, toolKinds, builtinTools, tools }`. `builtinTools` lists only the
  built-ins the server registers. `tools` is `src/tools.json`.

- Add a tool, either from a JSON file holding one tool definition (preferred) or from flags:

  ```sh
  planitia add-tool --from tool.json --json
  planitia add-tool --kind sql --name list_open --description "Open orders" --readOnly true \
    --param status:enum=open,closed --sql "SELECT id FROM public.orders WHERE status = $1" --json
  ```

  `tool.json` can live anywhere; only the project's files change. `--param` takes `name:type`, `name?:type` (optional) or `name:enum=a,b`. Success prints
  `{ "ok": true, "dir", "tool": { "name", "kind" }, "files": [...] }`, where `files` are the files
  it changed. For a `custom` tool, implement the stub it lists.

- Implement a custom tool by editing only `src/tools/<name>.ts`. The handler receives validated
  `args` and nothing else: there is no database or HTTP helper, so use an `sql` or `http` tool for
  anything that reads the database or calls an API. Return an object, such as
  `{ summary: "..." }`. It is sent to the model as JSON text, so a bare string arrives in quotes.
  Throw `new ToolError(code, message)` (imported from `../server.js`) for expected failures.

- To remove or change a tool, edit `src/tools.json` (and delete its stub, for a custom tool), then
  rebuild. There is no command for this.

After any change, run `npm run build` and `npm test` again. `npm install` is needed only once,
since Planitia never changes `package.json`.

## 4. Build, test and register

```sh
cd <dir>
npm install
npm run build
npm test
```

- Tests that need a live service skip without it. For example, database-query's database tests
  need `DATABASE_URL` pointing at a scratch database. Tests of the generic tool skip when
  `genericTools` is `off`. Report skipped tests to the user; don't call them passed.
- The generated tests check that your tools are registered, not what they return. Check each tool
  you defined by calling it through the server, with a test file such as
  `test/tools.test.ts`:

  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { connect, text } from './client.js';

  test('get_order returns the order', async () => {
    const client = await connect({ DATABASE_URL: process.env.DATABASE_URL ?? '' });
    const result = await client.callTool({ name: 'get_order', arguments: { id: 1 } });
    assert.ok(!result.isError, text(result));
    console.log(text(result));
    await client.close();
  });
  ```

  Run it with `npm run build && node --test dist/test/tools.test.js`. `connect` passes the server
  only the env you give it. If you can't reach the service, tell the user the tools are untested.
- The generated `README.md` shows how to register the server with Claude Code, Codex and Cursor.
  For Claude Code:

  ```sh
  claude mcp add <name> -e DATABASE_URL=<value> -- node /absolute/path/to/<dir>/dist/src/index.js
  ```

  Use the absolute path of the generated project (the `dir` from `new`). Give the user this command
  with a placeholder for each secret, for them to run. Don't run it with a real secret yourself.

## 5. Make your own template

When no built-in template fits, copy one and edit it:

```sh
planitia new-template <dir> --json                   # copies minimal
planitia new-template <dir> --from <template> --json # or another built-in
```

Prints `{ "ok": true, "dir", "from" }`. `<dir>` must not exist yet or must be empty. Edit
`template.json` (the inputs) and `files/` (rendered over the shared server skeleton), following
the README's "Writing a template" section. Then generate from it with
`--template <dir>` as in section 1. Use an absolute path or one starting with `./`. Build and run
its smoke test before telling the user it works.

## Errors

Every `--json` failure is `{ "ok": false, "error": { "code", "field", "message" } }`. `field`
names what to fix.

| Code | Meaning | What to do |
|------|---------|------------|
| `UNKNOWN_TEMPLATE` | Template name or source not found | Run `planitia templates --json` and ask again |
| `INVALID_TEMPLATE` | The template itself is broken | Report it to the user; pick another template |
| `UNKNOWN_OPTION` | An option the template doesn't have | Remove `field` from the spec; check `describe` |
| `MISSING_VALUE` | A required input is missing | Ask the user for `field` |
| `INVALID_VALUE` | A value fails its `pattern` or `choices` | Ask the user for `field` again, showing the rule |
| `INVALID_NAME` | Bad server name | Ask for a name: lowercase letters, digits, `.`, `_` or `-` |
| `INVALID_TOOL` | A tool definition is invalid | Fix the tool field the message names (for `add-tool`, `field` is that tool field), then retry |
| `TARGET_NOT_EMPTY` | The output directory isn't empty | Ask for another `name` or `--out` directory (for `new-template`, another `<dir>`) |
| `TARGET_EXISTS` | A custom tool's stub, or a different installed `SKILL.md`, already exists | Pick another tool name; for a skill, ask the user before removing the old file |
| `NOT_A_PROJECT` | No readable `planitia.json` | Run in the generated project, or pass `--dir` |
| `ERROR` | Anything else | Show the message to the user |

## Agent skill

`planitia skill install` installs a small skill that points agents to this guide:

```sh
planitia skill install --json             # Claude Code and Codex, for the current user
planitia skill install --claude --project # only Claude Code, only this project
```

It writes `SKILL.md` to `~/.claude/skills/planitia/` (Claude Code) and `~/.agents/skills/planitia/`
(Codex), or to `.claude/skills/planitia/` and `.agents/skills/planitia/` under the current
directory with `--project`. It never overwrites a different existing file.
