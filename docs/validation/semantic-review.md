# Semantic retrieval and monitor review

Implementation: `aea6724`, with the account navigation follow-up recorded in
history. Three parallel reviewers covered retrieval/inference, tool discovery
and execution, and monitor sources/delivery/lifecycle. Their concrete findings
were fixed and checked before handoff.

The fixes include authoritative note text and source locators, ownership and
revision rechecks, cancelled inference and queued profile changes, MCP schema
and permission races, read-only monitor wakes, bounded durable event receipts,
reconnection cleanup, and shared conversation retirement. The final UI check
also caught asynchronous retrieval settings being mistaken for unsaved account
edits; the form now checkpoints its own hydrated and saved state.

Validation used existing suites and temporary acceptance scripts, without adding
a permanent test suite. The reviewed implementation passed all 501 existing
Node tests, TypeScript checking, desktop lint, a production build, and regenerated
goldens with inspection. Temporary checks covered scoped current-source reads,
deletion/rebuild/profile isolation, named skills without inference, discovery
and approval races, monitor baselines/filtering/coalescing/restart/cancellation,
browser DOM observation, and HTTP status/header/JSON fields.

The packaged worker passed using bundled Node 22.22.0 and production native
dependencies: FTS5, sqlite-vec queries, owner isolation and authoritative edits.
The extracted llama.cpp b10909 runtime passed its launch check with relative
library links intact. Local Q4 and Q8 inference, query latency and retrieval
measurements are recorded in [embedding-benchmark.json](embedding-benchmark.json).
The identical-input prompt/tool estimate is in
[tool-token-comparison.json](tool-token-comparison.json).

The browser and terminal work was separately verified by its owning session,
including terminal commit `48a77bb`; it was accepted as verified for this handoff.
The final Rust formatting pass changes no behavior.

Only macOS arm64 inference and native packaging were exercised locally. Windows
and Linux installer validation, distributed signing/notarization, deployment,
and installed-app verification belong to the release procedure. No cloud
embedding credentials were created and no live cloud embedding call was made.
Apple Neural Engine execution is not implemented; local inference uses Metal.
