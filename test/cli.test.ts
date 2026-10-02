import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
/** Stub template for exercising the generator; not shipped. */
const HELLO = new URL('fixtures/hello', import.meta.url).pathname;
const SECRET = 'postgres://u:s3cret-pw@h/db';
const tmp = mkdtempSync(join(tmpdir(), 'planitia-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function run(...args: string[]) {
  return runEnv({}, ...args);
}

/** Any planitia command, e.g. cli('templates', '--json'). */
function cli(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: tmp, encoding: 'utf8' });
}

/** stdout as JSON; it must be nothing else. */
function json(r: { stdout: string }) {
  return JSON.parse(r.stdout);
}

function addTool(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, 'add-tool', '--dir', join(tmp, dir), '--yes', ...args], { cwd: tmp, encoding: 'utf8' });
}

function runEnv(env: Record<string, string>, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, 'new', ...args], { cwd: tmp, encoding: 'utf8', env: { ...process.env, ...env } });
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

/** A minimal local template with one option, rendered over _base. */
function makeTemplate(dir: string): void {
  mkdirSync(join(dir, 'files', 'src'), { recursive: true });
  writeFileSync(join(dir, 'template.json'), JSON.stringify({ description: 'custom', inputs: [{ id: 'shout', prompt: 'Shout', default: 'HI' }] }));
  writeFileSync(join(dir, 'files', 'src', 'extra.ts'), 'export const shout = {{shout|json}};\n');
}

function tree(dir: string): Record<string, string> {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  return Object.fromEntries(
    files.map((e) => join(e.parentPath, e.name)).sort().map((p) => [p.slice(dir.length), readFileSync(p, 'utf8')]),
  );
}

test('generates a project from flags with --yes', () => {
  const r = run('--template', HELLO, '--name', 'x', '--yes', '--out', 'a');
  assert.equal(r.status, 0, r.stderr);
  const t = tree(join(tmp, 'a'));
  for (const f of ['/.env.example', '/.gitignore', '/README.md', '/package.json', '/src/index.ts', '/src/server.ts']) assert.ok(t[f], f);
  assert.equal(JSON.parse(t['/package.json']).name, 'x');
});

test('data-validation layers the base skeleton and renders its settings', () => {
  const r = run('--template', 'data-validation', '--name', 'dv', '--rateLimitPerMinute', '30', '--yes', '--out', 'dv');
  assert.equal(r.status, 0, r.stderr);
  const t = tree(join(tmp, 'dv'));
  assert.deepEqual(Object.keys(t), [
    '/.gitignore', '/README.md', '/package.json', '/planitia.json', '/src/index.ts', '/src/schema.ts', '/src/server.ts',
    '/test/client.ts', '/test/smoke.test.ts', '/tsconfig.json',
  ]);
  assert.match(t['/src/server.ts'], /RATE_LIMIT_PER_MINUTE \?\? 30\)/);
  assert.match(t['/src/server.ts'], /CACHE_TTL_SECONDS \?\? 0\)/);
  assert.match(t['/README.md'], /claude mcp add dv -- node/);
  for (const [path, content] of Object.entries(t)) assert.doesNotMatch(content, /\{\{/, `unrendered placeholder in ${path}`);
});

test('http-action renders its allowlist and keeps the token out of every file', () => {
  const r = run('--template', 'http-action', '--name', 'ha', '--allowedHosts', 'hooks.example.com,api.example.com', '--token', SECRET, '--yes', '--out', 'ha');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not written to disk/);
  const t = tree(join(tmp, 'ha'));
  assert.match(t['/src/index.ts'], /HTTP_ALLOWED_HOSTS \?\? "hooks\.example\.com,api\.example\.com"\)/);
  assert.equal(t['/.env.example'], 'HTTP_ACTION_TOKEN=\n');
  for (const [path, content] of Object.entries(t)) {
    assert.ok(!content.includes('s3cret'), `secret leaked into ${path}`);
    assert.doesNotMatch(content, /\{\{/, `unrendered placeholder in ${path}`);
  }
  assert.match(run('--template', 'http-action', '--name', 'n', '--allowedHosts', 'a.com"); evil("', '--yes').stderr, /Invalid value/);
});

