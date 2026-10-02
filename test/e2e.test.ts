import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Slow (npm install per template, needs the registry), so opt in: PLANITIA_E2E=1 npm test
// database-query's database tests also need DATABASE_URL (a scratch Postgres); without it they skip.
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const templates = readdirSync(new URL('../templates/', import.meta.url)).filter((t) => t !== '_base');
const tmp = mkdtempSync(join(tmpdir(), 'planitia-e2e-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

type Command = [string, string[], Record<string, string>?];

// node --test marks its subprocesses with NODE_TEST_CONTEXT; a nested `node --test` that inherits
// it reports to a parent that isn't listening and exits 0 even when its tests fail.
const { NODE_TEST_CONTEXT: _, ...parentEnv } = process.env;

/** Generates `out` with `args`, runs `prep`, installs, builds and runs its smoke test, then `extra`. */
function generateAndTest(out: string, args: string[], extra: Command[] = [], prep: Command[] = []): void {
  for (const [cmd, cmdArgs, cwd, env] of [
    [process.execPath, [CLI, 'new', ...args, '--yes', '--out', out], tmp],
    ...prep.map(([c, a, e]) => [c, a, out, e] as const),
    ['npm', ['install', '--no-audit', '--no-fund'], out],
    ['npm', ['test'], out],
    ...extra.map(([c, a, e]) => [c, a, out, e] as const),
  ] as const) {
    // Without NODE_TEST_CONTEXT, a nested `node --test` reports and fails like a top-level run.
    const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', env: { ...parentEnv, ...env } });
    assert.equal(r.status, 0, `${cmd} ${cmdArgs.join(' ')}\n${r.stdout}\n${r.stderr}`);
  }
}

const opts = { skip: !process.env.PLANITIA_E2E, timeout: 300_000 };
for (const template of templates) {
  test(`${template}: generate, install, build and smoke test`, opts, () => {
    generateAndTest(join(tmp, template), ['--template', template, '--name', `e2e-${template}`]);
  });
}

/** Copies test/fixtures/<name>.mjs into the generated project and runs it there. */
function fixture(name: string, env: Record<string, string> = {}): Command[] {
  return [
    ['cp', [fileURLToPath(new URL(`fixtures/${name}.mjs`, import.meta.url)), 'test/tools.e2e.mjs']],
    [process.execPath, ['--test', 'test/tools.e2e.mjs'], env],
  ];
}

test('database-query: spec-defined sql tools bind params and stay read-only', opts, () => {
  const out = join(tmp, 'dq-tools');
  const table = `public.planitia_e2e_${process.pid}`;
  const spec = join(tmp, 'dq-tools.json');
  writeFileSync(spec, JSON.stringify({
    template: 'database-query',
    name: 'e2e-dq-tools',
    // A generated allowlist: the smoke test must still pass with one.
    tables: table,
    tools: [
      { name: 'get_order', kind: 'sql', description: 'One order by id.', readOnly: true, params: { id: { type: 'integer', min: 1 } }, sql: `SELECT id, total FROM ${table} WHERE id = $1` },
      // Claims read-only but writes: the READ ONLY transaction must stop it.
      { name: 'zero_order', kind: 'sql', description: 'Sets an order total to 0.', readOnly: true, params: { id: { type: 'integer' } }, sql: `UPDATE ${table} SET total = 0 WHERE id = $1` },
    ],
  }));
  generateAndTest(out, ['--spec', spec], fixture('database-query.tools', { E2E_TABLE: table }));
});

test('http-action: spec-defined http tools encode path params and keep to the allowlist', opts, async () => {
  // A free local port, fixed into the generated tool URLs; the fixture listens on it.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  const out = join(tmp, 'ha-tools');
  const spec = join(tmp, 'ha-tools.json');
  const base = `http://127.0.0.1:${port}/items/{id}`;
  writeFileSync(spec, JSON.stringify({
    template: 'http-action',
    name: 'e2e-ha-tools',
    allowedHosts: '127.0.0.1',
    tools: [
      { name: 'get_item', kind: 'http', description: 'One item.', readOnly: true, method: 'GET', url: base, params: { id: { type: 'string' }, expand: { type: 'enum', values: ['full'], optional: true } } },
      { name: 'add_note', kind: 'http', description: 'Adds a note.', readOnly: false, method: 'POST', url: `${base}/notes`, params: { id: { type: 'string' }, note: { type: 'string', maxLength: 100 }, urgent: { type: 'boolean' } } },
    ],
  }));
  generateAndTest(out, ['--spec', spec], fixture('http-action.tools', { E2E_PORT: String(port) }));
});

test('database-query: add-tool sql and custom tools build, list and run', opts, () => {
  const add = (...args: string[]): Command => [process.execPath, [CLI, 'add-tool', '--yes', '--description', 'An e2e tool.', ...args]];
  generateAndTest(join(tmp, 'dq-add'), ['--template', 'database-query', '--name', 'e2e-dq-add'], fixture('add-tool'), [
    add('--kind', 'sql', '--name', 'count_rows', '--readOnly', 'true', '--param', 'min:integer', '--sql', 'SELECT count(*)::int AS n FROM pg_class WHERE relpages >= $1'),
    add('--kind', 'custom', '--name', 'later', '--readOnly', 'false', '--param', 'id:integer', '--param', 'note?:string'),
  ]);
});

for (const template of ['database-query', 'http-action']) {
  test(`${template}: genericTools=off leaves out the generic tool, and the smoke test passes`, opts, () => {
    generateAndTest(join(tmp, `${template}-off`), ['--template', template, '--name', `e2e-${template}-off`, '--genericTools', 'off']);
  });
}

test('new-template: a copied template generates a server that builds and passes its smoke test', opts, () => {
  const copy = join(tmp, 'own-tpl');
  const r = spawnSync(process.execPath, [CLI, 'new-template', copy], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  generateAndTest(join(tmp, 'own'), ['--template', copy, '--name', 'e2e-own']);
});
