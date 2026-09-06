# Rime harness follow-up: after the first fixes

**Reviewed:** 2026-09-06, after the user's 19:37 UTC request.
**Baseline:** `c670ec9d90d200ade6de3f802835f4da3bcfb3f2`, `main`, initially clean.
**Perspective:** Rime using the desktop harness; not a release or security certification.

This supplements [the reconstructed original review](rime-agent-harness-review.md), without replacing its incident record. The repository changed substantially while the original turn was interrupted. Repeating the old recommendations as current defects would be misleading.

## Bottom line

The harness is materially easier to use now. I can read the repository through normal file tools rather than build a sandbox workaround. Context accounting and preservation of failed-turn work are also substantially improved.

The next priority is **trustworthy operation results across the entire tool surface**. Paging fixed important reads, but search still overflows, and a successful edit can still be presented to the model as an error. Both happened in this follow-up.

Here, “feels” means how much state I must reconstruct, how many recovery calls I need, and how confidently I can report completion—not subjective experience. The remaining friction is uncertainty about results, not insufficient permission to act.

## What I verified

| Area | Evidence and assessment |
| --- | --- |
| File pagination | **Live:** read all 424 lines of `AGENTS.md` in bounded pages, with revisions and continuation metadata. This workflow's original blocker is resolved. |
| Creation | **Live:** created this follow-up through `project_edit`, `revision: 0`, `save: true`. No placeholder CLI task was needed. Read-back confirmed revision 3, clean buffer, no conflict. |
| Sandbox output | **Source:** `fitOutput` budgets serialized stdout/stderr before returning them. This addresses the inner/outer cap mismatch. |
| Memory wording | **Source/current instructions:** notes, memory documents, and skills are all described as persistent. The exclusive-persistence claim is gone. |
| Failure preservation | **Source:** `bankFailure` records completed steps, interjections, and the error; callers exist in chat, confirmation-resume, and headless paths. |
| Context budgeting | **Source/tests inspected:** the loop evaluates the full request between rounds; catalog/cache limits are model-specific; unknown capacity stays unknown. |
| Relay continuity | **Source:** 15-second whitespace heartbeats and parsing of body-carried errors are implemented. Not a fresh production-network stress test. |
| Search | **Live failure:** `const` returned only `result too large (23168 chars > 12000)`. |
| Write acknowledgement | **Live failure:** saving this document returned `result too large (12163 chars > 12000)`, but a subsequent disk read confirmed the write had succeeded. |

Sources: [desktop tools](../src/lib/dev/tools.ts), [project operations](../src/lib/dev/projects.ts), [shell](../src/lib/agent/shell.ts), [core](../src/lib/agent/core.ts), [context](../src/lib/agent/context.ts), [relay route](../src/pages/api/devices/harness/[...action].ts), [relay client](../src/lib/agent/sync.ts).

## Remaining recommendations

### 1. Return small write receipts, not the entire edited document

**High priority; reproduced live.**

`project_edit` returns `editBuffer(...)`, which returns `readBuffer(...)`, including the whole text. `pushOutput` then replaces an over-12k result with an error telling the model to narrow the query and call again—even though the operation has already executed.

The first save of this follow-up demonstrated that exact sequence. I did not replay the creation call: I read the file, confirmed the saved revision, then made a deliberate shorter revision to record the incident. Revision protection helps prevent duplicate overwrites; it does not remove ambiguous acknowledgements.

**Change:** return a compact receipt with project, path, revision, saved/dirty/conflict state, and optionally content hash. Read text separately through paginated reads. The generic layer should distinguish execution failure from oversized response content; response size must never imply that an executed write should be repeated.

**Acceptance:** save an isolated 30k-character fixture through the actual model-facing loop. Receive a bounded success receipt, recover every page, and perform no duplicate write. Cover recovery-only edits and conflicts too. Increasing the cap merely moves this failure.

### 2. Complete the bounded-read contract for search and Git

**High priority; search reproduced live, other cases source-derived.**

`searchFiles` returns a plain array, scans up to 10,000 entries, and stops near 200 matches with snippets up to 300 characters. Count limits do not guarantee a serialized-size bound. The tool has no search cursor/result limit, and `path` is not passed into `searchFiles`.

**Change:** add a serialized budget, incomplete/truncated metadata, scan statistics, continuation, and directory/file scoping. Narrowing a query is not a substitute for retrieving all its matches. Use consistent completeness metadata for large directory listings too.

Git now supports bounded, path-scoped output, but one large file can still overflow its diff budget. `gitView` may also cut status/worktree text while its hint only says to scope the diff. Path validation resolves an existing filesystem path, so scoping a deleted tracked file needs its own regression case.

**Acceptance:** `const` returns useful results with honest coverage, and all matches remain retrievable. A large single-file diff can be exhausted in chunks. Deleted tracked paths work without weakening project-root or literal-pathspec safeguards. Truncated status is never treated as a complete change inventory.

### 3. Preserve failure causes and expose liveness separately from context usage

**Medium-high priority; diagnosis limitation is source-confirmed, UI changes proposed.**

The heartbeat is a meaningful transport fix. A context meter, however, answers “how full is this request?”, not “is the provider still responding?”

`sharedModel` parses error bodies but rewrites most failures outside its preserved 4xx set into the generic server-disconnected message. Provider 5xx, timeout, and broken connection should retain distinguishing evidence. [desktop/src/runtime.rs](../desktop/src/runtime.rs), line 166 in this baseline, still discards runtime stderr with `Stdio::null()`.

