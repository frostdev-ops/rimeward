/** Pure, bounded Codex-style patch parsing and context planning. No filesystem access. */
export const PATCH_BYTES = 1024 * 1024;
export const PATCH_FILES = 20;
export const PATCH_EDIT_GUIDANCE = 'Use apply_patch for hand-authored text-file additions, edits, moves, and deletions. Read relevant context first and use focused patches. Use terminal commands for inspection, builds, tests, Git, formatters, and generators.';
type Hunk = { anchor?: string; before: string[]; after: string[]; context: [number, number][]; eof: boolean };
export type PatchOperation =
  | { kind: 'add'; path: string; text: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; move?: string; hunks: Hunk[] };

export function patchPath(value: string): string {
  // Portable paths also avoid Windows drive/ADS aliases and trailing-dot normalization.
  if (!value || value.length > 200 || /[\uD800-\uDFFF]/u.test(value) || /[\\<>:"|?*\p{Cc}]/u.test(value) ||
      value.replace(/^\//, '').split('/').some(s => !s || s === '.' || s === '..' || s.toLowerCase() === '.git' || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))
    throw Error('Patch paths must be portable workspace paths (up to 200 characters), without traversal. A leading / means the virtual workspace root.');
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
      const hunk: Hunk = { before: [], after: [], context: [], eof: false };
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
        if (line[0] === ' ') hunk.context.push([hunk.before.length, hunk.after.length]);
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

export function planPatch(text: string, op: Extract<PatchOperation, { kind: 'update' }>) {
  const finalNewline = text.endsWith('\n');
  const lines = text === '' ? [] : (finalNewline ? text.slice(0, -1) : text).split('\n');
  const replacements: { at: number; before: number; after: string[]; context: Hunk['context'] }[] = [];
  let cursor = 0, budget = 2_000_000;
  // Codex seek_sequence.rs, 21aa552e8727c03189d0f7d18bbd6e7583e88f88.
  const trimEnd = (line: string) => line.replace(/\p{White_Space}+$/u, '');
  const trim = (line: string) => trimEnd(line).replace(/^\p{White_Space}+/u, '');
  const normalize = (line: string) => trim(line)
    .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u2018-\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, '"').replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
  // ponytail: bounded scan; use a linear matcher if large repetitive files hit this limit.
  const locate = (needle: string[], from: number, eof: boolean) => {
    if (!needle.length) return from;
    for (const transform of [(s: string) => s, trimEnd, trim, normalize]) {
      for (let at = eof ? Math.max(from, lines.length - needle.length) : from; at + needle.length <= lines.length; at++) {
        let matches = true;
        for (let n = 0; n < needle.length; n++) {
          if (--budget < 0) throw Error(`${op.path}: context search limit exceeded; narrow the patch with an @@ anchor.`);
          if (transform(lines[at + n] ?? '') !== transform(needle[n] ?? '')) { matches = false; break; }
        }
        if (matches) return at;
      }
    }
    return -1;
  };
  for (const hunk of op.hunks) {
    if (hunk.anchor !== undefined) {
      const anchor = locate([hunk.anchor], cursor, false);
      if (anchor < 0) throw Error(`${op.path}: anchor not found; read the current file before retrying.`);
      cursor = anchor + 1;
    }
    // Codex insertion-only hunks append, including after an anchor.
    if (!hunk.before.length) { replacements.push({ at: lines.length, before: 0, after: hunk.after, context: [] }); continue; }
    let before = hunk.before, after = hunk.after.slice();
    let at = locate(before, cursor, hunk.eof);
    if (at < 0 && before.at(-1) === '') {
      before = before.slice(0, -1);
      if (after.at(-1) === '') after.pop();
      at = locate(before, cursor, hunk.eof);
    }
    if (at < 0) throw Error(`${op.path}: context not found; read the current file before retrying.`);
    // A tolerant match must not rewrite unchanged context's indentation or punctuation.
    for (const [oldIndex, newIndex] of hunk.context) if (oldIndex < before.length && newIndex < after.length) after[newIndex] = lines[at + oldIndex] ?? '';
    replacements.push({ at, before: before.length, after, context: hunk.context.filter(([oldIndex,newIndex]) => oldIndex < before.length && newIndex < after.length) });
    cursor = at + before.length;
  }
  return { lines, finalNewline, replacements: replacements.sort((a,b) => a.at - b.at) };
}

export function patchText(text: string, op: Extract<PatchOperation, { kind: 'update' }>): string {
  const { lines, finalNewline, replacements } = planPatch(text, op);
  const output: string[] = [];
  let cursor = 0;
  // Hunks match the original file; appended text never becomes later context.
  for (const change of replacements) {
    for (; cursor < change.at; cursor++) output.push(lines[cursor] ?? '');
    for (const line of change.after) output.push(line);
    cursor = change.at + change.before;
  }
  for (let n = cursor; n < lines.length; n++) output.push(lines[n] ?? '');
  return output.join('\n') + (output.length && (finalNewline || !text) ? '\n' : '');
}
