#!/usr/bin/env node
import { Ajv } from 'ajv';
import { z } from 'zod';
import { schema } from './schema.js';
import { start, tool, ToolError } from './server.js';

tool(
  'validate',
  {
    description: 'Validate a JSON payload against this server\'s built-in schema. Returns { valid, errors: [{ path, message }] }.',
    inputSchema: { payload: z.unknown().describe('The value to validate') },
    readOnly: true,
  },
  ({ payload }) => {
    const result = schema.safeParse(payload);
    if (result.success) return { valid: true, errors: [] };
    return { valid: false, errors: result.error.issues.map((i) => ({ path: '/' + i.path.join('/'), message: i.message })) };
  },
);

tool(
  'validate_json_schema',
  {
    description: 'Validate a JSON payload against a JSON Schema (draft-07) sent with the call. Returns { valid, errors: [{ path, message }] }.',
    inputSchema: {
      schema: z.record(z.string(), z.unknown()).describe('A JSON Schema object'),
      payload: z.unknown().describe('The value to validate'),
    },
    readOnly: true,
  },
  ({ schema: jsonSchema, payload }) => {
    // A fresh instance per call keeps caller-supplied schemas from piling up in Ajv's compile cache.
    const ajv = new Ajv({ allErrors: true, strict: false });
    let check;
    try {
      check = ajv.compile(jsonSchema);
    } catch (err) {
      throw new ToolError('INVALID_SCHEMA', (err as Error).message);
    }
    if (check(payload)) return { valid: true, errors: [] };
    return { valid: false, errors: (check.errors ?? []).map((e) => ({ path: e.instancePath || '/', message: e.message ?? 'invalid' })) };
  },
);

await start();
