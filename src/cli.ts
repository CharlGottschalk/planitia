#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { activeBuiltins, addTool, listTemplates, loadManifest, NAME_PATTERN, normalize, PlanitiaError, readMarker, readTools, render, templateDir, writeTree } from './generate.ts';

const USAGE = `Agents: run \`planitia guide\` for step-by-step instructions.

Usage: planitia new [options] [--<template-option> <value> ...]
       planitia add-tool [options]   (see planitia add-tool --help)
       planitia list-tools [--dir <dir>] [--json]
                                     The tools of a generated project
       planitia guide                The agent guide: how to create and manage servers
       planitia skill install [--claude] [--codex] [--project] [--json]
                                     Install the agent skill (both agents by default)
       planitia templates [--json]   List the built-in templates
       planitia describe <template> [--json]
                                     The inputs a template asks for (any --template source)
       planitia new-template <dir> [--from <template>] [--json]
                                     Copy a built-in template (default: minimal) to make your own

Without options, planitia asks for the template and its settings.

Options:
  --template <name>  Template to generate (${listTemplates().join(', ')}),
                     a local template directory, or github:owner/repo[/dir][#ref]
  --name <name>      Server/package name
  --spec <file>      Spec file (.json, or .ts on Node >= 22.18); flags override it
  --out <dir>        Target directory (default: ./<name>)
  --yes              Accept defaults; never prompt
  --json             Never prompt; print { ok, dir, envVars } or { ok: false, error } to stdout
`;

const BASE = {
  template: { type: 'string' },
  name: { type: 'string' },
  spec: { type: 'string' },
  out: { type: 'string' },
  yes: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

async function loadSpecFile(file: string): Promise<Record<string, unknown>> {
  const path = resolve(file);
  if (path.endsWith('.json')) return JSON.parse(readFileSync(path, 'utf8'));
  if (!path.endsWith('.ts')) throw new Error(`Spec file must be .json or .ts: ${file}`);
  try {
    return (await import(pathToFileURL(path).href)).default;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      throw new Error('.ts spec files need Node >= 22.18; use a .json spec instead');
    }
    throw err;
  }
}

