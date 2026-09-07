# Rime harness follow-up: after the first fixes

**Reviewed:** 2026-09-06, after the user's 19:37 UTC request.
**Baseline:** `c670ec9d90d200ade6de3f802835f4da3bcfb3f2`, `main`, initially clean.
**Perspective:** Rime using the desktop harness; not a release or security certification.

This supplements [the reconstructed original review](rime-agent-harness-review.md), without replacing its incident record. The repository changed substantially while the original turn was interrupted; repeating the old recommendations as current defects would be misleading.

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

## Independent re-review — baseline bf24153d, September 6, 2026

Requested at 23:11 UTC. Baseline: `bf24153d7db486c4e5bf4bdf1c5601e7ca102838`, `main`, clean before this documentation update. The prior findings above remain a historical record, not the current defect list.

### Assessment of the fixes

The main recommendations have been implemented. This is now a more usable harness, not merely better documentation of the same limitations.

- **Large writes:** `project_edit` returns only a small revision/saved/dirty/conflict receipt. The inspected regression saves a document larger than the result cap and checks recovery-only edits and conflicts. Updating this already-over-12k document exercises the live model-facing save path without adding a fixture or changing application code.
- **Scoped search:** independently validated against `src/lib/agent/core.ts`. Three search pages returned 82, 77, and 36 matches: **195 total**, exactly equal, in line order, to an independent ten-page file read at revision 3. Serialized results were 9,193, 9,237, and 4,428 characters. Every cursor advanced and the final page reported complete. The old search-overflow finding is closed for this checked path.
- **Git and directories:** source now exposes complete/next/snapshot metadata. Git handles deleted paths, preserves every output character across pages, and no longer hides output failures by falling back to staged changes. Source and existing regression inspected; no new large-diff fixture run here.
- **Relay failures:** `sharedModel` calls `modelFailure`, retains categories/status/reference IDs, and disconnects selectively. Diagnostics retain at most 100 metadata records per account, not raw provider error bodies. Stream reads now report progress. Production soak and UI liveness behavior were not re-tested here.
- **Data flow and input authority:** generated instructions now distinguish desktop execution, remote inference, shared transcripts, and `/work` synchronization. Rime input is an explicit session capability, separate from the CLI launch policy; agent input cannot seize a human-owned terminal.
- **Task evidence:** receipts capture file hashes, Git identity, reviewer, sequence, and reviewer-reported checks. Detailed review reads recompute staleness for listed files, and routine terminal reads omit the large receipt. This is materially stronger than a free-text “done” claim. Unlisted files and unrelated changes remain outside that stale check, as the implementation notes disclose.

### Historical findings — resolved in desktop 0.4.7

These findings describe the `bf24153d` / `4bb5bd9` review baseline. Commit `e2a5b81` fixes all three; see the release verification below. They are retained here as the original evidence, not as open defects.

#### R1 — Root search mixes generated files and other checkouts (medium priority; live)

The first unscoped `const` page returned `.astro/fonts/.../meta.json` and many `.claude/worktrees/dashboard-integrated-agent-84eb7a/...` matches before reaching current source. The nested worktree is at a different Git revision. For example, it surfaced an older provider timeout and old widget-era components. The paths are visible, so this is not hidden substitution, but it makes wrong-version conclusions unnecessarily easy and consumes context with generated content.

`searchPage` excludes only four named directory types (`node_modules`, `dist`, `target`, `.git`); it does not honor Git ignore rules or identify nested worktrees. Its “dependency/build directories are excluded” hint is broader than those actual exclusions.

**Recommendation:** default source search to the current checkout, honor appropriate ignore rules, and exclude nested worktrees/generated caches unless explicitly requested. Keep a deliberate include-ignored/include-other-worktrees option and label scope provenance. Until then, use explicit `path: "src"`, `path: "tests"`, or a file path rather than assuming root results describe HEAD.

