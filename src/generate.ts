import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));
const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** A user-facing error. `code` and `field` (the input to ask about again) are for --json callers. */
export class PlanitiaError extends Error {
  code: string;
  field?: string;
  /** For INVALID_TOOL: the tool field at fault (e.g. `sql`, `params.id.type`); `field` stays `tools`. */
  toolField?: string;
  constructor(code: string, message: string, field?: string) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

/** Server/package names; also what `describe` reports for the `name` input. */
export const NAME_PATTERN = '[a-z0-9][a-z0-9._-]{0,213}';

export interface Input {
  id: string;
  prompt: string;
  default?: string;
  /** Secret inputs are never stored in the spec; only `env` is emitted, into .env.example. */
  secret?: boolean;
  env?: string;
  /** Regex the whole value must match, e.g. for numbers rendered into code. */
  pattern?: string;
  /** The only values allowed, checked like `pattern`. */
  choices?: string[];
  /** Longer guidance for forms, e.g. an agent's UI. */
  help?: string;
}
export interface Manifest {
  description: string;
  inputs: Input[];
  /** Spec-defined tool kinds this template implements (see KINDS). */
  toolKinds?: string[];
  /** Names of the template's own tools, which spec-defined tools may not reuse. */
  builtinTools?: string[];
  /** The built-in tool left out when the `genericTools` input is `off`. */
  genericTool?: string;
}
export interface Param {
  type: string;
  optional?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
  values?: string[];
}
export interface ToolDef {
  name: string;
  kind: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  params: Record<string, Param>;
  [field: string]: unknown;
}
/** The one normalized form every input route (flags, prompts, spec file) reduces to. */
export interface Spec {
  [key: string]: string | ToolDef[] | undefined;
  template: string;
  name: string;
  /** Spec-defined tools; only a spec file can set them. */
  tools?: ToolDef[];
}

/** `_base` holds the server skeleton layered under every template; it is not selectable itself. */
const BASE = '_base';

export function listTemplates(): string[] {
  return readdirSync(TEMPLATES_DIR).filter((t) => t !== BASE).sort();
}

/** A built-in name, or a path to a local template directory (anything with a "/" or a leading "."). */
export function templateDir(template: unknown): string {
  if (template === undefined) throw new PlanitiaError('MISSING_VALUE', `Missing --template (${listTemplates().join(', ')})`, 'template');
  if (typeof template === 'string' && listTemplates().includes(template)) return join(TEMPLATES_DIR, template);
  if (typeof template === 'string' && /^\.|\//.test(template)) {
    const dir = resolve(template);
    if (!existsSync(join(dir, 'template.json'))) throw new PlanitiaError('UNKNOWN_TEMPLATE', `No template.json in ${dir}`, 'template');
    return dir;
  }
  throw new PlanitiaError('UNKNOWN_TEMPLATE', `Unknown template "${template}". Available: ${listTemplates().join(', ')}`, 'template');
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'template.json'), 'utf8'));
}

export function loadManifest(dir: string): Manifest {
  const manifest = readManifest(dir);
  return { ...manifest, inputs: [...manifest.inputs, ...readManifest(join(TEMPLATES_DIR, BASE)).inputs] };
}

export function normalize(raw: Record<string, unknown>, manifest: Manifest): Spec {
  const known = new Set(['template', 'name', 'tools', ...manifest.inputs.map((i) => i.id)]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new PlanitiaError('UNKNOWN_OPTION', `Unknown option "${key}" for template "${raw.template}"`, key);
  }
  const { template, name } = raw;
  if (typeof name !== 'string' || !new RegExp(`^(?:${NAME_PATTERN})$`).test(name)) {
    const code = name === undefined ? 'MISSING_VALUE' : 'INVALID_NAME';
    throw new PlanitiaError(code, `Invalid name "${name}": use lowercase letters, digits, ".", "_" or "-"`, 'name');
  }
  const spec: Spec = { template: String(template), name };
  for (const input of manifest.inputs) {
    // Dropping secret values here means no template can ever render them.
    if (input.secret) continue;
    const value = raw[input.id] ?? input.default;
    if (value === undefined) throw new PlanitiaError('MISSING_VALUE', `Missing value for "${input.id}"`, input.id);
    if (typeof value !== 'string') throw new PlanitiaError('INVALID_VALUE', `"${input.id}" must be a string`, input.id);
    if (input.pattern && !new RegExp(`^(?:${input.pattern})$`).test(value)) {
      throw new PlanitiaError('INVALID_VALUE', `Invalid value "${value}" for "${input.id}": must match ${input.pattern}`, input.id);
    }
    if (input.choices && !input.choices.includes(value)) {
      throw new PlanitiaError('INVALID_VALUE', `Invalid value "${value}" for "${input.id}": must be one of ${input.choices.join(', ')}`, input.id);
    }
    spec[input.id] = value;
  }
  if (raw.tools !== undefined) spec.tools = normalizeTools(raw.tools, manifest, spec);
  return spec;
}

