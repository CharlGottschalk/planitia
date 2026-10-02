#!/usr/bin/env node
import { z } from 'zod';
import { start, tool } from './server.js';

/** Set at generation time from the template's `greeting` input. */
const GREETING: string = {{greeting|json}};

// An example tool: replace it with your own. tool() adds input validation, the timeout, rate
// limit, cache and logging from server.ts; return plain data and it is sent back as JSON.
tool(
  'greet',
  {
    description: 'Greet someone by name. Returns { message }.',
    inputSchema: { name: z.string().min(1).max(100).describe('Who to greet') },
    readOnly: true,
  },
  ({ name }) => ({ message: `${GREETING}, ${name}!` }),
);

await start();