test('database-query renders mode and allowlist and keeps the connection string out of every file', () => {
  const r = run('--template', 'database-query', '--name', 'dq', '--tables', 'public.orders,sales.items', '--connection', SECRET, '--yes', '--out', 'dq');
  assert.equal(r.status, 0, r.stderr);
  const t = tree(join(tmp, 'dq'));
  assert.match(t['/src/index.ts'], /const MODE: string = "read-only";/);
  assert.match(t['/src/index.ts'], /DB_ALLOWED_TABLES \?\? "public\.orders,sales\.items"\)/);
  assert.equal(t['/.env.example'], 'DATABASE_URL=\n');
  for (const [path, content] of Object.entries(t)) {
    assert.ok(!content.includes('s3cret'), `secret leaked into ${path}`);
    assert.doesNotMatch(content, /\{\{/, `unrendered placeholder in ${path}`);
  }
  assert.match(run('--template', 'database-query', '--name', 'n', '--mode', 'admin', '--yes').stderr, /Invalid value/);
  assert.match(run('--template', 'database-query', '--name', 'n', '--tables', 'orders"; drop', '--yes').stderr, /Invalid value/);
});

test('same spec twice, flags and .json/.ts spec all give byte-identical trees without the secret', () => {
  const spec = { template: HELLO, name: 'y', greeting: 'Hi "there"', connection: SECRET };
  writeFileSync(join(tmp, 'spec.json'), JSON.stringify(spec));
  writeFileSync(join(tmp, 'spec.ts'), `export default ${JSON.stringify(spec)} satisfies Record<string, string>;`);
  const outs = ['s1', 's2', 'ts', 'flags'];
  for (const [out, args] of [
    ['s1', ['--spec', 'spec.json']],
    ['s2', ['--spec', 'spec.json']],
    ['ts', ['--spec', 'spec.ts']],
    ['flags', ['--template', HELLO, '--name', 'y', '--greeting', 'Hi "there"', '--connection', SECRET]],
  ] as const) {
    const r = run(...args, '--yes', '--out', out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /not written to disk/);
  }
  const [first, ...rest] = outs.map((o) => tree(join(tmp, o)));
  for (const t of rest) assert.deepEqual(t, first);
  for (const content of Object.values(first)) assert.ok(!content.includes('s3cret'), 'secret leaked');
  assert.equal(first['/.env.example'], 'HELLO_CONNECTION=\n');
});

test('refuses a non-empty target and leaves it unchanged', () => {
  const r1 = run('--template', HELLO, '--name', 'z', '--yes', '--out', 'full');
  assert.equal(r1.status, 0, r1.stderr);
  writeFileSync(join(tmp, 'full', 'README.md'), 'mine');
  const before = tree(join(tmp, 'full'));
  const r2 = run('--template', HELLO, '--name', 'z', '--greeting', 'changed', '--yes', '--out', 'full');
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /refusing to write/);
  assert.deepEqual(tree(join(tmp, 'full')), before);
});

test('rejects unknown templates, unknown options and bad names', () => {
  assert.match(run('--template', 'nope', '--name', 'n', '--yes').stderr, /Unknown template/);
  assert.match(run('--template', HELLO, '--name', 'n', '--bogus', 'v', '--yes').stderr, /Unknown option/);
  assert.match(run('--template', HELLO, '--name', '../evil', '--yes').stderr, /Invalid name/);
  assert.match(run('--template', HELLO, '--name', 'n', '--timeoutMs', '1; evil()', '--yes').stderr, /Invalid value/);
  assert.match(run('--template', '_base', '--name', 'n', '--yes').stderr, /Unknown template/);
});

test('generates from a local template directory layered over _base', () => {
  makeTemplate(join(tmp, 'mytpl'));
  const r = run('--template', './mytpl', '--name', 'lt', '--shout', 'HEY', '--yes', '--out', 'lt');
  assert.equal(r.status, 0, r.stderr);
  const t = tree(join(tmp, 'lt'));
  assert.equal(t['/src/extra.ts'], 'export const shout = "HEY";\n');
  assert.ok(t['/src/server.ts'] && t['/tsconfig.json'], 'base files missing');
  assert.doesNotMatch(r.stderr, /Warning/);
  assert.match(run('--template', './nope', '--name', 'n', '--yes').stderr, /No template\.json/);
});

test('refuses templates containing symlinks', () => {
  makeTemplate(join(tmp, 'linked'));
  symlinkSync('/etc/hostname', join(tmp, 'linked', 'files', 'leak'));
  const r = run('--template', './linked', '--name', 'n', '--yes', '--out', 'linked-out');
  assert.match(r.stderr, /symlink/);
  assert.deepEqual(readdirSync(tmp).filter((f) => f === 'linked-out'), []);
  mkdirSync(join(tmp, 'linkedroot'));
  writeFileSync(join(tmp, 'linkedroot', 'template.json'), JSON.stringify({ description: 'x', inputs: [] }));
  symlinkSync('/etc', join(tmp, 'linkedroot', 'files'));
  assert.match(run('--template', './linkedroot', '--name', 'n', '--yes').stderr, /files is a symlink/);
});