const PARAM_TYPES: Record<string, string[]> = {
  string: ['maxLength', 'pattern'],
  integer: ['min', 'max'],
  number: ['min', 'max'],
  boolean: [],
  enum: ['values'],
};

/** Fields each kind adds to a tool, and the checks that need the rest of the spec. */
const KINDS: Record<string, { fields: string[]; check: (def: ToolDef, spec: Spec, fail: (field: string, msg: string) => never) => void }> = {
  sql: {
    fields: ['sql'],
    check(def, spec, fail) {
      if (typeof def.sql !== 'string' || !def.sql.trim()) fail('sql', 'must be a non-empty string');
      const count = Object.keys(def.params).length;
      for (const [ref, n] of (def.sql as string).matchAll(/\$(\d+)/g)) {
        if (Number(n) < 1 || Number(n) > count) fail('sql', `uses ${ref} but the tool has ${count} param(s)`);
      }
      if (!def.readOnly && spec.mode !== 'read-write') fail('readOnly', 'must be true: the server is in read-only mode');
    },
  },
  http: {
    fields: ['method', 'url'],
    check(def, spec, fail) {
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(def.method as string)) fail('method', 'must be GET, POST, PUT, PATCH or DELETE');
      // Placeholders only in the path, so a param can never pick the host.
      const m = /^(https?:\/\/[^/?#{}]+)(\/[^?#]*)?(\?[^#{}]*)?$/.exec(typeof def.url === 'string' ? def.url : '');
      if (!m) return fail('url', 'must be an absolute http(s) URL, with {param} placeholders only in the path and no #fragment');
      const pathParams = [...(m[2] ?? '').matchAll(/\{([^{}]*)\}/g)].map((p) => p[1]);
      if ((m[2] ?? '').replace(/\{[^{}]*\}/g, '').match(/[{}]/)) fail('url', 'has an unmatched { or }');
      for (const p of pathParams) {
        if (!def.params[p]) fail('url', `uses {${p}}, which is not a param`);
        if (def.params[p].optional) fail(`params.${p}.optional`, 'a path param cannot be optional');
      }
      const url = new URL(m[1]);
      const hosts = String(spec.allowedHosts ?? '').split(',').filter(Boolean);
      if (!hosts.includes(url.hostname)) fail('url', `host ${url.hostname} is not on allowedHosts (${hosts.join(', ') || 'empty'})`);
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail('url', 'must be https (plain http only to localhost)');
    },
  },
  // The handler is code the user writes in src/tools/<name>.ts; everything else stays data.
  custom: { fields: [], check() {} },
};

/**
 * Validates spec-defined tools and rebuilds each one with a fixed key order, so tools.json is
 * deterministic. `existing` are tools already in the project, whose names are taken.
 */
export function normalizeTools(raw: unknown, manifest: Manifest, spec: Spec, existing: ToolDef[] = []): ToolDef[] {
  if (!Array.isArray(raw)) throw new PlanitiaError('INVALID_TOOL', '"tools" must be an array', 'tools');
  const names = new Set([...(manifest.builtinTools ?? []), ...existing.map((t) => t.name)]);
  return raw.map((t: Record<string, unknown>, i) => {
    let label = `tools[${i}]`;
    const fail = (field: string, msg: string): never => {
      throw Object.assign(new PlanitiaError('INVALID_TOOL', `Invalid tool ${label}: ${field} ${msg}`, 'tools'), { toolField: field });
    };
    if (!t || typeof t !== 'object' || Array.isArray(t)) fail('', 'must be an object');
    if (typeof t.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(t.name)) fail('name', 'must be snake_case (a-z, 0-9, _), starting with a letter');
    const name = t.name as string;
    label = `"${name}"`;
    if (names.has(name)) fail('name', manifest.builtinTools?.includes(name) ? 'clashes with a built-in tool' : 'is used by another tool');
    names.add(name);
    const kind = KINDS[t.kind as string];
    if (!kind) fail('kind', `must be one of ${Object.keys(KINDS).join(', ')}`);
    if (!manifest.toolKinds?.includes(t.kind as string)) fail('kind', `${t.kind} is not supported by template "${spec.template}" (${manifest.toolKinds?.join(', ') || 'no tool kinds'})`);
    for (const key of Object.keys(t)) {
      if (!['name', 'kind', 'description', 'params', 'readOnly', 'destructive', ...kind.fields].includes(key)) fail(key, 'is not a known field');
    }
    if (typeof t.description !== 'string' || !t.description.trim()) fail('description', 'must be a non-empty string');
    if (typeof t.readOnly !== 'boolean') fail('readOnly', 'must be true or false');
    if (t.destructive !== undefined && typeof t.destructive !== 'boolean') fail('destructive', 'must be true or false');
    if (t.readOnly && t.destructive) fail('destructive', 'cannot be true for a read-only tool');
    if (t.params !== undefined && (!t.params || typeof t.params !== 'object' || Array.isArray(t.params))) fail('params', 'must be an object');
    const params: Record<string, Param> = {};
    // Key order is kept: sql tools bind params as $1, $2, ... in this order.
    for (const [pname, p] of Object.entries((t.params ?? {}) as Record<string, Record<string, unknown>>)) {
      const field = `params.${pname}`;
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(pname)) fail(field, 'is not a valid param name (letters, digits, _)');
      if (!p || typeof p !== 'object' || Array.isArray(p)) fail(field, 'must be an object');
      const allowed = PARAM_TYPES[p.type as string];
      if (!allowed) fail(`${field}.type`, `must be one of ${Object.keys(PARAM_TYPES).join(', ')}`);
      for (const key of Object.keys(p)) if (!['type', 'optional', ...allowed].includes(key)) fail(`${field}.${key}`, `is not allowed for type ${p.type}`);
      if (p.optional !== undefined && typeof p.optional !== 'boolean') fail(`${field}.optional`, 'must be true or false');
      for (const key of ['min', 'max'] as const) if (p[key] !== undefined && !Number.isFinite(p[key])) fail(`${field}.${key}`, 'must be a number');
      if (typeof p.min === 'number' && typeof p.max === 'number' && p.min > p.max) fail(`${field}.min`, 'is greater than max');
      if (p.maxLength !== undefined && !(Number.isInteger(p.maxLength) && (p.maxLength as number) >= 0)) fail(`${field}.maxLength`, 'must be a non-negative integer');
      if (p.pattern !== undefined) {
        if (typeof p.pattern !== 'string') fail(`${field}.pattern`, 'must be a string');
        try {
          new RegExp(p.pattern as string);
        } catch {
          fail(`${field}.pattern`, 'is not a valid regular expression');
        }
      }
      if (p.type === 'enum') {
        const v = p.values;
        if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'string' || !x) || new Set(v).size !== v.length) {
          fail(`${field}.values`, 'must be a non-empty array of distinct non-empty strings');
        }
      }
      params[pname] = Object.fromEntries(['type', ...allowed, 'optional'].filter((k) => p[k] !== undefined).map((k) => [k, p[k]])) as unknown as Param;
    }
    const def: ToolDef = {
      name,
      kind: t.kind as string,
      description: t.description as string,
      readOnly: t.readOnly as boolean,
      destructive: (t.destructive as boolean | undefined) ?? !t.readOnly,
      params,
      ...Object.fromEntries(kind.fields.map((f) => [f, t[f]])),
    };
    kind.check(def, spec, fail);
    return def;
  });
}

