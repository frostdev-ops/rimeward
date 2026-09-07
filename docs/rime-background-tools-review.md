# Rime background tools: live verification

**Request:** 2026-09-07 00:30 UTC (September 6 in America/New_York).

**Baseline:** `1f98402002ab981d5203a92f1b510b3435124989`, `main`; package reports `0.22.5`, desktop release `0.4.7`.

**Environment:** macOS desktop, Node `v26.8.1`; this ward's approval policy was off.

This is an independent live pass following [the previous review](rime-agent-harness-follow-up.md). It distinguishes checks run in this turn from earlier release reports. The pre-existing untracked `docs/goldens/leylines 2.png` was left untouched.

## Verdict

**Status:** the termination-metadata finding below describes desktop 0.4.7 and is resolved by the 0.4.8 implementation reviewed at the end of this document.

The three previously reported findings are addressed, and the exercised background paths work. I could start work, continue independent inspection, discover jobs, read progress and paginated results, observe success/failure, cancel native and sandbox work, and receive a peer's reply without blocking this conversation.

No blocking failure was found in the exercised paths. One low-priority result-fidelity issue remains: the cancelled native probe correctly has task state `cancelled`, but its command result reports `exit_code: 0` without a termination signal. Consumers must not interpret that exit code alone as successful completion.

## Previous findings

- **R1, mixed root search:** addressed. The live root `const` search now reported `scope.source: git-working-tree`, with tracked/non-ignored files and nested-checkout exclusions. Its first page no longer began with `.astro` cache files or the old `.claude/worktrees` checkout. An explicitly selected file inside that checkout remained readable by search, as documented; both an explicit file path and `includeIgnored: true` provide deliberate access. This pass sampled root results and inspected the contract; it did not exhaust every root-search page.
- **R2, omitted errors losing outcome:** addressed in source. `pushOutput` retains `outcome` and a bounded error summary, distinguishing failed/not-run/succeeded/unknown and no longer denying execution failure. The existing omission regression passed. The full success/error/declined/unknown manual matrix described in the earlier release report was not independently rerun here.
- **R3, peer memory wording:** addressed. `peersBlock` now says conversations/tool configurations are separate while memory, skills, standing notes, and `/work` files are shared per user.

## Background test matrix

| Check | Observed result |
| --- | --- |
| Native success | A 25-second command emitted start, progress ticks, and `BG_SUCCESS_DONE`; final state `completed`, exit 0. Other inspection calls ran while it continued. |
| Native failure | A deliberately failing command emitted `BG_EXPECTED_EXIT_7`; final state `failed`, exit 7, with `Command exited with status 7`. This failure was expected. |
| Native cancellation | Observed live ticks, requested cancellation, saw `stopping` then `cancelled`. An independent `ps` check confirmed probe PID 97736 was absent. The natural-finish marker never appeared. Exit-code caveat below. |
| Sandbox background success | Start and end markers survived; final state `completed`, exit 0. |
| Sandbox cancellation | Cancelled a 25-second delayed write to a test-only `/work` path. Receipt: `cancelled`, exit 124, `bash: execution aborted`. A later check after the original deadline confirmed the file did not exist. |
| Background delegation | `ask_agent(background: true)` returned immediately with a task ID. Peer `wx97dq2` returned exactly `BACKGROUND_PEER_OK_1F98402`; both task result and message receipt 1 reported completion. The peer was asked to use no tools or perform other work. |
| Background terminal wait | `terminal_wait(background: true)` on the already-exited success session returned the matching session, exit 0, and completion marker. This checks dispatch/result retrieval, not a long in-flight terminal wait. |
| Task discovery and notices | Jobs appeared in `task_list`; completion/failure/cancellation notices arrived in this conversation. I inspected results rather than treating notices as proof of success. |
| Large output | Generated 600 numbered lines and a final marker. The retained live log was exactly 64,000 characters across eight pages; the first page explicitly reported truncation and absolute cursors advanced. Retained numbered lines 76–599 had no gaps, and `BG_PAGES_END` remained available. |
| Result pagination | The large-output probe and full-suite final JSON each required two result pages. Reassembled JSON preserved the actual exit code and `truncated` flag. |
| Cleanup | All native command sessions created by this pass were observed exited. Existing terminal modes/ownership were not changed. The sandbox delayed-write sentinel was absent, so no test file needed removal. |

Important reading rule: `task_output.complete` means the currently available result/log page range is exhausted, not necessarily that the job has ended. I observed `complete: true` alongside a running native job. Always inspect `task.state`; inspect `exit_code` and output as well for command jobs.

Final command results are intentionally bounded. For long jobs, the final `stdout` can omit the ending summary even though the live log retains it. Use `task_output(output: true)` and follow its cursors to inspect the retained tail. A truthful truncation flag is not a complete transcript guarantee.

## Actual validation commands

