# Rime's `apply_patch` tool

`apply_patch` edits files in the agent's bound workspace. The harness supplies the workspace and its mounted roots; the model supplies the patch. Changes save directly to disk. Use `workspace_edit` for intentional whole-file recovery-buffer replacement. Source changes take effect only after the corresponding runtimes are rebuilt and installed.

## Calling convention

Capable Responses models receive a raw-text custom tool:

```diff
*** Begin Patch
*** Update File: src/greeting.ts
@@
-export const greeting = 'Hello';
+export const greeting = 'Hola';
*** End Patch
```

The harness derives the raw call's activity label from its operations. Other models receive the JSON function form:

```json
{
  "reason": "Updating the greeting without replacing the whole file",
  "patch": "*** Begin Patch\n*** Update File: src/greeting.ts\n@@\n-export const greeting = 'Hello';\n+export const greeting = 'Hola';\n*** End Patch"
}
```

Read relevant context first using `workspace_read`. A full-file read is unnecessary for a focused hunk. JSON calls can additionally supply `expected_revisions`, such as `{ "/src/greeting.ts": 3 }`; zero means no recovery row exists. Disk identity and content hashes are checked in both forms. Project, device and runtime overrides are not accepted on workspace tools.

The normal approval policy applies. This remains a **confirm-kind** tool because patches can remove or move files. Confirmation identifies the workspace, mounts and operations; **Review patch** shows the exact proposed patch, including after reload. A confirmation retains its original workspace binding and fails if that binding changes. Accepted, declined, cancelled and interrupted raw calls retain correctly paired custom-tool outputs in history.

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
- **Anchors:** `@@ existing line` finds the first anchor in the strongest matching pass and starts matching after it. Hunks match the original file, not text introduced by earlier hunks.
- **End of File:** `*** End of File` requires the matched range to reach EOF. Insertion-only hunks append even without this marker. A trailing empty context line may be omitted during matching when it represents the source's final newline.
- **Move to:** optional immediately after Update File; it can be used with or without content hunks. Existing destinations and colliding operations are refused.
- **Delete File:** removes a regular text file after retaining a recovery copy.

Matching searches the eligible range in complete passes: exact text, trailing whitespace ignored, leading and trailing whitespace ignored, then Codex's limited Unicode punctuation and unusual-space normalization. The first match in the strongest successful pass wins; a later exact match beats an earlier whitespace-only match. Unchanged context keeps its original text, while added/replacement lines remain exactly as authored. Missing context is an error. Shell instructions, numbered unified diffs and Git options are unsupported. Matcher behavior follows Codex source revision `21aa552e8727c03189d0f7d18bbd6e7583e88f88`; Rimeward retains its own encoding, limits and filesystem safeguards.

## Safety and limits

The parser, every context hunk, all paths, existing buffer ownership, dirty state, destination collisions, and file sizes are validated before any project file is changed. A validation error in the last operation therefore prevents earlier operations from being applied.

- Paths are portable virtual workspace paths, at most 200 characters. A leading `/` means the workspace root; it never denotes a host OS path. Traversal, Windows aliases, malformed Unicode and control characters are rejected.
- Symlinks and hard-linked files are refused, including aliases inside the project. Files must remain within the approved project and outside Rimeward's private application data.
- Dirty recovery buffers must first be saved or resolved. Another client's active ownership is never taken over, including buffers for the same physical file in overlapping registered projects.
- Existing UTF-8/UTF-16 encoding, BOM, consistent newline style, ordinary permission bits, and missing final newline are preserved. Binary, unsupported, or mixed-newline files are refused.
- Limits: 1 MiB of patch text, 20 operations, 1,000 hunks, 5 MiB per source/result file, and 20 MiB of source content in a batch. Long receipts and excessive context-search work are rejected before writes; split the patch or add a precise anchor.
- The tool rechecks parent-directory identity, file identity, mode, and content hashes before writing. New files and move destinations use no-clobber publication.
- Recovery text, original bytes and file mode remain in the serving runtime's local recovery store. SSH recovery stays on its gateway. Successful receipts include recovery IDs where applicable. This neither creates a Git commit nor guarantees undo across later edits.

All mounted roots prepare before any commit. Canonical file reservations prevent overlapping roots from bypassing editor ownership. Cross-root patch moves are rejected; `workspace_transfer` performs explicit copy/verify/delete. SSH writes require Linux/macOS `stat` and `sync` plus OpenSSH fsync, hardlink and atomic-rename extensions; unsupported guarantees cause preflight refusal. External processes remain outside these reservations, including the SSH hash-check-to-rename interval.

`workspace_transfer` also handles directories. Same-root moves rename the existing tree. Cross-root transfers inventory at most 1,000 entries and 100 MiB total, with 5 MiB per file, before creating a destination. Links, Git metadata, incomplete inventories and colliding destinations are refused. Every destination file is verified before any source deletion; later changes or failures leave explicit partial receipts. One operation ID covers the transfer's per-path phases. Read `workspace_receipt` with a virtual `path` and follow `next` using `cursor` for large receipts; omit the operation ID to find recent receipts after a lost response.

## Receipts and partial failures

A successful result has `ok: true`, an `operationId` and an `applied` array containing operation, virtual path, optional destination, revision, saved state, content hash and recovery ID. It does not echo file contents. `workspace_receipt(operation_id)` reads durable per-root status after a lost response or restart, without replaying a mutation.

Filesystem operations across several files are **not a global transaction**, and external programs are not locked. An I/O failure can happen after earlier writes. The failure receipt includes `ok: false`, an error, already-applied entries, a created-directory count, and recovery IDs for unapplied sources. A move that published the destination but failed to remove the source is identified as a **copy**, not a completed move. A null revision means disk publication happened before buffer persistence finished.

On such a receipt, inspect files, operation status and recovery. Even a lost response to the first commit can mean writes happened; an empty `applied` array does not prove otherwise. No automatic replay or rollback is attempted. Custom-tool fallback changes only the tool encoding on an explicit OpenAI pre-inference rejection, on the same model; dropped inference connections and incomplete streams are not retried.
