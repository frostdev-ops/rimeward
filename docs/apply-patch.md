# Rime's `apply_patch` tool

`apply_patch` is a first-class **desktop** tool for targeted file changes. It accepts a project ID and a Codex-style patch string, not a shell command. Changes are saved directly to disk; use `project_edit` when an unsaved recovery-buffer edit or whole-document replacement is intended. This tool becomes available to Rime when the desktop runtime containing the implementation is built and loaded; editing the source tree alone does not hot-upgrade a packaged app.

## Calling convention

```json
{
  "reason": "Updating the greeting without replacing the whole file",
  "runtime": "desktop",
  "project": "<desktop project ID>",
  "patch": "*** Begin Patch\n*** Update File: src/greeting.ts\n@@\n-export const greeting = 'Hello';\n+export const greeting = 'Hola';\n*** End Patch"
}
```

Read the relevant context first using `project_read`. A full-file read is not required for a small context hunk. To additionally pin a previous buffer read, supply `expected_revisions`, an optional map such as `{ "src/greeting.ts": 3 }`. A zero revision means no recovery row has been created yet. If a path has recovery history, use its actual current revision. Disk identity and content hashes are checked regardless of whether this map is supplied.

The normal effective approval policy applies. This is a **confirm-kind** tool because a patch can remove or move files. Confirmation identifies the actual project folder and file operations; **Review patch** shows the complete proposed diff before approval, including after reload or remote attachment. It never executes commands or changes terminal permissions.

## Format

Start with `*** Begin Patch` and finish with `*** End Patch`. A patch can contain multiple operations:

```diff
*** Begin Patch
*** Add File: src/new-message.txt
+Hello
+World
*** Update File: src/existing-message.txt
@@
 Existing context line
-old line
+new line
*** Update File: src/old-name.txt
*** Move to: src/new-name.txt
@@
-old content
+new content
*** Delete File: src/obsolete.txt
*** End Patch
```

- **Add File:** prefix each content line with `+`. Missing parent directories are created safely. Existing destinations are never overwritten. Added nonempty files end in a newline; an empty Add operation creates an empty file.
- **Update File:** `@@` begins a hunk. A leading space retains a context line, `-` removes a line, and `+` adds a line. Blank context lines need the leading space.
- **Anchors:** `@@ exact existing line` locates a unique literal anchor and starts matching after it. Hunks match the original file in order, not text introduced by earlier hunks.
- **End of File:** `*** End of File` after a hunk requires the matched range to reach EOF. An insertion-only hunk with this marker appends at EOF. Otherwise an insertion needs context or an anchor.
- **Move to:** optional immediately after Update File; it can be used with or without content hunks. Existing destinations and colliding operations are refused.
- **Delete File:** removes a regular text file after retaining a recovery copy.

This uses familiar patch grammar with deliberately **strict matching**. No fuzzy whitespace matching, shell instructions, unified-diff line numbers, or `git apply` options are accepted. Missing or ambiguous context produces an error; read fresh context and revise the patch rather than guessing or repeating it blindly.

## Safety and limits

The parser, every context hunk, all paths, existing buffer ownership, dirty state, destination collisions, and file sizes are validated before any project file is changed. A validation error in the last operation therefore prevents earlier operations from being applied.

- Paths are portable project-relative paths, at most 200 characters; traversal, absolute paths, Windows aliases, malformed Unicode, and control characters are rejected.
- Symlinks and hard-linked files are refused, including aliases inside the project. Files must remain within the approved project and outside Rimeward's private application data.
- Dirty recovery buffers must first be saved or resolved. Another client's active ownership is never taken over, including buffers for the same physical file in overlapping registered projects.
- Existing UTF-8/UTF-16 encoding, BOM, consistent newline style, ordinary permission bits, and missing final newline are preserved. Binary, unsupported, or mixed-newline files are refused.
- Limits: 1 MiB of patch text, 20 operations, 1,000 hunks, 5 MiB per source/result file, and 20 MiB of source content in a batch. Long receipts and excessive context-search work are rejected before writes; split the patch or add a precise anchor.
- The tool rechecks parent-directory identity, file identity, mode, and content hashes before writing. New files and move destinations use no-clobber publication.
- Recovery text, original bytes, and file mode are retained in the local desktop recovery store before destructive writes. Successful receipts include recovery IDs where applicable. This does not create a Git commit or guarantee undo across arbitrary later edits.

## Receipts and partial failures

A successful result has `ok: true` and an `applied` array with operation, path, optional destination, revision, saved state, content hash, and recovery ID. It does not echo file contents.

Filesystem operations across several files are **not a global transaction**, and external programs are not locked. An I/O failure can happen after earlier writes. The failure receipt includes `ok: false`, an error, already-applied entries, a created-directory count, and recovery IDs for unapplied sources. A move that published the destination but failed to remove the source is identified as a **copy**, not a completed move. A null revision means disk publication happened before buffer persistence finished.

On such a receipt, inspect the actual files and recovery state. Do not blindly replay the patch. No automatic rollback is attempted, since that could overwrite a concurrent external change.