test('fetches a github: template at a ref, warns, and removes the clone', () => {
  const src = join(tmp, 'gh-src');
  makeTemplate(join(src, 'templates', 'mytpl'));
  git(tmp, 'init', '-q', '-b', 'main', src);
  git(src, 'add', '.');
  git(src, 'commit', '-qm', 'init');
  git(src, 'tag', 'v1');
  git(tmp, 'clone', '-q', '--bare', src, join(tmp, 'git', 'acme', 'tpls.git'));
  const childTmp = join(tmp, 'child-tmp');
  mkdirSync(childTmp);
  const env = { PLANITIA_GIT_BASE: `file://${join(tmp, 'git')}`, TMPDIR: childTmp };

  const r = runEnv(env, '--template', 'github:acme/tpls/templates/mytpl#v1', '--name', 'gh', '--yes', '--out', 'gh');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /third-party template/);
  assert.equal(tree(join(tmp, 'gh'))['/src/extra.ts'], 'export const shout = "HI";\n');
  assert.deepEqual(readdirSync(childTmp), []);

  const d = spawnSync(process.execPath, [CLI, 'describe', 'github:acme/tpls/templates/mytpl#v1', '--json'], { cwd: tmp, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stderr, /third-party template/);
  assert.deepEqual(json(d).inputs.map((i: { id: string }) => i.id), ['name', 'shout', 'timeoutMs', 'rateLimitPerMinute', 'cacheTtlSeconds']);
  assert.deepEqual(readdirSync(childTmp), []);

  assert.match(runEnv(env, '--template', 'github:acme/tpls/nope', '--name', 'n', '--yes').stderr, /No nope directory/);
  assert.match(runEnv(env, '--template', 'github:acme/missing', '--name', 'n', '--yes').stderr, /Could not fetch/);
  for (const bad of ['github:acme/-x', 'github:acme/tpls/..', 'github:acme/tpls#--upload-pack=x', 'github:acme']) {
    assert.match(runEnv(env, '--template', bad, '--name', 'n', '--yes').stderr, /Invalid template source/, bad);
  }
  assert.deepEqual(readdirSync(childTmp), []);
});

const GET_ORDER = {
  name: 'get_order',
  kind: 'sql',
  description: 'Fetch one order by id. MARKER_DESC',
  readOnly: true,
  params: { id: { type: 'integer', min: 1 } },
  sql: 'SELECT id, total FROM public.orders WHERE id = $1 -- MARKER_SQL',
};
const GET_ITEM = {
  name: 'get_item',
  kind: 'http',
  description: 'Fetch an item.',
  readOnly: true,
  method: 'GET',
  url: 'https://api.example.com/items/{id}',
  params: { id: { type: 'string', maxLength: 40, pattern: '[a-z0-9-]+' }, expand: { type: 'enum', values: ['a', 'b'], optional: true } },
};

function specRun(spec: Record<string, unknown>, out: string) {
  const file = join(tmp, `${out}.json`);
  writeFileSync(file, JSON.stringify(spec));
  return run('--spec', file, '--yes', '--out', out);
}

