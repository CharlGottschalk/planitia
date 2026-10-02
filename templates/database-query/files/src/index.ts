#!/usr/bin/env node
import pg from 'pg';
import { z } from 'zod';
import { log, start, TIMEOUT_MS, tool, ToolError } from './server.js';
import { registerTools } from './tools.js';

/** Fixed at generation time, because the tool's read-only/destructive annotations depend on it. */
const MODE: string = {{mode|json}};
const WRITE = MODE === 'read-write';
// Set at generation time. DB_ALLOWED_TABLES replaces the list at runtime: that is the operator's
// env when registering the server, which the model calling the tool cannot change.
const ALLOWED_TABLES = new Set(
  (process.env.DB_ALLOWED_TABLES ?? {{tables|json}})
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean),
);
const MAX_ROWS = 1000;
/** `off` leaves out the generic `query` tool, so only the built-in helpers and spec-defined tools remain. */
const GENERIC_TOOLS: string = {{genericTools|json}};

// ponytail: pool of 4, fine for one agent; raise `max` if several clients share one server.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
// An idle client losing its connection must not crash the server.
pool.on('error', (err) => log('error', 'idle database client failed', { error: err.message }));

type Param = string | number | boolean | null;

/**
 * The extended protocol sends values separately from the SQL, and Postgres refuses more than one
 * statement per call in it. So `SELECT 1; DELETE ...` fails instead of running the DELETE.
 */
function run(client: pg.PoolClient, text: string, values: Param[]) {
  return client.query({ text, values, queryMode: 'extended' } as pg.QueryConfig<Param[]>);
}

/** Every table the query would touch, from Postgres's own plan (views are expanded to their tables). */
function planTables(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) planTables(child, found);
  } else if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>;
    if (typeof n['Relation Name'] === 'string') found.add(`${n.Schema}.${n['Relation Name']}`.toLowerCase());
    for (const value of Object.values(n)) planTables(value, found);
  }
  return found;
}

async function checkTables(client: pg.PoolClient, sql: string, params: Param[]): Promise<void> {
  let plan;
  try {
    // EXPLAIN plans the statement without running it, including INSERT/UPDATE/DELETE.
    plan = (await run(client, `EXPLAIN (VERBOSE, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'];
  } catch (err) {
    // Statements Postgres cannot EXPLAIN (DDL, TRUNCATE, COPY, ...) can't be checked, so refuse them.
    throw new ToolError('TABLE_NOT_ALLOWED', `only statements Postgres can EXPLAIN are allowed with a table allowlist (${(err as Error).message})`);
  }
  const denied = [...planTables(plan)].filter((t) => !ALLOWED_TABLES.has(t));
  if (denied.length) throw new ToolError('TABLE_NOT_ALLOWED', `not on the allowlist: ${denied.join(', ')}`);
}

/**
 * Runs one statement in its own transaction; read-only ones run READ ONLY and always roll back.
 * `checkAllowlist` is off only for the built-in catalog queries, which filter by the allowlist themselves.
 */
async function execute(sql: string, params: Param[], readOnly: boolean, checkAllowlist = true) {
  if (!process.env.DATABASE_URL) throw new ToolError('CONFIG_ERROR', 'DATABASE_URL is not set');
  const client = await pool.connect();
  try {
    // READ ONLY is enforced by Postgres itself, not by inspecting the SQL.
    await client.query(readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN');
    // Postgres cancels the statement at the same limit as the tool timeout.
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(TIMEOUT_MS)}`);
    if (checkAllowlist && ALLOWED_TABLES.size) await checkTables(client, sql, params);
    // ponytail: loads the full result before cutting to MAX_ROWS; use a cursor if queries return huge sets.
    const result = await run(client, sql, params);
    await client.query(readOnly ? 'ROLLBACK' : 'COMMIT');
    const rows = result.rows.slice(0, MAX_ROWS);
    return {
      rowCount: result.rowCount,
      fields: result.fields.map((f) => f.name),
      rows,
      ...(result.rows.length > MAX_ROWS && { truncated: true }),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof ToolError) throw err;
    const { code, message } = err as { code?: string; message: string };
    if (code === '25006') throw new ToolError('READ_ONLY', message);
    if (code === '57014') throw new ToolError('TIMEOUT', message);
    throw new ToolError('DB_ERROR', code ? `${code} ${message}` : message);
  } finally {
    client.release();
  }
}

if (GENERIC_TOOLS === 'on') tool(
  'query',
  {
    description:
      `Run one parameterized SQL statement on Postgres${WRITE ? '' : ' in a READ ONLY transaction (writes are rejected)'}. ` +
      'Put values in `params` and refer to them as $1, $2, ... Never put values into the SQL text. ' +
      (ALLOWED_TABLES.size ? `Only these tables may be used: ${[...ALLOWED_TABLES].join(', ')}. ` : '') +
      `Returns { rowCount, fields, rows } with at most ${MAX_ROWS} rows.`,
    inputSchema: {
      sql: z.string().min(1).describe('One SQL statement, using $1, $2, ... for values'),
      params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).default([]).describe('Values for $1, $2, ...'),
    },
    readOnly: !WRITE,
  },
  ({ sql, params }) => execute(sql, params, !WRITE),
);

