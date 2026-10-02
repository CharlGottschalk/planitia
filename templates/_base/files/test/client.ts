import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

/** Starts the built server over stdio, the way an MCP host does. `env` adds to the default env. */
export async function connect(env: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'smoke-test', version: '0.0.0' });
  const server = fileURLToPath(new URL('../src/index.js', import.meta.url));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: 'ignore' }));
  return client;
}

/** The first text block of a tool result. */
export function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { type: string; text: string }[])[0].text;
}