const GITHUB = /^github:([\w.-]+)\/([\w.-]+)((?:\/[\w.-]+)*)(?:#([\w./-]+))?$/;
// Tests point this at a local file:// repo.
const GIT_BASE = process.env.PLANITIA_GIT_BASE ?? 'https://github.com';

/** Shallow-clones a github: template source into `tmp` and returns the template directory in it. */
function cloneTemplate(source: string, tmp: string): string {
  const m = GITHUB.exec(source);
  const [, owner, repo, sub, ref] = m ?? [];
  // A leading "-" would be read by git as an option; "." and ".." would escape the clone.
  if (!m || [owner, repo, ...sub.split('/').slice(1), ref ?? ''].some((p) => p.startsWith('-') || p === '.' || p === '..')) {
    throw new PlanitiaError('UNKNOWN_TEMPLATE', `Invalid template source "${source}": use github:owner/repo[/dir][#ref]`, 'template');
  }
  const args = ['clone', '--quiet', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', `${GIT_BASE}/${owner}/${repo}.git`, tmp];
  const r = spawnSync('git', args, { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.error || r.status !== 0) throw new PlanitiaError('UNKNOWN_TEMPLATE', `Could not fetch ${source}${r.error ? `: ${r.error.message}` : ''}`, 'template');
  const dir = join(tmp, sub);
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new PlanitiaError('UNKNOWN_TEMPLATE', `No ${sub.slice(1)} directory in ${owner}/${repo}`, 'template');
  }
  if (real !== realpathSync(tmp) && !real.startsWith(realpathSync(tmp) + sep)) {
    throw new PlanitiaError('UNKNOWN_TEMPLATE', `${source} points outside the repository`, 'template');
  }
  return dir;
}

/**
 * Resolves a --template value to a template directory. A github: source is cloned into a temp
 * directory, returned as `clone` for the caller to remove, with the third-party warning on stderr.
 */
function resolveTemplate(source: unknown): { dir: string; clone?: string } {
  if (typeof source !== 'string' || !source.startsWith('github:')) return { dir: templateDir(source) };
  const clone = mkdtempSync(join(tmpdir(), 'planitia-template-'));
  try {
    const dir = templateDir(cloneTemplate(source, clone));
    console.error(`Warning: ${source} is a third-party template. Review the generated project before you run it; it runs with your permissions.`);
    return { dir, clone };
  } catch (err) {
    rmSync(clone, { recursive: true, force: true });
    throw err;
  }
}

/** The built-in templates offered to people and agents. */
function offeredTemplates(): { name: string; description: string }[] {
  return listTemplates().map((name) => ({ name, description: loadManifest(templateDir(name)).description }));
}

/** Numbered list of built-in templates; the answer may be a number, a name, a path or a github: source. */
async function askTemplate(rl: ReturnType<typeof createInterface>): Promise<string> {
  const templates = offeredTemplates();
  const names = templates.map((t) => t.name);
  const width = Math.max(...names.map((n) => n.length));
  const list = templates.map((t, i) => `  ${String(i + 1).padStart(2)}) ${t.name.padEnd(width)}  ${t.description}`);
  const answer = (await rl.question(`Templates:\n${list.join('\n')}\nTemplate (number, name, path or github:owner/repo): `)).trim();
  return /^\d+$/.test(answer) && names[Number(answer) - 1] ? names[Number(answer) - 1] : answer;
}

const ADD_TOOL_USAGE = `Usage: planitia add-tool [options]

Adds a tool to a project generated by planitia: an entry in src/tools.json, plus a handler stub
in src/tools/<name>.ts for a custom tool. Nothing else is changed. Without options, it asks.

Options:
  --kind <kind>          sql, http or custom (the project's template decides which it supports)
  --name <name>          snake_case tool name
  --description <text>   What the tool does, for the model
  --readOnly <bool>      true or false
  --destructive <bool>   true or false (default: the opposite of readOnly)
  --param <param>        Repeatable: name:type, name?:type (optional) or name:enum=a,b
                         Types: string, integer, number, boolean, enum
  --sql <sql>            sql: one statement, with $1, $2, ... bound to the params in order
  --method <method>      http: GET, POST, PUT, PATCH or DELETE
  --url <url>            http: the URL, with {param} placeholders in the path
  --from <file.json>     A tool definition in the spec \`tools\` format; flags override it
  --dir <dir>            Project directory (default: .)
  --yes                  Never prompt
  --json                 Never prompt; print { ok, dir, tool, files } or { ok: false, error } to stdout
`;

const ADD_TOOL_OPTIONS = {
  kind: { type: 'string' },
  name: { type: 'string' },
  description: { type: 'string' },
  readOnly: { type: 'string' },
  destructive: { type: 'string' },
  param: { type: 'string', multiple: true },
  sql: { type: 'string' },
  method: { type: 'string' },
  url: { type: 'string' },
  from: { type: 'string' },
  dir: { type: 'string' },
  yes: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** `id:integer`, `note?:string` or `status:enum=open,closed`, as a spec param. */
function parseParam(text: string): [string, Record<string, unknown>] {
  const m = /^([A-Za-z_]\w*)(\?)?:(\w+)(?:=(.+))?$/.exec(text);
  if (!m || (m[4] !== undefined) !== (m[3] === 'enum')) throw new PlanitiaError('INVALID_TOOL', `Invalid param "${text}": use name:type, name?:type or name:enum=a,b`, 'params');
  const [, name, optional, type, values] = m;
  return [name, { type, ...(values && { values: values.split(',') }), ...(optional && { optional: true }) }];
}

function bool(value: string | undefined): unknown {
  return value === 'true' ? true : value === 'false' ? false : value;
}

async function addToolCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: ADD_TOOL_OPTIONS, strict: true });
  if (values.help) return void process.stdout.write(ADD_TOOL_USAGE);
  const dir = resolve(values.dir ?? '.');
  const marker = readMarker(dir);
  const raw: Record<string, unknown> = values.from ? JSON.parse(readFileSync(resolve(values.from), 'utf8')) : {};
  for (const key of ['kind', 'name', 'description', 'sql', 'method', 'url'] as const) if (values[key] !== undefined) raw[key] = values[key];
  for (const key of ['readOnly', 'destructive'] as const) if (values[key] !== undefined) raw[key] = bool(values[key]);
  if (values.param) raw.params = Object.fromEntries(values.param.map(parseParam));

  const rl = !values.yes && !values.json && process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  try {
    const ask = async (key: string, prompt: string) => {
      if (raw[key] === undefined && rl) raw[key] = (await rl.question(prompt)).trim();
    };
    await ask('kind', `Kind (${marker.toolKinds.join(', ') || 'none supported'}): `);
    await ask('name', 'Tool name (snake_case): ');
    await ask('description', 'Description: ');
    if (raw.readOnly === undefined && rl) raw.readOnly = /^y(es)?$/i.test(await rl.question('Read-only? [y/N] '));
    if (raw.params === undefined && rl) {
      const answer = (await rl.question('Params, space-separated (e.g. id:integer note?:string), empty = none: ')).trim();
      raw.params = Object.fromEntries(answer ? answer.split(/\s+/).map(parseParam) : []);
    }
    if (raw.kind === 'sql') await ask('sql', 'SQL, with $1, $2, ... for the params in order: ');
    if (raw.kind === 'http') {
      await ask('method', 'Method (GET, POST, PUT, PATCH, DELETE): ');
      await ask('url', 'URL, with {param} path segments: ');
    }
  } finally {
    rl?.close();
  }
  const def = addTool(dir, raw);
  console.error(`Added ${def.kind} tool ${def.name} to src/tools.json${def.kind === 'custom' ? `; implement it in src/tools/${def.name}.ts` : ''}. Rebuild the server to use it.`);
  if (values.json) {
    const files = ['src/tools.json', ...(def.kind === 'custom' ? [`src/tools/${def.name}.ts`] : [])];
    process.stdout.write(JSON.stringify({ ok: true, dir, tool: { name: def.name, kind: def.kind }, files }) + '\n');
  }
}

