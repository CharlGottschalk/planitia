import { ToolError } from './server.js';

export type Cell = string | number | boolean | null;

function malformed(row: number, message: string): ToolError {
  return new ToolError('INVALID_CSV', `row ${row}: ${message}`);
}

/**
 * Strict RFC 4180 parsing: quoted fields may hold delimiters, `""` and newlines. CRLF, LF and a
 * leading BOM are accepted. A stray or unterminated quote is an error, not a guess.
 */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endField = () => {
    row.push(field);
    field = '';
    quoted = false;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      if (field !== '' || quoted) throw malformed(rows.length + 1, 'quote inside an unquoted field');
      quoted = true;
      i++;
      for (;;) {
        if (i >= text.length) throw malformed(rows.length + 1, 'unterminated quoted field');
        const q = text[i++];
        if (q !== '"') {
          field += q;
        } else if (text[i] === '"') {
          field += '"';
          i++;
        } else {
          break;
        }
      }
      const next = text[i];
      if (next !== undefined && next !== delimiter && next !== '\n' && next !== '\r') {
        throw malformed(rows.length + 1, 'text after a closing quote');
      }
    } else if (c === delimiter) {
      endField();
      i++;
    } else if (c === '\n' || c === '\r') {
      endField();
      rows.push(row);
      row = [];
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  // A final line without a trailing newline.
  if (field !== '' || quoted || row.length) {
    endField();
    rows.push(row);
  }
  return rows;
}

/** Uses the first row as column names. Every row must have exactly that many fields. */
export function toRecords(rows: string[][]): Record<string, string>[] {
  const [columns = [], ...body] = rows;
  const seen = new Set<string>();
  for (const c of columns) {
    if (seen.has(c)) throw malformed(1, `duplicate column name "${c}"`);
    seen.add(c);
  }
  return body.map((fields, n) => {
    if (fields.length !== columns.length) {
      throw malformed(n + 2, `expected ${columns.length} fields, got ${fields.length}`);
    }
    return Object.fromEntries(columns.map((c, j) => [c, fields[j]]));
  });
}

function formatCell(value: Cell, delimiter: string): string {
  const s = value === null ? '' : String(value);
  return s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * Objects become a header row plus one line per object. The columns are every key, in the
 * order each key first appears, and a missing key is an empty field. Arrays become plain lines.
 */
export function formatCsv(rows: Record<string, Cell>[] | Cell[][], delimiter: string): string {
  let lines: Cell[][];
  if (rows.every(Array.isArray)) {
    lines = rows as Cell[][];
  } else {
    const records = rows as Record<string, Cell>[];
    const columns = [...new Set(records.flatMap(Object.keys))];
    lines = [columns, ...records.map((r) => columns.map((c) => r[c] ?? null))];
  }
  return lines.map((line) => line.map((v) => formatCell(v, delimiter)).join(delimiter) + '\n').join('');
}