test('spec-defined tools go to src/tools.json and the README, never into a .ts file', () => {
  const spec = { template: 'database-query', name: 'tl', tools: [GET_ORDER] };
  for (const out of ['tl1', 'tl2']) assert.equal(specRun(spec, out).status, 0);
  const t = tree(join(tmp, 'tl1'));
  assert.deepEqual(tree(join(tmp, 'tl2')), t);
  assert.deepEqual(JSON.parse(t['/src/tools.json']), [{ ...GET_ORDER, destructive: false, params: { id: { type: 'integer', min: 1 } } }]);
  // Fixed key order: kind fields after the common ones, param constraints before `optional`.
  assert.deepEqual(Object.keys(JSON.parse(t['/src/tools.json'])[0]), ['name', 'kind', 'description', 'readOnly', 'destructive', 'params', 'sql']);
  assert.match(t['/README.md'], /### `get_order` \(spec-defined, `sql`\)[\s\S]*\| `id` \| integer \| min 1 \|[\s\S]*MARKER_SQL[\s\S]*## Guardrails/);
  for (const [path, content] of Object.entries(t)) {
    if (path.endsWith('.ts')) assert.doesNotMatch(content, /MARKER|get_order/, `tool data in ${path}`);
  }
  assert.ok(t['/src/tools.ts']);

  const h = specRun({ template: 'http-action', name: 'th', tools: [GET_ITEM] }, 'th');
  assert.equal(h.status, 0, h.stderr);
  assert.match(tree(join(tmp, 'th'))['/README.md'], /\| `expand` \| enum, optional \| one of `a`, `b` \|[\s\S]*Sends `GET https:\/\/api\.example\.com\/items\/\{id\}`/);
});

test('without tools: no tools.json, and templates without tool kinds get no registrar', () => {
  assert.equal(run('--template', 'database-query', '--name', 'nt', '--yes', '--out', 'nt').status, 0);
  const t = tree(join(tmp, 'nt'));
  assert.equal(t['/src/tools.json'], undefined);
  assert.doesNotMatch(t['/README.md'], /\(spec-defined, /);
  assert.equal(run('--template', 'data-validation', '--name', 'nk', '--yes', '--out', 'nk').status, 0);
  assert.equal(tree(join(tmp, 'nk'))['/src/tools.ts'], undefined);
});

test('invalid tool definitions are rejected at generation, naming the tool and field, and write nothing', () => {
  const dq = (tool: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ template: 'database-query', name: 'bad', ...extra, tools: [tool] });
  const cases: [Record<string, unknown>, RegExp][] = [
    [dq({ ...GET_ORDER, kind: 'shell' }), /tool "get_order": kind must be one of sql, http, custom/],
    [dq({ ...GET_ORDER, kind: 'http' }), /tool "get_order": kind http is not supported by template "database-query"/],
    [{ ...dq(GET_ORDER), template: 'data-validation' }, /kind sql is not supported by template "data-validation" \(no tool kinds\)/],
    [dq({ ...GET_ORDER, sql: 'SELECT $1, $3', params: { a: { type: 'string' }, b: { type: 'string' } } }), /"get_order": sql uses \$3 but the tool has 2 param/],
    [{ ...dq(GET_ORDER), tools: [GET_ORDER, GET_ORDER] }, /"get_order": name is used by another tool/],
    [dq({ ...GET_ORDER, name: 'query' }), /"query": name clashes with a built-in tool/],
    [dq({ ...GET_ORDER, name: 'Get-Order' }), /tools\[0\]: name must be snake_case/],
    [dq({ ...GET_ORDER, params: { id: { type: 'int' } } }), /"get_order": params\.id\.type must be one of/],
    [dq({ ...GET_ORDER, params: { id: { type: 'integer', maxLength: 3 } } }), /params\.id\.maxLength is not allowed for type integer/],
    [dq({ ...GET_ORDER, params: { id: { type: 'enum', values: [] } } }), /params\.id\.values must be a non-empty array/],
    [dq({ ...GET_ORDER, params: { id: { type: 'string', pattern: '(' } } }), /params\.id\.pattern is not a valid regular expression/],
    [dq({ ...GET_ORDER, readOnly: false }), /readOnly must be true: the server is in read-only mode/],
    [dq({ ...GET_ORDER, readOnly: true, destructive: true }), /destructive cannot be true for a read-only tool/],
    [dq({ ...GET_ORDER, sqll: 'x' }), /"get_order": sqll is not a known field/],
    [{ template: 'http-action', name: 'bad', tools: [{ ...GET_ITEM, url: 'https://evil.example/items/{id}' }] }, /"get_item": url host evil\.example is not on allowedHosts/],
    [{ template: 'http-action', name: 'bad', tools: [{ ...GET_ITEM, url: 'https://{id}.example.com/x' }] }, /"get_item": url must be an absolute http\(s\) URL/],
    [{ template: 'http-action', name: 'bad', tools: [{ ...GET_ITEM, url: 'https://api.example.com/{nope}' }] }, /url uses \{nope\}, which is not a param/],
    [{ template: 'http-action', name: 'bad', tools: [{ ...GET_ITEM, url: 'https://api.example.com/{expand}' }] }, /params\.expand\.optional a path param cannot be optional/],
    [{ template: 'http-action', name: 'bad', tools: [{ ...GET_ITEM, method: 'TRACE' }] }, /method must be GET, POST/],
  ];
  for (const [i, [spec, error]] of cases.entries()) {
    const r = specRun(spec, `bad${i}`);
    assert.notEqual(r.status, 0, String(error));
    assert.match(r.stderr, error);
    assert.deepEqual(readdirSync(tmp).filter((f) => f === `bad${i}`), []);
  }
  assert.match(run('--template', 'database-query', '--name', 'n', '--tools', '[]', '--yes').stderr, /Unknown option '--tools'/);
});

test('planitia.json records the template, version and spec, without secrets or tools', () => {
  const spec = { template: 'database-query', name: 'mk', tables: 'public.orders', connection: SECRET, tools: [GET_ORDER] };
  assert.equal(specRun(spec, 'mk').status, 0);
  const marker = JSON.parse(tree(join(tmp, 'mk'))['/planitia.json']);
  assert.deepEqual(marker, {
    planitia: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    spec: { template: 'database-query', name: 'mk', mode: 'read-only', tables: 'public.orders', genericTools: 'on', timeoutMs: '10000', rateLimitPerMinute: '0', cacheTtlSeconds: '0' },
    toolKinds: ['sql', 'custom'],
    builtinTools: ['query', 'list_tables', 'describe_table'],
    genericTool: 'query',
  });
});

test('add-tool adds a declarative tool to tools.json and touches nothing else', () => {
  assert.equal(run('--template', 'database-query', '--name', 'at', '--yes', '--out', 'at').status, 0);
  writeFileSync(join(tmp, 'at', 'src', 'index.ts'), '// edited by the user\n');
  const before = tree(join(tmp, 'at'));
  const r = addTool('at', '--kind', 'sql', '--name', 'get_order', '--description', 'One order.', '--readOnly', 'true', '--param', 'id:integer', '--sql', 'SELECT * FROM public.orders WHERE id = $1');
  assert.equal(r.status, 0, r.stderr);
  const after = tree(join(tmp, 'at'));
  assert.deepEqual(JSON.parse(after['/src/tools.json']), [
    { name: 'get_order', kind: 'sql', description: 'One order.', readOnly: true, destructive: false, params: { id: { type: 'integer' } }, sql: 'SELECT * FROM public.orders WHERE id = $1' },
  ]);
  delete after['/src/tools.json'];
  assert.deepEqual(after, before);

  // --from takes the spec format (constraints included); a second tool is appended.
  writeFileSync(join(tmp, 'tool.json'), JSON.stringify({ ...GET_ORDER, name: 'get_order_2' }));
  assert.equal(addTool('at', '--from', join(tmp, 'tool.json')).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'at', 'src', 'tools.json'), 'utf8')).map((t: { name: string }) => t.name), ['get_order', 'get_order_2']);
});

