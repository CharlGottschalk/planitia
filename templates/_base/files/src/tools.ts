import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { tool } from './server.js';

/** A spec-defined tool, as planitia writes it to src/tools.json. */
export interface ToolDef {
  name: string;
  kind: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  params: Record<string, Param>;
  [field: string]: unknown;
}
interface Param {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'enum';
  optional?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
  values?: string[];
}
type Handler = (args: Record<string, unknown>) => unknown;

function schema(p: Param): z.ZodType {
  let s: z.ZodType;
  if (p.type === 'string') {
    let str = z.string();
    if (p.maxLength !== undefined) str = str.max(p.maxLength);
    // Whole-value match, like the patterns in template.json.
    if (p.pattern !== undefined) str = str.regex(new RegExp(`^(?:${p.pattern})$`));
    s = str;
  } else if (p.type === 'integer' || p.type === 'number') {
    let num = p.type === 'integer' ? z.number().int() : z.number();
    if (p.min !== undefined) num = num.min(p.min);
    if (p.max !== undefined) num = num.max(p.max);
    s = num;
  } else if (p.type === 'boolean') {
    s = z.boolean();
  } else if (p.type === 'enum') {
    s = z.enum(p.values as [string, ...string[]]);
  } else {
    throw new Error(`tools.json: unknown param type ${p.type}`);
  }
  return p.optional ? s.optional() : s;
}

/** The spec-defined tools in src/tools.json (none when it is absent). Tools are data: nothing is compiled from them. */
const file = new URL('../../src/tools.json', import.meta.url);
export const TOOLS: ToolDef[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];

/** Custom tools: the handler is the default export of src/tools/<name>.ts, loaded on first call. */
function custom(def: ToolDef): Handler {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(def.name)) throw new Error(`tools.json: invalid tool name ${def.name}`);
  return async (args) => (await import(`./tools/${def.name}.js`)).default(args);
}

/**
 * Registers TOOLS through `tool()`, so they get the same
 * guardrails as built-in tools. `kinds` maps each kind the template supports to its implementation;
 * `custom` is built in.
 */
export function registerTools(kinds: Record<string, (def: ToolDef) => Handler>, options: { openWorld?: boolean } = {}): void {
  for (const def of TOOLS) {
    const impl = def.kind === 'custom' ? custom : kinds[def.kind];
    if (!impl) throw new Error(`tools.json: tool ${def.name} has kind ${def.kind}, which this server does not support`);
    tool(
      def.name,
      {
        description: def.description,
        inputSchema: Object.fromEntries(Object.entries(def.params).map(([name, p]) => [name, schema(p)])),
        readOnly: def.readOnly,
        destructive: def.destructive,
        openWorld: options.openWorld,
      },
      impl(def),
    );
  }
}