/** A generated project's tools: the built-ins its server registers, plus src/tools.json as stored. */
function listToolsCommand(args: string[]): void {
  const { values } = parseArgs({ args, options: { dir: { type: 'string' }, json: { type: 'boolean' } }, strict: true });
  const dir = resolve(values.dir ?? '.');
  const marker = readMarker(dir);
  const builtinTools = activeBuiltins(marker);
  const tools = readTools(dir);
  if (values.json) {
    return void process.stdout.write(JSON.stringify({ ok: true, dir, template: marker.spec.template, toolKinds: marker.toolKinds, builtinTools, tools }) + '\n');
  }
  const rows = [...builtinTools.map((n) => [n, 'built-in', '', '']), ...tools.map((t) => [t.name, t.kind, String(t.readOnly), t.description])];
  if (!rows.length) return void process.stdout.write('No tools.\n');
  const header = ['NAME', 'KIND', 'READONLY', 'DESCRIPTION'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  process.stdout.write([header, ...rows].map((r) => r.map((c, i) => (i < 3 ? c.padEnd(widths[i]) : c)).join('  ').trimEnd() + '\n').join(''));
}

function templatesCommand(args: string[]): void {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true });
  const templates = offeredTemplates();
  if (values.json) return void process.stdout.write(JSON.stringify(templates) + '\n');
  const width = Math.max(...templates.map((t) => t.name.length));
  process.stdout.write(templates.map((t) => `${t.name.padEnd(width)}  ${t.description}\n`).join(''));
}