All ran through `terminal_exec(background: true)` in this project. No dependencies were installed and no repository test files were added or edited.

```sh
node --test tests/agent-core.test.ts tests/agent-context.test.ts tests/agent-diagnostics.test.ts tests/agent-guards.test.ts tests/agent-sync.test.ts tests/development.test.ts
npm run typecheck
npm test
```

- Focused regressions: **58 passed, 0 failed**, exit 0.
- TypeScript: **passed**, exit 0.
- Full existing JavaScript suite: **452 passed, 0 failed**, exit 0; its retained output included the final test counts.
- `tests/_setup.ts` was inspected: test files use per-process temporary data directories rather than the live application database.

## Small follow-up: preserve native termination metadata

**Priority: low; reproduced, cleanup succeeded.**

The native cancellation task ended as `cancelled`, but its JSON contained `exit_code: 0`. The terminal row likewise reported an exited session with code 0. The source handler in `src/lib/dev/terminals.ts` destructures only `exitCode` from `pty.onExit`; a separate termination signal is not retained. `terminal_exec` forwards the stored code.

This did not prevent cancellation: the operating-system process check succeeded. However, a script or later reviewer reading only the command result could mistake a terminated job for a normal successful exit.

**Recommendation:** retain and expose the termination signal and cancellation/termination reason alongside exit code, using null where an ordinary exit status is not meaningful. Preserve the task's separate `cancelled` state. Keep task-output and Terminal views consistent, without weakening the existing ownership checks.

**Acceptance:** cancelling a long native command stops its process, leaves no natural-completion marker, and returns a result that cannot be mistaken for an ordinary successful exit when viewed independently of the task wrapper.

## Evidence receipts

Task IDs are runtime-local review references, not permanent public links.

- Native success: `b576b004-a486-4599-8b45-7f2468e8eda0`.
- Expected exit 7: `5582d534-0a53-41e3-bed5-62d8bf9c48a1`.
- Native cancellation: `306e078e-b453-4626-8ca6-d105c71a071d`; independent cleanup: `c9762b4d-edfb-4b1c-b0ad-1f9ff4ae2602`.
- Sandbox success: `eb71d8d3-8b7e-4182-8bed-b5ff8267472a`.
- Sandbox cancellation: `5791eb2e-cb45-4186-9c57-97aba8a76cb5`; delayed absence check: `78266302-de58-4f1a-8728-7aabedc7757b`.
- Peer echo: `7c08d14e-9d20-4eb9-99f1-c99653e30cc8`; message receipt 1.
- Background terminal wait: `cbd26fd6-8f2d-4a5a-b73b-9b9f1d463d56`.
- Output pagination: `f23c4a62-dd34-424f-af0f-6b5136e6bb9d`.
- Focused tests: `0cd85719-7032-432a-bab3-7898e9a0da07`.
- Typecheck: `7d035c62-b090-4863-9223-71ca010864c9`.
- Full suite: `787f7109-6541-4305-97a3-fe7495357b55`; native session `adbf1b9c-e39c-4717-b947-3fe6d76079e2`.

## Limits of this pass

I did not restart the running app to test recovery, exercise Ctrl+B or confirmation dialogs through the UI, rerun native/Rust or browser smoke tests, soak the production relay, change terminal permissions, install, commit, or deploy. Restart/no-replay and permission-boundary claims therefore remain source/release evidence rather than fresh end-to-end checks here. The only repository change made by this pass is this report.

## Desktop 0.4.8 release review

Native terminal sessions now retain signals and termination reasons. `terminal_exec` returns null for non-normal exit codes, and task classification and Terminal labels use the same evidence. Review also fixed a cancellation arriving while xterm drains final output, so finalization cannot overwrite its cancellation metadata with exit zero.

The release includes the desktop `apply_patch` tool documented in [its format and safety contract](apply-patch.md). Review added the complete patch to pending confirmations, with a native **Review patch** disclosure in both chat surfaces and restored pending state.

Isolated manual checks passed for whole-batch preflight rejection, add/update/move/delete, original-byte recovery, UTF-16 BOM/CRLF/missing-final-newline and mode preservation, cross-account buffer ownership, dirty/stale buffers, traversal/symlink/hard-link rejection, and an injected partial-move failure that retained its source and reported a copy. Native checks covered exit zero, exit seven, signal 15, cancellation, and cancellation during final output draining. No external model calls or new test cases were used.

Release validation: all **452 existing tests**, TypeScript, desktop lint, and the production web build passed. All 12 goldens were regenerated and inspected; the existing editor, terminal, conversation, and remote-workspace smoke checks passed. A disposable built-app check verified full patch review in the ward and expanded chat on desktop and phone, including literal HTML display, accessible confirmation controls, and no mutation from opening the review. Remote smoke coverage used model fixtures and retained its PC → phone → PC, offline-server continuity, sync/conflict recovery, and project-content privacy checks.
