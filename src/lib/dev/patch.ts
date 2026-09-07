/** Pure, bounded Codex-style patch parsing and exact context planning. No filesystem access. */
export const PATCH_BYTES = 1024 * 1024;
export const PATCH_FILES = 20;
type Hunk = { anchor?: string; before: string[]; after: string[]; eof: boolean };
export type PatchOperation =
  | { kind: 'add'; path: string; text: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; move?: string; hunks: Hunk[] };

export function patchPath(value: string): string {
  // Portable paths also avoid Windows drive/ADS aliases and trailing-dot normalization.
  if (!value || value.length > 200 || /[\uD800-\uDFFF]/u.test(value) || /[\\<>:"|?*\p{Cc}]/u.test(value) ||
      value.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))
    throw Error('Patch paths must be portable project-relative paths (up to 200 characters), without traversal or absolute paths.');
  return value;
}

export function parsePatch(patch: unknown): PatchOperation[] {
  if (typeof patch !== 'string' || new TextEncoder().encode(patch).length > PATCH_BYTES || patch.includes('\0'))
    throw Error('Provide a text patch of at most 1 MiB.');
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch')
    throw Error('Patch must start with *** Begin Patch and end with *** End Patch. Unified/git diffs are unsupported.');
  const operations: PatchOperation[] = [];
  let i = 0, hunks = 0;
  const header = () => /^(\*\*\* (Add|Update|Delete) File: )/.test(lines[i] ?? '');
  const fail = (message: string): never => { throw Error(`Patch line ${i + 2}: ${message}`); };
  while (i < lines.length) {
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i++] ?? '');
    if (!match) return fail('Expected *** Add File:, *** Update File:, or *** Delete File:.');
    const file = patchPath(match[2] ?? '');
    if (operations.length >= PATCH_FILES) fail(`Use at most ${PATCH_FILES} file operations per patch.`);
    if (match[1] === 'Delete') { operations.push({ kind: 'delete', path: file }); continue; }
    if (match[1] === 'Add') {
      const content: string[] = [];
      while (i < lines.length && !header()) {
        const line = lines[i++] ?? '';
        if (!line.startsWith('+')) fail('Every added file line must start with +.');
        content.push(line.slice(1));
      }
      operations.push({ kind: 'add', path: file, text: content.length ? `${content.join('\n')}\n` : '' });
      continue;
    }
    const op: Extract<PatchOperation, { kind: 'update' }> = { kind: 'update', path: file, hunks: [] };
    if (lines[i]?.startsWith('*** Move to: ')) op.move = patchPath((lines[i++] ?? '').slice(13));
    while (i < lines.length && !header()) {
      const hunk: Hunk = { before: [], after: [], eof: false };
      const marker = lines[i] ?? '';
      if (marker === '@@' || marker.startsWith('@@ ')) {
        i++;
        if (/^@@ [+-]\d/.test(marker)) fail('Unified diff line numbers are unsupported; use @@ or @@ followed by an exact anchor line.');
        if (marker !== '@@') hunk.anchor = marker.slice(3);
      } else if (op.hunks.length) fail('Expected @@ before the next hunk.');
      let changed = false;
      while (i < lines.length && !header() && !lines[i]?.startsWith('@@')) {
        const line = lines[i++] ?? '';
        if (line === '*** End of File') { hunk.eof = true; break; }
        if (![' ', '+', '-'].includes(line[0] ?? '')) fail('Hunk lines must start with a space, +, or -.');
        if (line[0] !== '+') hunk.before.push(line.slice(1));
        if (line[0] !== '-') hunk.after.push(line.slice(1));
        if (line[0] !== ' ') changed = true;
      }
      if (!changed) fail('A hunk must add or remove a line.');
      if (++hunks > 1000) fail('Use at most 1000 hunks per patch.');
      op.hunks.push(hunk);
      if (hunk.eof && i < lines.length && !header()) fail('*** End of File must finish the file operation.');
    }
    if (!op.hunks.length && !op.move) fail('Update requires a hunk or *** Move to:.');
    operations.push(op);
  }
  if (!operations.length) throw Error('Patch contains no file operations.');
  return operations;
}

export function patchText(text: string, op: Extract<PatchOperation, { kind: 'update' }>): string {
  const finalNewline = text.endsWith('\n');
  const lines = text === '' ? [] : (finalNewline ? text.slice(0, -1) : text).split('\n');
  const output: string[] = [];
  let cursor = 0, budget = 2_000_000;
  // ponytail: bounded exact scan; use a linear matcher if large repetitive files hit this limit.
  const locate = (needle: string[], from: number, eof: boolean) => {
    let found = -1;
    for (let at = eof ? Math.max(from, lines.length - needle.length) : from; at + needle.length <= lines.length; at++) {
      let matches = true;
      for (let n = 0; n < needle.length; n++) {
        if (--budget < 0) throw Error(`${op.path}: context search limit exceeded; narrow the patch with an exact @@ anchor.`);
        if (lines[at + n] !== needle[n]) { matches = false; break; }
      }
      if (matches) {
        if (found !== -1) throw Error(`${op.path}: ambiguous context; include more context or an exact @@ anchor.`);
        found = at;
      }
    }
    if (found === -1) throw Error(`${op.path}: context not found exactly; read the current file before retrying.`);
    return found;
  };
  for (const hunk of op.hunks) {
    const from = hunk.anchor === undefined ? cursor : locate([hunk.anchor], cursor, false) + 1;
    let at: number;
    if (hunk.before.length) at = locate(hunk.before, from, hunk.eof);
    else if (hunk.eof) at = lines.length;
    else if (hunk.anchor !== undefined || !lines.length) at = from;
    else throw Error(`${op.path}: insertion needs context, an exact @@ anchor, or *** End of File.`);
    // All hunks match the original file, in order; inserted text never becomes later context.
    for (let n = cursor; n < at; n++) output.push(lines[n] ?? '');
    for (const line of hunk.after) output.push(line);
    cursor = at + hunk.before.length;
  }
  for (let n = cursor; n < lines.length; n++) output.push(lines[n] ?? '');
  return output.join('\n') + (output.length && (finalNewline || !text) ? '\n' : '');
}