/** Everything an agent needs to build a form for a template, from template.json (the same source as the prompts). */
function describeCommand(args: string[]): void {
  const { values, positionals } = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true, allowPositionals: true });
  if (positionals.length !== 1) throw new PlanitiaError('MISSING_VALUE', 'Usage: planitia describe <template> [--json]', 'template');
  const { dir, clone } = resolveTemplate(positionals[0]);
  try {
    const manifest = loadManifest(dir);
    const inputs = [
      { id: 'name', prompt: 'Server name', default: null, pattern: NAME_PATTERN, choices: null, help: 'Server and package name: lowercase letters, digits, ".", "_" or "-". Also the default target directory.', secret: false, env: null, required: true },
      ...manifest.inputs.map((i) => ({
        id: i.id,
        prompt: i.prompt,
        default: i.default ?? null,
        pattern: i.pattern ?? null,
        choices: i.choices ?? null,
        help: i.help ?? null,
        secret: Boolean(i.secret),
        env: i.env ?? null,
        // Secrets are never collected: generation drops them, and the user sets the env var instead.
        required: !i.secret && i.default === undefined,
      })),
    ];
    const description = { template: positionals[0], description: manifest.description, inputs, toolKinds: manifest.toolKinds ?? [], builtinTools: manifest.builtinTools ?? [] };
    if (values.json) return void process.stdout.write(JSON.stringify(description) + '\n');
    process.stdout.write(`${positionals[0]}: ${manifest.description}\n\n`);
    for (const i of inputs) {
      const detail = i.secret ? `secret: set ${i.env} in the server's env` : i.choices ? `one of ${i.choices.join(', ')}` : i.required ? 'required' : `default ${JSON.stringify(i.default)}`;
      process.stdout.write(`  --${i.id}  ${i.prompt} (${detail})\n`);
    }
  } finally {
    if (clone) rmSync(clone, { recursive: true, force: true });
  }
}

/** Copies a built-in template (template.json and files/) into a new directory, as the start of the user's own. */
function newTemplateCommand(args: string[]): void {
  const { values, positionals } = parseArgs({ args, options: { from: { type: 'string' }, json: { type: 'boolean' } }, strict: true, allowPositionals: true });
  if (positionals.length !== 1) throw new PlanitiaError('MISSING_VALUE', 'Usage: planitia new-template <dir> [--from <template>] [--json]', 'out');
  const from = values.from ?? 'minimal';
  if (!listTemplates().includes(from)) throw new PlanitiaError('UNKNOWN_TEMPLATE', `Unknown template "${from}". Available: ${listTemplates().join(', ')}`, 'from');
  const src = templateDir(from);
  const dir = resolve(positionals[0]);
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((rel) => statSync(join(src, rel)).isFile());
  writeTree(dir, new Map(files.sort().map((rel) => [rel, readFileSync(join(src, rel), 'utf8')])));
  console.error(`Copied the ${from} template to ${dir}. Edit it, then generate from it:\n  planitia new --template ${dir} --name test --yes`);
  if (values.json) process.stdout.write(JSON.stringify({ ok: true, dir, from }) + '\n');
}

const SKILL = fileURLToPath(new URL('../skills/planitia/SKILL.md', import.meta.url));

/**
 * Copies the bundled SKILL.md into each agent's skills folder: the user's home, or the current
 * directory with --project. An identical file is left alone; a different one is never overwritten.
 */