/** The README section for spec-defined tools; empty when there are none, so the README is unchanged. */
function toolsReadme(tools: ToolDef[] = []): string {
  if (!tools.length) return '';
  const docs = tools.map((t) => {
    const rows = Object.entries(t.params).map(([n, p]) => {
      const rules = [
        p.type === 'enum' && `one of ${p.values!.map((v) => `\`${v}\``).join(', ')}`,
        p.min !== undefined && `min ${p.min}`,
        p.max !== undefined && `max ${p.max}`,
        p.maxLength !== undefined && `max length ${p.maxLength}`,
        p.pattern !== undefined && `matches \`${p.pattern}\``,
      ].filter(Boolean);
      return `| \`${n}\` | ${p.type}${p.optional ? ', optional' : ''} | ${(rules.join('; ') || '-').replace(/\|/g, '\\|')} |`;
    });
    const table = rows.length ? `| Param | Type | Rules |\n|-------|------|-------|\n${rows.join('\n')}\n\n` : 'No params.\n\n';
    const how = t.kind === 'custom'
      ? `Custom tool: its handler is \`src/tools/${t.name}.ts\`, which you implement.`
      : t.kind === 'sql'
      ? `Runs this SQL, with the params bound as \`$1\`, \`$2\`, ... in the order above (never spliced into the text)${t.readOnly ? ', in a READ ONLY transaction' : ''}. The table allowlist and the row cap apply.\n\n\`\`\`sql\n${t.sql}\n\`\`\``
      : `Sends \`${t.method} ${t.url}\`. \`{param}\` path segments are URL-encoded; other params go in the ${t.method === 'GET' ? 'query string' : 'JSON body'}. The host allowlist, https-only and no-redirect rules apply.`;
    const hints = `Annotations: \`readOnlyHint: ${t.readOnly}\`, \`destructiveHint: ${t.destructive}\`.`;
    return `### \`${t.name}\` (spec-defined, \`${t.kind}\`)\n\n${t.description}\n\n${table}${how}\n\n${hints}\n\n`;
  });
  return `${docs.join('')}Spec-defined tools are stored as data in \`src/tools.json\` and registered at start-up with the same guardrails as the other tools.\n\n`;
}

