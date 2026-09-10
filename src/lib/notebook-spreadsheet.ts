/** A single bounded sheet; formulas are parsed, never executed as JavaScript. */
export const SHEET_ROWS = 200;
export const SHEET_COLS = 52;
export type SheetFormat = 'auto' | 'text' | 'number' | 'currency' | 'percent';
export interface SheetCell { value: string; format?: SheetFormat; bold?: boolean; italic?: boolean; align?: 'left' | 'center' | 'right'; color?: string; fill?: string }
export interface SheetState { version: 1; rows: number; cols: number; cells: Record<string, SheetCell>; widths: Record<string, number>; heights: Record<string, number> }
export function columnName(index: number): string { let result = ''; for (index++; index > 0; index = Math.floor((index - 1) / 26)) result = String.fromCharCode(65 + (index - 1) % 26) + result; return result; }
export function cellName(row: number, col: number): string { return `${columnName(col)}${row + 1}`; }
export function cellPosition(ref: string): [number, number] | null { const m = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,5})$/i.exec(ref); if (!m) return null; let col = 0; for (const c of m[1].toUpperCase()) col = col * 26 + c.charCodeAt(0) - 64; return [Number(m[2]) - 1, col - 1]; }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function normalizeSheet(value: unknown): SheetState {
  const v = record(value) ? value : {};
  const bounded = (n: unknown, fallback: number, max: number) => typeof n === 'number' && Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback;
  const result: SheetState = { version: 1, rows: bounded(v.rows, 30, SHEET_ROWS), cols: bounded(v.cols, 10, SHEET_COLS), cells: {}, widths: {}, heights: {} };
  if (record(v.cells)) for (const [key, cell] of Object.entries(v.cells).slice(0, SHEET_ROWS * SHEET_COLS)) {
    const pos = cellPosition(key); if (!pos || pos[0] >= result.rows || pos[1] >= result.cols || !record(cell)) continue;
    const out: SheetCell = { value: typeof cell.value === 'string' ? cell.value.slice(0, 10000) : '' };
    if (['auto', 'text', 'number', 'currency', 'percent'].includes(String(cell.format))) out.format = cell.format as SheetFormat;
    if (cell.bold === true) out.bold = true; if (cell.italic === true) out.italic = true;
    if (['left', 'center', 'right'].includes(String(cell.align))) out.align = cell.align as SheetCell['align'];
    if (typeof cell.color === 'string' && /^#[0-9a-f]{6}$/i.test(cell.color)) out.color = cell.color;
    if (typeof cell.fill === 'string' && /^#[0-9a-f]{6}$/i.test(cell.fill)) out.fill = cell.fill;
    result.cells[cellName(...pos)] = out;
  }
  for (const [kind, max, min, limit] of [['widths', result.cols, 50, 600], ['heights', result.rows, 24, 240]] as const) {
    if (record(v[kind])) for (const [key, n] of Object.entries(v[kind])) if (/^\d+$/.test(key) && +key < max && typeof n === 'number' && Number.isFinite(n)) result[kind][key] = Math.min(limit, Math.max(min, n));
  }
  return result;
}
export type CellValue = number | string | boolean;
type FormulaValue = CellValue | CellValue[];
class FormulaError extends Error {}
const fail = (message: string): never => { throw new FormulaError(message); };
const number = (v: FormulaValue): number => { if (Array.isArray(v)) return fail('#VALUE!'); if (typeof v === 'number') return v; if (typeof v === 'boolean') return +v; if (v === '') return 0; const n = Number(v); return Number.isFinite(n) ? n : fail('#VALUE!'); };
export function sheetEvaluator(state: SheetState): (name: string) => CellValue {
  const cache = new Map<string, CellValue>(); const visiting = new Set<string>(); let budget = 200000;
  function resolve(name: string): CellValue {
    if (--budget < 0) return fail('#LIMIT!');
    const pos = cellPosition(name); if (!pos || pos[0] >= state.rows || pos[1] >= state.cols) return fail('#REF!');
    name = cellName(...pos); if (visiting.has(name) || visiting.size > 100) return fail('#CYCLE!'); if (cache.has(name)) { const value = cache.get(name)!; if (typeof value === 'string' && /^#(REF|VALUE|DIV\/0|NAME\?|ERROR|CYCLE|LIMIT|NUM|N\/A)/.test(value)) return fail(value); return value; }
    const cell = state.cells[name]; const raw = cell?.value ?? ''; let value: CellValue = raw;
    if (cell?.format === 'text' || raw.startsWith("'")) value = raw.startsWith("'") ? raw.slice(1) : raw;
    else if (raw.startsWith('=')) { visiting.add(name); try { value = parse(raw.slice(1)); } finally { visiting.delete(name); } }
    else if (raw.trim() && Number.isFinite(Number(raw))) value = Number(raw);
    cache.set(name, value); return value;
  }
  function parse(source: string): CellValue {
    const tokens: string[] = []; const re = /\s*(#REF!|\$?[A-Za-z]+\$?\d+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|"(?:[^"]|"")*"|[A-Za-z_]+|<>|<=|>=|[+\-*/^%(),:=<>&])/gy; let offset = 0;
    while (offset < source.length) { if (!source.slice(offset).trim()) break; re.lastIndex = offset; const match = re.exec(source); if (!match) return fail('#ERROR!'); tokens.push(match[1]); offset = re.lastIndex; if (tokens.length > 1000) return fail('#LIMIT!'); }
    let cursor = 0; let depth = 0;
    const peek = () => tokens[cursor]; const take = () => tokens[cursor++];
    function primary(): FormulaValue {
      if (++depth > 100) return fail('#LIMIT!');
      let value: FormulaValue; const token = take(); if (!token) return fail('#ERROR!');
      if (token === '+' || token === '-') value = (token === '-' ? -1 : 1) * number(primary());
      else if (token === '(') { value = expression(0); if (take() !== ')') return fail('#ERROR!'); }
      else if (token.startsWith('"')) value = token.slice(1, -1).replaceAll('""', '"');
      else if (token === '#REF!') return fail('#REF!');
      else if (/^\d|^\./.test(token)) value = Number(token);
      else if (cellPosition(token)) {
        if (peek() === ':') { take(); const end = cellPosition(take() ?? ''); const start = cellPosition(token)!; if (!end || end[0] >= state.rows || end[1] >= state.cols || start[0] >= state.rows || start[1] >= state.cols) return fail('#REF!'); value = []; for (let r = Math.min(start[0], end[0]); r <= Math.max(start[0], end[0]); r++) for (let c = Math.min(start[1], end[1]); c <= Math.max(start[1], end[1]); c++) value.push(resolve(cellName(r, c))); }
        else value = resolve(token);
      } else if (token.toUpperCase() === 'TRUE' || token.toUpperCase() === 'FALSE') value = token.toUpperCase() === 'TRUE';
      else {
        if (take() !== '(') return fail('#NAME?');
        if (token.toUpperCase() === 'IF') {
          const branches: string[][] = [[]]; let nesting = 0;
          while (peek() && !(peek() === ')' && nesting === 0)) {
            const part = take(); if (part === ',' && nesting === 0) branches.push([]);
            else { if (part === '(') nesting++; if (part === ')') nesting--; branches[branches.length - 1].push(part); }
          }
          if (take() !== ')' || branches.length < 2 || branches.length > 3) return fail('#VALUE!');
          const condition = parse(branches[0].join(' ')); const branch = branches[condition ? 1 : 2];
          value = branch ? parse(branch.join(' ')) : false;
          if (peek() === '%') { take(); value = number(value) / 100; }
          depth--; return value;
        }
        const args: FormulaValue[] = [];
        if (peek() !== ')') { do { args.push(expression(0)); if (peek() !== ',') break; take(); } while (true); }
        if (take() !== ')') return fail('#ERROR!');
        const flat = args.flat(); const nums = flat.filter((x): x is number => typeof x === 'number');
        switch (token.toUpperCase()) {
          case 'SUM': value = nums.reduce((a, b) => a + b, 0); break;
          case 'AVERAGE': value = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : fail('#DIV/0!'); break;
          case 'MIN': value = nums.length ? Math.min(...nums) : 0; break;
          case 'MAX': value = nums.length ? Math.max(...nums) : 0; break;
          case 'COUNT': value = nums.length; break;
          case 'COUNTA': value = flat.filter(x => x !== '').length; break;
          case 'ABS': if (args.length !== 1) return fail('#VALUE!'); value = Math.abs(number(args[0])); break;
          case 'ROUND': { if (args.length < 1 || args.length > 2) return fail('#VALUE!'); const places = number(args[1] ?? 0); if (Math.abs(places) > 100) return fail('#NUM!'); const p = 10 ** Math.trunc(places); value = Math.round(number(args[0]) * p) / p; break; }
          case 'AND': value = flat.every(Boolean); break;
          case 'OR': value = flat.some(Boolean); break;
          case 'NOT': if (args.length !== 1) return fail('#VALUE!'); value = !args[0]; break;
          default: return fail('#NAME?');
        }
      }
      if (peek() === '%') { take(); value = number(value) / 100; }
      depth--; return value;
    }
    const precedence: Record<string, number> = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
    function expression(min: number): FormulaValue {
      let left = primary();
      while (peek() && (precedence[peek()] ?? -1) >= min) { const op = take(); const right = expression(precedence[op] + (op === '^' ? 0 : 1));
        if (op === '&') left = String(left) + String(right);
        else if (['=', '<>', '<', '>', '<=', '>='].includes(op)) { if (Array.isArray(left) || Array.isArray(right)) return fail('#VALUE!'); if (op === '=') left = left === right; else if (op === '<>') left = left !== right; else if (op === '<') left = left < right; else if (op === '>') left = left > right; else if (op === '<=') left = left <= right; else left = left >= right; }
        else { const a = number(left), b = number(right); if (op === '+') left = a + b; if (op === '-') left = a - b; if (op === '*') left = a * b; if (op === '/') left = b === 0 ? fail('#DIV/0!') : a / b; if (op === '^') left = a ** b; }
      } return left;
    }
    const value = expression(0); if (cursor !== tokens.length || Array.isArray(value)) return fail('#ERROR!'); if (typeof value === 'number' && !Number.isFinite(value)) return fail('#NUM!'); return value;
  }
  return name => { try { return resolve(name); } catch (error) { return error instanceof FormulaError ? error.message : '#ERROR!'; } };
}
export function displayCell(cell: SheetCell | undefined, value: CellValue): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'; if (typeof value !== 'number') return value;
  if (cell?.format === 'currency') return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
  if (cell?.format === 'percent') return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 2 }).format(value);
  if (cell?.format === 'number') return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value);
  return String(Number(value.toPrecision(12)));
}
export function parseDelimited(text: string, delimiter: ',' | '\t'): string[][] {
  if (text.length > 2_000_000) throw new Error('Import is limited to 2 MB.');
  text = text.replace(/^\uFEFF/, ''); const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) { const ch = text[i]; if (ch === '"' && (quoted || field === '')) { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (ch === delimiter || ch === '\n' || ch === '\r')) { row.push(field); field = ''; if (ch !== delimiter) { rows.push(row); row = []; if (ch === '\r' && text[i + 1] === '\n') i++; } }
    else field += ch;
    if (row.length > SHEET_COLS || rows.length > SHEET_ROWS || field.length > 10000) throw new Error(`Use at most ${SHEET_ROWS} rows, ${SHEET_COLS} columns and 10,000 characters per cell.`);
  }
  if (quoted) throw new Error('A quoted field is missing its closing quote.');
  if (field || row.length || !rows.length) { row.push(field); rows.push(row); }
  if (rows.length > SHEET_ROWS || rows.some(r => r.length > SHEET_COLS)) throw new Error(`Use at most ${SHEET_ROWS} rows and ${SHEET_COLS} columns.`); return rows;
}
export const writeDelimited = (rows: string[][], delimiter: ',' | '\t'): string => rows.map(row => row.map(v => /["\r\n]/.test(v) || v.includes(delimiter) ? `"${v.replaceAll('"', '""')}"` : v).join(delimiter)).join('\r\n');
/** References track inserted/deleted rows and columns, including absolute references. */
export function reshapeSheet(state: SheetState, axis: 'row' | 'column', index: number, remove: boolean): void {
  const at = axis === 'row' ? 0 : 1, size = axis === 'row' ? 'rows' : 'cols';
  if (remove && state[size] <= 1) throw new Error('Keep at least one row and column.'); if (!remove && state[size] >= (axis === 'row' ? SHEET_ROWS : SHEET_COLS)) throw new Error('Sheet size limit reached.');
  const next: SheetState['cells'] = {};
  for (const [key, cell] of Object.entries(state.cells)) { const pos = cellPosition(key)!; if (remove && pos[at] === index) continue; if (pos[at] >= index) pos[at] += remove ? -1 : 1;
    const updated = { ...cell }; if (updated.value.startsWith('=') && updated.format !== 'text') updated.value = updated.value.replace(/"(?:[^"]|"")*"|(\$?[A-Za-z]{1,3})(\$?)([1-9]\d*)/g, (match, col: string | undefined, dollar: string, row: string) => { if (!col) return match; const ref = cellPosition(`${col}${dollar}${row}`)!; if (remove && ref[at] === index) return '#REF!'; if (ref[at] >= index) ref[at] += remove ? -1 : 1; return `${col.startsWith('$') ? '$' : ''}${columnName(ref[1])}${dollar}${ref[0] + 1}`; }); next[cellName(...pos)] = updated;
  }
  const sizes = axis === 'row' ? 'heights' : 'widths', dimensions: Record<string, number> = {};
  for (const [key, val] of Object.entries(state[sizes])) { if (remove && +key === index) continue; dimensions[+key >= index ? +key + (remove ? -1 : 1) : key] = val; }
  state.cells = next; state[sizes] = dimensions; state[size] += remove ? -1 : 1;
}