**Acceptance:** root source search does not silently mix a second checkout into current-code results; explicitly searching that checkout remains possible. Say what was excluded rather than implying exhaustive repository coverage.

#### R2 — Omitted errors lose their execution outcome (medium priority; source-derived)

The revised `pushOutput` is safer for successful oversized results: it says not to repeat a change. However, `runLoop` also catches thrown tool errors as `{ error: message }`, then passes them through the same function. If that error exceeds the cap, it becomes an omission receipt saying “This is not an execution failure,” with no retained failure flag or bounded error summary. This edge case was not deliberately triggered in the live workspace.

**Recommendation:** preserve a small outcome field and bounded error summary independently of response truncation. Distinguish success, failure, not-run, and unknown result content; keep the no-blind-replay warning. Avoid inferring success solely because serialization—not execution—caused the omission.

**Acceptance:** an oversized successful result and an oversized thrown error produce different, bounded, truthful receipts while neither encourages repeating an uncertain mutation.

#### R3 — Peer memory wording still contradicts shared storage (low priority; source-confirmed)

`peersBlock` says each peer has “its own thread, memory and tools.” But `workDir(userId)` and the memory/skill stores in `history.ts` and `store.ts` are per-user, not per-ward. The notes block's persistence correction is good; this remaining sentence can still suggest isolation that is not present.

**Recommendation:** explicitly distinguish separate conversations/tool configurations from shared user memory, skills, and standing notes. A shared-memory write should not be described as private to one agent. No overwrite or data loss was observed in this pass.

### Scope and next step

This pass ran live read-only tool checks and the exact scoped-search comparison, inspected source and existing development regressions, and updated only this document. It did not run or add native/JavaScript test code, rerun the suite/build, change terminal permissions, deploy, or validate signed installers. The 452-test and release results in the preceding section are the existing implementation report, not newly observed executions by this reviewer.

Prioritize R1 for everyday code-review accuracy, then R2 for truthful failure handling. R3 is a small wording correction. Do not reopen the resolved write-receipt and basic search-pagination defects based on the historical sections above.


## Release review follow-up — desktop 0.4.7

R1–R3 above are addressed: source search uses Git’s tracked/non-ignored working-tree listing without walking nested checkouts, with explicit `includeIgnored` access and scope metadata; oversized results preserve a bounded failure summary and an outcome instead of denying execution failure; peer instructions now describe shared per-user memory, skills, notes, and scratch files.

The background-task review also added the exact native command and project folder to approvals, kept Tasks available without a configured provider, and coalesced live-output database writes. Existing tests are retained; no new test cases were added.

Release validation passed all 452 existing tests, TypeScript, desktop lint, the production build, and the editor/terminal/chat smoke checks; documentation goldens were regenerated. The remote-workspace smoke flow passed PC → phone → PC continuation and offline recovery with fixture model responses. Isolated manual checks verified ignored/nested-checkout search scope, explicit excluded-file access, sandbox/native task cancellation, native nonzero exit reporting, cross-ward task access denial, and one-time completion notices. No external model calls were made.

Final verification against `e2a5b81` exercised the actual search and tool-loop paths in an isolated runtime. Three root-search pages contained 229 matches and no `.astro/` or `.claude/worktrees/` paths. Scoped search returned all 204 current `core.ts` matches, exactly matching an independent file read. Oversized successful, thrown-error, declined, and unknown results retained distinct outcomes in valid JSON below the 12k cap; the thrown error retained a 500-character summary. Both generated peer instructions and the `ask_agent` description identify shared per-user memory. No production code or new test cases were needed in this final pass.

The same revision passed Linux and Windows main CI, four native Rust tests, Clippy, and the packaged standalone check. Desktop 0.4.7 was signed, installed, and started on the Mac; its four pages, 28 wards, shared theme, online synchronization without conflicts, and authenticated production relay were verified. Frostdev serves `v0.22.5 e2a5b81`. Installer publication is tracked separately in the `desktop-v0.4.7` Actions run.