const TS_TYPES: Record<string, string> = { string: 'string', integer: 'number', number: 'number', boolean: 'boolean', enum: 'string' };

/**
 * The stub for a custom tool. Only param names (validated identifiers) and types go into it; the
 * description and constraints stay in tools.json.
 */
export function customStub(def: ToolDef): string {
  const fields = Object.entries(def.params).map(([n, p]) => `  ${n}${p.optional ? '?' : ''}: ${TS_TYPES[p.type]};\n`).join('');
  return `import { ToolError } from '../server.js';

/** The tool's inputs, already validated against its params in src/tools.json. */
interface Args {${fields ? `\n${fields}` : ''}}

/**
 * A custom tool's handler. Its name, description, params and annotations are in src/tools.json, and
 * it runs with the same guardrails as every other tool. Return plain data (sent back as JSON), or
 * throw a ToolError for expected failures.
 */
export default async function handler(args: Args): Promise<unknown> {
  throw new ToolError('NOT_IMPLEMENTED', 'this tool has no implementation yet');
}
`;
}

function toolsJson(tools: ToolDef[]): string {
  return JSON.stringify(tools, null, 2) + '\n';
}

/** What `add-tool` needs to know about a generated project, from its planitia.json. */
export interface Marker {
  planitia: string;
  spec: Spec;
  toolKinds: string[];
  builtinTools: string[];
  genericTool?: string;
}

export function readMarker(dir: string): Marker {
  const path = join(dir, 'planitia.json');
  const fail = (why: string) => new PlanitiaError('NOT_A_PROJECT', `${why} in ${dir}: use a project generated by planitia, or pass --dir`, 'dir');
  if (!existsSync(path)) throw fail('No planitia.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw fail('Unreadable planitia.json');
  }
}

