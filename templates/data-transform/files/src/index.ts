#!/usr/bin/env node
import { z } from 'zod';
import { formatCsv, parseCsv, toRecords } from './csv.js';
import { start, tool } from './server.js';

const delimiter = z
  .string()
  .regex(/^[^"\r\n]$/, 'one character, not a quote or newline')
  .default(',')
  .describe('Field separator, e.g. "," ";" or a tab');
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

tool(
  'csv_to_json',
  {
    description:
      'Parse CSV text (RFC 4180: quoted fields may contain delimiters, "" and newlines). With header=true (default) returns { rows: [{ column: value }] }; otherwise { rows: [[value]] }. Values are always strings.',
    inputSchema: {
      csv: z.string().describe('The CSV text'),
      delimiter,
      header: z.boolean().default(true).describe('Treat the first row as column names'),
    },
    readOnly: true,
  },
  ({ csv, delimiter, header }) => {
    const rows = parseCsv(csv, delimiter);
    return { rows: header ? toRecords(rows) : rows };
  },
);

tool(
  'json_to_csv',
  {
    description:
      'Format rows as CSV text. Objects give a header row of every key (in first-seen order), and a missing key is an empty field. Arrays give plain lines. null is an empty field. Returns { csv }.',
    inputSchema: {
      rows: z
        .union([z.array(z.record(z.string(), cell)), z.array(z.array(cell))])
        .describe('An array of flat objects, or an array of arrays'),
      delimiter,
    },
    readOnly: true,
  },
  ({ rows, delimiter }) => ({ csv: formatCsv(rows, delimiter) }),
);

await start();
