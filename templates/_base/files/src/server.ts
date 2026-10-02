import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

// Generation-time defaults; the env vars override them at runtime.
export const TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS ?? {{timeoutMs}});
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE ?? {{rateLimitPerMinute}});
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS ?? {{cacheTtlSeconds}}) * 1000;

/** stdout carries the MCP protocol, so every log line goes to stderr. */
export function log(level: 'info' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }));
}

/** Thrown for expected failures; the client sees `CODE: message` as an isError result. */
export class ToolError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

export const server = new McpServer({ name: {{name|json}}, version: '0.1.0' });

// ponytail: one fixed one-minute window shared by all tools; per-tool buckets if one tool starves the rest.
let windowStart = 0;
let callsInWindow = 0;
function checkRateLimit(): void {
  if (!RATE_LIMIT_PER_MINUTE) return;
  const now = Date.now();
  if (now - windowStart >= 60_000) [windowStart, callsInWindow] = [now, 0];
  if (++callsInWindow > RATE_LIMIT_PER_MINUTE) throw new ToolError('RATE_LIMITED', `more than ${RATE_LIMIT_PER_MINUTE} calls per minute`);
}

// ponytail: unbounded in-memory map, pruned on write; add an LRU cap if distinct inputs grow large.
const cache = new Map<string, { expires: number; result: CallToolResult }>();

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError('TIMEOUT', `no result within ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface ToolConfig<Shape extends z.ZodRawShape> {
  description: string;
  inputSchema: Shape;
  /** Read-only tools are marked for clients and are the only ones cached. */
  readOnly: boolean;
  destructive?: boolean;
  /** The tool reaches systems outside this server, e.g. the network. */
  openWorld?: boolean;
}

/**
 * Registers a tool with the guardrails every generated tool shares: zod input validation (done by
 * the SDK, which turns bad input into an isError result), rate limiting, caching, a timeout and
 * stderr logging. Handlers return plain data, which is sent back as JSON text.
 */
export function tool<Shape extends z.ZodRawShape>(
  name: string,
  config: ToolConfig<Shape>,
  handler: (args: z.infer<z.ZodObject<Shape>>) => unknown,
): void {
  server.registerTool(
    name,
    {
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: { readOnlyHint: config.readOnly, destructiveHint: config.destructive ?? !config.readOnly, openWorldHint: config.openWorld ?? false },
    },
    (async (args: z.infer<z.ZodObject<Shape>>): Promise<CallToolResult> => {
      const started = Date.now();
      try {
        checkRateLimit();
        const key = `${name}:${JSON.stringify(args)}`;
        const hit = cache.get(key);
        if (hit && hit.expires > started) return hit.result;
        const data = await withTimeout(Promise.resolve().then(() => handler(args)));
        const result: CallToolResult = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        if (CACHE_TTL_MS && config.readOnly) {
          for (const [k, v] of cache) if (v.expires <= started) cache.delete(k);
          cache.set(key, { expires: started + CACHE_TTL_MS, result });
        }
        log('info', 'tool call', { tool: name, ms: Date.now() - started });
        return result;
      } catch (err) {
        log('error', 'tool call failed', { tool: name, ms: Date.now() - started, error: (err as Error).message });
        const message = err instanceof ToolError ? err.message : `TOOL_ERROR: ${(err as Error).message}`;
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    }) as never, // The SDK's conditional callback type cannot resolve for a generic Shape.
  );
}

export async function start(): Promise<void> {
  await server.connect(new StdioServerTransport());
  log('info', 'server started', { name: {{name|json}}, timeoutMs: TIMEOUT_MS, rateLimitPerMinute: RATE_LIMIT_PER_MINUTE, cacheTtlMs: CACHE_TTL_MS });
}