/** A generated project's spec-defined tools, from src/tools.json (none when it is absent). */
export function readTools(dir: string): ToolDef[] {
  const path = join(dir, 'src', 'tools.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
}

/** The built-in tools the server registers: the generic one is left out when genericTools is off. */
export function activeBuiltins(marker: Marker): string[] {
  return marker.builtinTools.filter((n) => !(n === marker.genericTool && marker.spec.genericTools === 'off'));
}

/** Adds one tool to a generated project: a tools.json entry, plus a stub for a custom tool. Nothing else is touched. */
export function addTool(dir: string, raw: Record<string, unknown>): ToolDef {
  const marker = readMarker(dir);
  const toolsPath = join(dir, 'src', 'tools.json');
  const existing = readTools(dir);
  const manifest = { description: '', inputs: [], toolKinds: marker.toolKinds, builtinTools: marker.builtinTools };
  let def: ToolDef;
  try {
    [def] = normalizeTools([raw], manifest, marker.spec, existing);
  } catch (err) {
    // One tool, so point at its field rather than at the spec's `tools` array.
    if (err instanceof PlanitiaError && err.toolField !== undefined) err.field = err.toolField || undefined;
    throw err;
  }
  if (def.kind === 'custom') {
    const stub = join(dir, 'src', 'tools', `${def.name}.ts`);
    if (existsSync(stub)) throw new PlanitiaError('TARGET_EXISTS', `${stub} already exists; refusing to overwrite it`, 'name');
    mkdirSync(dirname(stub), { recursive: true });
    // 'wx' also refuses a file created since the check above.
    writeFileSync(stub, customStub(def), { flag: 'wx' });
  }
  writeFileSync(toolsPath, toolsJson([...existing, def]));
  return def;
}

/** Renders the whole tree in memory first, so a template error never leaves a half-written project. */
export function render(spec: Spec, manifest: Manifest, dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const vars: Record<string, unknown> = { ...spec, toolsReadme: toolsReadme(spec.tools) };
  // Template files replace same-path base files.
  for (const [template, root] of [[BASE, join(TEMPLATES_DIR, BASE, 'files')], [spec.template, join(dir, 'files')]] as const) {
    // A symlink could pull files from outside a third-party template into the output.
    if (lstatSync(root).isSymbolicLink()) throw new PlanitiaError('INVALID_TEMPLATE', `${template}/files is a symlink; templates must not contain symlinks`);
    for (const rel of readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()) {
      const src = join(root, rel);
      if (lstatSync(src).isSymbolicLink()) throw new PlanitiaError('INVALID_TEMPLATE', `${template}/${rel} is a symlink; templates must not contain symlinks`);
      if (statSync(src).isDirectory()) continue;
      // The tools registrar only goes to templates that implement tool kinds.
      if (template === BASE && rel === join('src', 'tools.ts') && !manifest.toolKinds?.length) continue;
      // npm strips dotfiles like .gitignore from packages, so templates store them as _gitignore.
      const dest = rel.split(sep).map((part) => part.replace(/^_/, '.')).join('/');
      const content = readFileSync(src, 'utf8').replace(/\{\{([\w-]+)(\|json)?\}\}/g, (match, key, json) => {
        if (typeof vars[key] !== 'string') throw new PlanitiaError('INVALID_TEMPLATE', `${template}/${rel} uses unknown placeholder ${match}`);
        return json ? JSON.stringify(vars[key]) : vars[key];
      });
      files.set(dest, content);
    }
  }
  // Tools are data: their strings only ever reach this JSON file and the README, never a .ts file.
  if (spec.tools?.length) files.set('src/tools.json', toolsJson(spec.tools));
  for (const t of spec.tools ?? []) if (t.kind === 'custom') files.set(`src/tools/${t.name}.ts`, customStub(t));
  // Lets add-tool validate new tools without the template. Secrets were already dropped from the spec.
  const { tools, ...values } = spec;
  const marker: Marker = { planitia: VERSION, spec: values as Spec, toolKinds: manifest.toolKinds ?? [], builtinTools: manifest.builtinTools ?? [], ...(manifest.genericTool && { genericTool: manifest.genericTool }) };
  files.set('planitia.json', JSON.stringify(marker, null, 2) + '\n');
  const env = manifest.inputs.filter((i) => i.secret).map((i) => `${i.env}=\n`).join('');
  if (env) files.set('.env.example', env);
  return files;
}

export function writeTree(dir: string, files: Map<string, string>): void {
  if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) {
    throw new PlanitiaError('TARGET_NOT_EMPTY', `${dir} exists and is not an empty directory; refusing to write`, 'out');
  }
  for (const [rel, content] of files) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