tool(
  'list_tables',
  {
    description: `List the tables and views this server's role can see, as schema.table names${ALLOWED_TABLES.size ? ' (only those on the allowlist)' : ''}.`,
    inputSchema: {},
    readOnly: true,
  },
  async () => {
    // information_schema only shows what the role can access; system schemas are left out.
    const result = await execute(
      `SELECT table_schema || '.' || table_name AS name FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         AND ($1::text[] IS NULL OR lower(table_schema || '.' || table_name) = ANY($1::text[]))
       ORDER BY 1`,
      [(ALLOWED_TABLES.size ? [...ALLOWED_TABLES] : null) as Param],
      true,
      false,
    );
    return { tables: result.rows.map((r) => r.name), ...(result.truncated && { truncated: true }) };
  },
);

tool(
  'describe_table',
  {
    description:
      'Describe a table or view: its columns (name, type, nullable) and primary key.' +
      (ALLOWED_TABLES.size ? ` Only tables on the allowlist: ${[...ALLOWED_TABLES].join(', ')}.` : ''),
    inputSchema: { table: z.string().regex(/^[^.\s]+\.[^.\s]+$/).describe('schema.table, e.g. public.orders') },
    readOnly: true,
  },
  async ({ table }) => {
    if (ALLOWED_TABLES.size && !ALLOWED_TABLES.has(table.toLowerCase())) throw new ToolError('TABLE_NOT_ALLOWED', `not on the allowlist: ${table}`);
    const [schema, name] = table.split('.');
    const { rows } = await execute(
      `SELECT c.column_name AS name, c.data_type AS type, c.is_nullable = 'YES' AS nullable,
              EXISTS (SELECT 1 FROM information_schema.table_constraints tc
                      JOIN information_schema.key_column_usage k USING (constraint_schema, constraint_name)
                      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema
                        AND tc.table_name = c.table_name AND k.column_name = c.column_name) AS pk
       FROM information_schema.columns c
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [schema, name],
      true,
      false,
    );
    if (!rows.length) throw new ToolError('NOT_FOUND', `no table ${table}, or this role cannot see it`);
    return {
      table,
      columns: rows.map((r) => ({ name: r.name, type: r.type, nullable: r.nullable })),
      primaryKey: rows.filter((r) => r.pk).map((r) => r.name),
    };
  },
);

// Spec-defined sql tools: fixed SQL, with the tool's params bound as $1, $2, ... in their declared
// order. A read-only server runs every one READ ONLY, whatever tools.json says.
registerTools({
  sql: (def) => (args) =>
    execute(def.sql as string, Object.keys(def.params).map((name) => (args[name] ?? null) as Param), def.readOnly || !WRITE),
});

await start();