**Change:** preserve sanitized category/status and a correlation ID across desktop, relay, and provider. Show phase, elapsed wait, and last progress/heartbeat time. Keep bounded, rotating, access-controlled metadata diagnostics—not prompts, credentials, code excerpts, or response bodies. Keep proxy payload logging disabled.

**Acceptance:** injected provider error, stalled connection, cancellation, and desktop disconnect leave distinguishable persistent records; slots/timers are released; uncertain requests are not automatically replayed. A healthy long wait remains visibly different from completed or stalled work.

### 4. Make permission and data-location descriptions agree with behavior

**Medium priority; a contract improvement, not a request for more authority.**

`confirmList` correctly says this ward has confirmations off, while some static tool descriptions still promise a Confirm button. Effective policy should not compete with unconditional boilerplate.

Likewise, `desktop_projects` says files and tool results stay in the local conversation, while `sharedModel` transmits instructions/items/tools for inference and documented Rime sync includes agent files and transcripts. Local project ownership is not equivalent to “selected code excerpts never leave this computer.”

**Change:** expose a compact effective summary: execution location, model route, synchronization scope, approval policy, and terminal input mode. Generate permission descriptions from the execution policy. Separate filesystem ownership from inference/transcript data flow. State whether `/work` scratch files synchronize; consider an explicitly ephemeral, non-synced scratch area.

**Acceptance:** instructions and documentation agree across approval modes and online/offline desktop states. Code review does not inherit an unexplained local-only output claim. Human-mode terminal enforcement remains intact.

### 5. Bind completion claims to durable evidence

**Medium priority; builds on the original task-evidence suggestion.**

A prose review is useful, but a task's “done” state should point to what was actually checked. A quiet terminal or final CLI prompt is not proof, especially in a shared tree.

**Change:** attach observed file revisions/hashes, relevant diff identity, validation commands and exit status, output sequence, and reviewer identity to the task receipt. Keep the explanation. Mark evidence stale when relevant files change; never imply an assignment isolates arbitrary external writes.

**Acceptance:** after reload, another reviewer can see which files/checks support completion and whether they still match. Tests not run remain distinct from tests passed.

## Keep these strengths

- The outer cap and valid-JSON guarantee; improve result contracts instead of flooding context.
- Revision checks, explicit saves, conflict inspection, project-root validation, and human ownership.
- Human-by-default terminals and no blind replay of uncertain input.
- Parallel independent tools, visible reasons, and between-round persistence.
- Catalog-derived limits, labelled approximations, and history retention when compaction fails.
- Separation of desktop execution, model inference, and native process ownership.

## Next validation pass and scope

Prioritize isolated regressions: large-write receipts; exhaustive search/diff reads; revision changes between file pages; completed-tool survival across provider failure, reload, and mid-turn compaction; and heartbeat/error behavior through the actual deployed proxy chain.

I inspected targeted source, `tests/development.test.ts`, and `tests/agent-context.test.ts`. **I did not run the test suite, build, native UI checks, or production relay soak tests in this follow-up.** The live checks were reads, search, documentation creation, and saved-file verification. No application code changes are part of this review.

## Implementation follow-up — September 6, 2026

The subsequent terminal release review fixes the large-write acknowledgement: `project_edit` returns a compact revision/saved receipt, and the shared output cap reports an omitted result without implying execution failure or instructing a repeated mutation. A regression saves a file larger than the result cap and verifies both its receipt and disk contents. The `desktop_projects` description now distinguishes local project ownership from model requests and shared transcript excerpts.

A subsequent implementation adds scoped search and directory pagination, exhaustive Git pagination with snapshot identity (including deleted paths), an effective execution/inference/sync/permission summary, task receipts with file hashes and reviewer-reported checks, categorized relay diagnostics, runtime metadata logs, and elapsed-wait/relay-progress labels. The observations and validation scope above describe the original review, before these implementation changes.

Terminal sessions now use a fixed-height, horizontally scrolling tab strip. The terminal surface uses size containment so loading another PTY screen cannot resize or move its ward. Keyboard tab navigation and a ward-bounds regression cover session switching.

Validation added: exhaustive 600-match model-facing search; reconstruction of a large Git diff without gaps; deleted-file scopes; persistent task receipts and stale-file detection; bounded diagnostic retention without payloads; categorized provider failures and stream cancellation. Search continuation assumes an unchanged tree; no project snapshot or index is created. Task checks remain explicitly reviewer-reported, and only listed files receive stale checks. Production relay soak testing and signed desktop release validation are separate from these local checks.

Local verification: the 452-test suite passed, followed by the expanded development regressions; TypeScript and desktop lint passed. The clean-checkout production build and real-PTY terminal UI smoke test passed, including a 400×150 saved screen switching without ward movement. Rust compilation passed; the native diagnostic rotation/permissions test also passed in an isolated crate using the same function and test. Full in-place native test linking stalled, so this is not a full desktop release validation.

Release review also preserves provider HTTP/timeout metadata, disables uncertain relay
retries, keeps provider error bodies out of relay status logs, and excludes full task
receipts from routine terminal reads. Reviews work for non-Git projects; unavailable
file evidence becomes stale. Editor search follows continuation pages before applying its
existing 200-result display cap. Git output errors no longer silently fall back to staged
changes. Rapid terminal tab switches are serialized. The existing bulk-output regression
now polls incrementally, avoiding repeated full-scrollback serialization on Intel CI.

The release checkout passed all 452 existing JavaScript tests, TypeScript, desktop lint,
four native Rust tests, Clippy, the packaged-runtime check, and the full PC → phone → PC
smoke flow. All twelve documentation goldens were regenerated and inspected. Windows CI
identified a cleanup race in the new receipt fixture: it now removes its temporary folder
asynchronously with bounded retries while the terminated shell releases its directory.