test('add-tool --kind custom scaffolds a stub that never overwrites, and custom works in the spec too', () => {
  assert.equal(run('--template', 'http-action', '--name', 'ct', '--yes', '--out', 'ct').status, 0);
  const r = addTool('ct', '--kind', 'custom', '--name', 'x', '--description', 'Custom.', '--readOnly', 'false', '--param', 'id:integer', '--param', 'note?:string', '--param', 'mode:enum=a,b');
  assert.equal(r.status, 0, r.stderr);
  const t = tree(join(tmp, 'ct'));
  assert.match(t['/src/tools/x.ts'], /interface Args \{\n  id: number;\n  note\?: string;\n  mode: string;\n\}/);
  assert.match(t['/src/tools/x.ts'], /throw new ToolError\('NOT_IMPLEMENTED'/);
  assert.doesNotMatch(t['/src/tools/x.ts'], /Custom\./);
  assert.deepEqual(JSON.parse(t['/src/tools.json'])[0], { name: 'x', kind: 'custom', description: 'Custom.', readOnly: false, destructive: true, params: { id: { type: 'integer' }, note: { type: 'string', optional: true }, mode: { type: 'enum', values: ['a', 'b'] } } });

  const s = specRun({ template: 'database-query', name: 'cs', tools: [{ name: 'y', kind: 'custom', description: 'From the spec.', readOnly: true }] }, 'cs');
  assert.equal(s.status, 0, s.stderr);
  const cs = tree(join(tmp, 'cs'));
  assert.match(cs['/src/tools/y.ts'], /interface Args \{\}/);
  assert.match(cs['/README.md'], /### `y` \(spec-defined, `custom`\)[\s\S]*handler is `src\/tools\/y\.ts`/);
});

test('add-tool refuses bad input and leaves the project unchanged', () => {
  assert.equal(run('--template', 'database-query', '--name', 'rf', '--yes', '--out', 'rf').status, 0);
  assert.equal(addTool('rf', '--kind', 'custom', '--name', 'dup', '--description', 'd', '--readOnly', 'true').status, 0);
  assert.equal(run('--template', 'data-validation', '--name', 'dv2', '--yes', '--out', 'dv2').status, 0);
  assert.equal(run('--template', 'http-action', '--name', 'hh', '--allowedHosts', 'api.example.com', '--yes', '--out', 'hh').status, 0);
  mkdirSync(join(tmp, 'plain'));
  // A stub file the user already has, with no tools.json entry.
  writeFileSync(join(tmp, 'rf', 'src', 'tools', 'mine.ts'), 'export default () => 1;\n');
  const base = ['--description', 'd', '--readOnly', 'true'];
  writeFileSync(join(tmp, 'badparam.json'), JSON.stringify({ params: { a: { type: 'date' } } }));
  for (const [dir, args, error, code, field] of [
    ['rf', ['--kind', 'custom', '--name', 'dup', ...base], /"dup": name is used by another tool/, 'INVALID_TOOL', 'name'],
    ['rf', ['--kind', 'sql', '--name', 'query', '--sql', 'SELECT 1', ...base], /"query": name clashes with a built-in tool/, 'INVALID_TOOL', 'name'],
    ['rf', ['--kind', 'http', '--name', 'h', '--method', 'GET', '--url', 'https://a.example/', ...base], /kind http is not supported by template "database-query"/, 'INVALID_TOOL', 'kind'],
    ['dv2', ['--kind', 'custom', '--name', 'c', ...base], /kind custom is not supported by template "data-validation" \(no tool kinds\)/, 'INVALID_TOOL', 'kind'],
    ['plain', ['--kind', 'custom', '--name', 'c', ...base], /No planitia\.json/, 'NOT_A_PROJECT', 'dir'],
    ['rf', ['--kind', 'custom', '--name', 'mine', ...base], /src\/tools\/mine\.ts already exists; refusing to overwrite/, 'TARGET_EXISTS', 'name'],
    ['rf', ['--kind', 'sql', '--name', 's', '--sql', 'SELECT $2', '--param', 'a:integer', ...base], /uses \$2 but the tool has 1 param/, 'INVALID_TOOL', 'sql'],
    ['rf', ['--kind', 'custom', '--name', 'p', '--param', 'a:enum', ...base], /Invalid param "a:enum"/, 'INVALID_TOOL', 'params'],
    ['rf', ['--kind', 'custom', '--name', 'p', '--from', join(tmp, 'badparam.json'), ...base], /params\.a\.type must be one of/, 'INVALID_TOOL', 'params.a.type'],
    ['hh', ['--kind', 'http', '--name', 'h', '--method', 'GET', '--url', 'https://evil.example/x', ...base], /host evil\.example is not on allowedHosts/, 'INVALID_TOOL', 'url'],
  ] as const) {
    const before = tree(join(tmp, dir));
    const r = addTool(dir, ...args);
    assert.notEqual(r.status, 0, String(error));
    assert.match(r.stderr, error);
    assert.deepEqual(tree(join(tmp, dir)), before, String(error));
    // --json: the same failure as pure JSON on stdout, with a code and the field to fix.
    const j = addTool(dir, ...args, '--json');
    assert.equal(j.status, 1, String(error));
    const { ok, error: e } = json(j);
    assert.equal(ok, false);
    assert.equal(e.code, code, String(error));
    assert.equal(e.field, field, String(error));
    assert.match(e.message, error);
    assert.deepEqual(tree(join(tmp, dir)), before, String(error));
  }
});

test('add-tool --json reports the tool and the files it changed', () => {
  assert.equal(run('--template', 'database-query', '--name', 'aj', '--yes', '--out', 'aj').status, 0);
  const s = addTool('aj', '--kind', 'sql', '--name', 'one', '--description', 'd', '--readOnly', 'true', '--sql', 'SELECT 1', '--json');
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(json(s), { ok: true, dir: join(tmp, 'aj'), tool: { name: 'one', kind: 'sql' }, files: ['src/tools.json'] });
  const c = addTool('aj', '--kind', 'custom', '--name', 'two', '--description', 'd', '--readOnly', 'true', '--json');
  assert.deepEqual(json(c).files, ['src/tools.json', 'src/tools/two.ts']);
});

test('list-tools shows the registered built-ins and the spec-defined tools', () => {
  const spec = { template: 'database-query', name: 'ls', genericTools: 'off', tools: [GET_ORDER] };
  assert.equal(specRun(spec, 'ls').status, 0);
  assert.equal(addTool('ls', '--kind', 'custom', '--name', 'later', '--description', 'Added later.', '--readOnly', 'false').status, 0);
  const r = cli('list-tools', '--dir', join(tmp, 'ls'), '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = json(r);
  assert.deepEqual({ ...out, tools: out.tools.map((t: { name: string }) => t.name) }, {
    ok: true, dir: join(tmp, 'ls'), template: 'database-query', toolKinds: ['sql', 'custom'],
    builtinTools: ['list_tables', 'describe_table'], tools: ['get_order', 'later'],
  });
  assert.deepEqual(out.tools, JSON.parse(readFileSync(join(tmp, 'ls', 'src', 'tools.json'), 'utf8')));

  const plain = cli('list-tools', '--dir', join(tmp, 'ls'));
  assert.match(plain.stdout, /^NAME +KIND +READONLY +DESCRIPTION\nlist_tables +built-in\n/);
  assert.match(plain.stdout, /\nlater +custom +false +Added later\.\n$/);

  // genericTools on (the default) keeps the generic tool; no tools.json means no spec tools.
  assert.equal(run('--template', 'http-action', '--name', 'lh', '--yes', '--out', 'lh').status, 0);
  assert.deepEqual(json(cli('list-tools', '--dir', join(tmp, 'lh'), '--json')).builtinTools, ['http_post', 'http_get']);
  assert.deepEqual(json(cli('list-tools', '--dir', join(tmp, 'lh'), '--json')).tools, []);

  const e = cli('list-tools', '--dir', tmp, '--json');
  assert.equal(e.status, 1);
  assert.deepEqual(json(e).error.code, 'NOT_A_PROJECT');
});

test('templates --json lists the offered built-in templates as pure JSON', () => {
  const r = cli('templates', '--json');
  assert.equal(r.status, 0, r.stderr);
  const list = json(r);
  assert.deepEqual(list.map((t: { name: string }) => t.name), ['data-transform', 'data-validation', 'database-query', 'http-action', 'minimal']);
  for (const t of list) assert.ok(typeof t.description === 'string' && t.description, t.name);
  assert.match(cli('templates').stdout, /^data-transform\s+Convert CSV/m);
});

test('describe --json lists every input, and its choices and patterns reject what new rejects', () => {
  for (const { name } of json(cli('templates', '--json'))) {
    const r = cli('describe', name, '--json');
    assert.equal(r.status, 0, r.stderr);
    const d = json(r);
    assert.equal(d.template, name);
    const ids = d.inputs.map((i: { id: string }) => i.id);
    assert.equal(ids[0], 'name');
    for (const base of ['timeoutMs', 'rateLimitPerMinute', 'cacheTtlSeconds']) assert.ok(ids.includes(base), `${name}: ${base}`);
    for (const input of d.inputs) {
      assert.deepEqual(Object.keys(input), ['id', 'prompt', 'default', 'pattern', 'choices', 'help', 'secret', 'env', 'required'], `${name}.${input.id}`);
      if (input.secret) {
        assert.match(input.env, /^[A-Z_]+$/);
        assert.equal(input.required, false);
        continue;
      }
      const matches = (v: string) => (!input.pattern || new RegExp(`^(?:${input.pattern})$`).test(v)) && (!input.choices || input.choices.includes(v));
      if (input.default !== null) assert.ok(matches(input.default), `${name}.${input.id} default`);
      const bad = input.choices ? 'zzz' : 'bad value"';
      if (!input.choices && !input.pattern) continue;
      assert.ok(!matches(bad));
      const out = cli('new', '--template', name, '--name', 'n', `--${input.id}`, bad, '--json', '--out', `desc-${name}`);
      assert.equal(out.status, 1);
      assert.equal(json(out).error.code, input.id === 'name' ? 'INVALID_NAME' : 'INVALID_VALUE', `${name}.${input.id}`);
      assert.equal(json(out).error.field, input.id);
      assert.ok(!readdirSync(tmp).includes(`desc-${name}`));
    }
  }
  const dq = json(cli('describe', 'database-query', '--json'));
  assert.deepEqual(dq.inputs.find((i: { id: string }) => i.id === 'mode').choices, ['read-only', 'read-write']);
  assert.deepEqual(dq.inputs.find((i: { id: string }) => i.id === 'connection'), {
    id: 'connection', prompt: 'Postgres connection string', default: null, pattern: null, choices: null,
    help: dq.inputs.find((i: { id: string }) => i.id === 'connection').help, secret: true, env: 'DATABASE_URL', required: false,
  });
  assert.deepEqual([dq.toolKinds, dq.builtinTools], [['sql', 'custom'], ['query', 'list_tables', 'describe_table']]);
  assert.deepEqual(json(cli('describe', 'nope', '--json')), { ok: false, error: { code: 'UNKNOWN_TEMPLATE', field: 'template', message: json(cli('describe', 'nope', '--json')).error.message } });
});

test('new --json reports success with env var names, and failures with a code and field, writing nothing', () => {
  writeFileSync(join(tmp, 'agent.json'), JSON.stringify({ template: 'database-query', name: 'agent', tables: 'public.orders' }));
  const ok = cli('new', '--spec', 'agent.json', '--yes', '--json', '--out', 'agent');
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(json(ok), { ok: true, dir: join(tmp, 'agent'), envVars: ['DATABASE_URL'] });

  const fail = (spec: Record<string, unknown> | null, args: string[], code: string, field?: string) => {
    if (spec) writeFileSync(join(tmp, 'bad.json'), JSON.stringify(spec));
    const before = readdirSync(tmp).sort();
    const r = cli('new', ...(spec ? ['--spec', 'bad.json'] : []), ...args, '--yes', '--json');
    assert.equal(r.status, 1, `${code}: ${r.stdout}`);
    const out = json(r);
    assert.equal(out.ok, false);
    assert.equal(out.error.code, code, out.error.message);
    assert.equal(out.error.field, field);
    assert.ok(out.error.message);
    assert.deepEqual(readdirSync(tmp).sort(), before);
  };
  fail({ template: 'nope', name: 'x' }, ['--out', 'f1'], 'UNKNOWN_TEMPLATE', 'template');
  fail({ template: 'database-query', name: 'x', bogus: '1' }, ['--out', 'f2'], 'UNKNOWN_OPTION', 'bogus');
  fail(null, ['--template', 'database-query', '--name', 'x', '--bogus', '1', '--out', 'f3'], 'UNKNOWN_OPTION', 'bogus');
  fail({ template: 'database-query', name: 'x', mode: 'admin' }, ['--out', 'f4'], 'INVALID_VALUE', 'mode');
  fail({ template: 'database-query', name: 'x', genericTools: 'maybe' }, ['--out', 'f5'], 'INVALID_VALUE', 'genericTools');
  fail({ template: 'database-query' }, ['--out', 'f6'], 'MISSING_VALUE', 'name');
  fail({ name: 'x' }, ['--out', 'f7'], 'MISSING_VALUE', 'template');
  fail({ template: 'database-query', name: 'Bad Name' }, ['--out', 'f8'], 'INVALID_NAME', 'name');
  fail({ template: 'database-query', name: 'x', tools: [{ name: 'q', kind: 'nope' }] }, ['--out', 'f9'], 'INVALID_TOOL', 'tools');
  fail({ template: 'database-query', name: 'x' }, ['--out', 'agent'], 'TARGET_NOT_EMPTY', 'out');

  // Without --json, errors stay on stderr in the old format and stdout is empty.
  const plain = cli('new', '--template', 'database-query', '--name', 'x', '--mode', 'admin', '--yes');
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, /^planitia: Invalid value "admin" for "mode": must be one of read-only, read-write\n$/);
});

test('guide prints AGENT_GUIDE.md, and help points agents to it', () => {
  const r = cli('guide');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, readFileSync(new URL('../AGENT_GUIDE.md', import.meta.url), 'utf8'));
  assert.match(cli('--help').stdout, /^Agents: run `planitia guide`/);
});

test('the guide documents exactly the commands and error codes the CLI has', () => {
  const guide = readFileSync(new URL('../AGENT_GUIDE.md', import.meta.url), 'utf8');
  const help = cli('--help').stdout;
  // A command is `planitia <cmd>` in backticks or starting a (usage or code) line, not prose.
  const commands = (text: string) => new Set([...text.matchAll(/(?:^\s*(?:Usage:\s*)?|`)planitia ([a-z][a-z-]+)/gm)].map((m) => m[1]));
  assert.deepEqual(commands(guide), commands(help));
  const src = ['cli.ts', 'generate.ts'].map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).join('');
  // Codes are thrown as PlanitiaError('X'), mapped as code: 'X', or picked as const code = c ? 'X' : 'Y'.
  const codes = new Set([...src.matchAll(/PlanitiaError\('([A-Z_]+)'|code: '([A-Z_]+)'|code = .*'([A-Z_]+)' : '([A-Z_]+)'/g)].flatMap((m) => m.slice(1).filter(Boolean)));
  const documented = new Set([...guide.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]));
  assert.deepEqual([...documented].sort(), [...codes].sort());
});

test('skill install copies SKILL.md for both agents, never overwriting a different file', () => {
  const home = join(tmp, 'home');
  const proj = join(tmp, 'proj');
  mkdirSync(home);
  mkdirSync(proj);
  const skill = readFileSync(new URL('../skills/planitia/SKILL.md', import.meta.url), 'utf8');
  const install = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [CLI, 'skill', 'install', '--json', ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home } });
  const claude = join(home, '.claude', 'skills', 'planitia', 'SKILL.md');
  const codex = join(home, '.agents', 'skills', 'planitia', 'SKILL.md');

  const r = install(proj);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(json(r), { ok: true, installed: [{ agent: 'claude', path: claude, status: 'installed' }, { agent: 'codex', path: codex, status: 'installed' }] });
  assert.equal(readFileSync(claude, 'utf8'), skill);
  assert.equal(readFileSync(codex, 'utf8'), skill);
  assert.deepEqual(json(install(proj)).installed.map((i: { status: string }) => i.status), ['unchanged', 'unchanged']);

  // --project writes under the current directory, and only for the chosen agent.
  assert.equal(install(proj, '--claude', '--project').status, 0);
  assert.deepEqual(tree(proj), { '/.claude/skills/planitia/SKILL.md': skill });

  // A different skill file blocks the whole install, so codex isn't written either.
  rmSync(proj, { recursive: true });
  mkdirSync(join(proj, '.claude', 'skills', 'planitia'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'skills', 'planitia', 'SKILL.md'), 'mine\n');
  const e = install(proj, '--project');
  assert.equal(e.status, 1);
  assert.equal(json(e).error.code, 'TARGET_EXISTS');
  assert.deepEqual(tree(proj), { '/.claude/skills/planitia/SKILL.md': 'mine\n' });
});

test('new-template copies a built-in template that new can generate from', () => {
  const r = cli('new-template', 'my-tpl', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(json(r), { ok: true, dir: join(tmp, 'my-tpl'), from: 'minimal' });
  const minimal = new URL('../templates/minimal', import.meta.url).pathname;
  assert.deepEqual(tree(join(tmp, 'my-tpl')), tree(minimal));
  assert.match(r.stderr, /planitia new --template /);
  const gen = run('--template', join(tmp, 'my-tpl'), '--name', 'from-copy', '--greeting', 'Hi', '--yes', '--out', 'from-copy');
  assert.equal(gen.status, 0, gen.stderr);
  assert.match(tree(join(tmp, 'from-copy'))['/src/index.ts'], /const GREETING: string = "Hi";/);

  const dq = cli('new-template', 'dq-tpl', '--from', 'database-query');
  assert.equal(dq.status, 0, dq.stderr);
  assert.deepEqual(tree(join(tmp, 'dq-tpl')), tree(new URL('../templates/database-query', import.meta.url).pathname));
});

test('new-template refuses unknown sources and a non-empty target', () => {
  for (const from of ['nope', '_base', './my-tpl', 'github:acme/x']) {
    const r = cli('new-template', 'never', '--from', from, '--json');
    assert.equal(r.status, 1);
    assert.deepEqual([json(r).error.code, json(r).error.field], ['UNKNOWN_TEMPLATE', 'from'], from);
  }
  assert.ok(!readdirSync(tmp).includes('never'));
  mkdirSync(join(tmp, 'busy'));
  writeFileSync(join(tmp, 'busy', 'keep.txt'), 'mine');
  const r = cli('new-template', 'busy', '--json');
  assert.equal(r.status, 1);
  assert.equal(json(r).error.code, 'TARGET_NOT_EMPTY');
  assert.deepEqual(readdirSync(join(tmp, 'busy')), ['keep.txt']);
  assert.equal(cli('new-template', '--json').status, 1);
});