function skillCommand(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { claude: { type: 'boolean' }, codex: { type: 'boolean' }, project: { type: 'boolean' }, json: { type: 'boolean' } },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.join(' ') !== 'install') throw new PlanitiaError('MISSING_VALUE', 'Usage: planitia skill install [--claude] [--codex] [--project] [--json]', 'command');
  const root = values.project ? process.cwd() : homedir();
  const both = !values.claude && !values.codex;
  const agents = [
    ...(both || values.claude ? [['claude', join(root, '.claude', 'skills', 'planitia', 'SKILL.md')]] : []),
    ...(both || values.codex ? [['codex', join(root, '.agents', 'skills', 'planitia', 'SKILL.md')]] : []),
  ];
  const skill = readFileSync(SKILL, 'utf8');
  // Check every target before writing any, so a refusal changes nothing.
  for (const [, path] of agents) {
    if (existsSync(path) && readFileSync(path, 'utf8') !== skill) {
      throw new PlanitiaError('TARGET_EXISTS', `${path} exists and differs from Planitia's skill; refusing to overwrite it (remove it to reinstall)`, 'path');
    }
  }
  const installed = agents.map(([agent, path]) => {
    const status = existsSync(path) ? 'unchanged' : 'installed';
    if (status === 'installed') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, skill, { flag: 'wx' });
    }
    console.error(`${status === 'installed' ? 'Installed' : 'Already installed'}: ${path}`);
    return { agent, path, status };
  });
  if (values.json) process.stdout.write(JSON.stringify({ ok: true, installed }) + '\n');
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === 'add-tool') return addToolCommand(args);
  if (command === 'list-tools') return listToolsCommand(args);
  if (command === 'guide') return void process.stdout.write(readFileSync(new URL('../AGENT_GUIDE.md', import.meta.url), 'utf8'));
  if (command === 'skill') return skillCommand(args);
  if (command === 'templates') return templatesCommand(args);
  if (command === 'describe') return describeCommand(args);
  if (command === 'new-template') return newTemplateCommand(args);
  if (command !== 'new') {
    process.stdout.write(USAGE);
    if (command && command !== '--help' && command !== '-h') process.exitCode = 1;
    return;
  }
  // Pass 1 finds the template; pass 2 (strict) adds that template's own options.
  const first = parseArgs({ args, options: BASE, strict: false }).values;
  if (first.help) return void process.stdout.write(USAGE);

  const raw: Record<string, unknown> = first.spec ? { ...(await loadSpecFile(String(first.spec))) } : {};
  let clone: string | undefined;
  const rl = !first.yes && !first.json && process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  try {
    raw.template = first.template ?? raw.template ?? (rl && (await askTemplate(rl)));
    const resolved = resolveTemplate(raw.template);
    clone = resolved.clone;
    if (clone && rl && !/^y(es)?$/i.test(await rl.question('Continue? [y/N] '))) throw new Error('Cancelled');
    const templatePath = resolved.dir;
    const manifest = loadManifest(templatePath);
    const templateOptions = Object.fromEntries(manifest.inputs.map((i) => [i.id, { type: 'string' as const }]));
    const { values } = parseArgs({ args, options: { ...BASE, ...templateOptions }, strict: true });
    for (const input of manifest.inputs) raw[input.id] = (values as Record<string, unknown>)[input.id] ?? raw[input.id];
    raw.name = values.name ?? raw.name ?? (await rl?.question('Server name: '));
    for (const input of manifest.inputs) {
      if (raw[input.id] !== undefined || input.secret || !rl) continue;
      const answer = await rl.question(`${input.prompt}${input.default ? ` [${input.default}]` : ''}: `);
      if (answer) raw[input.id] = answer;
    }
    for (const key of Object.keys(raw)) if (raw[key] === undefined) delete raw[key];

    const spec = normalize(raw, manifest);
    const dir = resolve(values.out ?? spec.name);
    writeTree(dir, render(spec, manifest, templatePath));
    console.error(`Created ${spec.name} in ${dir}`);
    const secrets = manifest.inputs.filter((i) => i.secret);
    for (const input of secrets) {
      const passed = raw[input.id] !== undefined ? ' (the value you passed was not written to disk)' : '';
      console.error(`Set ${input.env} in the server's env, e.g. its MCP client entry (see README)${passed}`);
    }
    if (values.json) process.stdout.write(JSON.stringify({ ok: true, dir, envVars: secrets.map((i) => i.env) }) + '\n');
  } finally {
    rl?.close();
    if (clone) rmSync(clone, { recursive: true, force: true });
  }
}

/** The --json error shape; parseArgs errors are mapped so agents get a code and field for them too. */
function errorInfo(err: Error): { code: string; field?: string; message: string } {
  if (err instanceof PlanitiaError) return { code: err.code, ...(err.field && { field: err.field }), message: err.message };
  const parseCode = (err as NodeJS.ErrnoException).code;
  const field = /'--?([^' ]+)/.exec(err.message)?.[1];
  if (parseCode === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return { code: 'UNKNOWN_OPTION', ...(field && { field }), message: err.message };
  if (parseCode === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') return { code: 'INVALID_VALUE', ...(field && { field }), message: err.message };
  return { code: 'ERROR', message: err.message };
}

const argv = process.argv.slice(2);
main(argv).catch((err: Error) => {
  if (argv.includes('--json')) process.stdout.write(JSON.stringify({ ok: false, error: errorInfo(err) }) + '\n');
  else console.error(`planitia: ${err.message}`);
  process.exitCode = 1;
});
