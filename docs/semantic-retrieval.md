# Retrieval and background monitors

Rime starts each turn with seven tools: `search_tools`, `search_knowledge`,
`read_knowledge`, `ask_user_question`, `task_list`, `task_output`, and
`task_cancel`. Tool search loads at most ten callable schemas for later rounds
of that turn. Existing names, reasons, approvals, routing and sandbox read
restrictions still apply. MCP definitions and trust are rechecked before calls.
Search for `agent_help`, then select a topic: `general` (default), `computer`,
`browser`, `sandbox`, `wards`, `leylines`, `memory`, or `delegation`. Use `all`
for the full reference; pagination offsets belong to the selected topic. Child
runs receive their own delegation and approval guidance. Every tool call still
requires a reason, whose tone should fit the situation. `current_time` supplies
a fresh UTC clock reading and runtime timezone, not an inferred user timezone.

The authoritative files and records remain where they were. `knowledge.db` is
a disposable derived index using FTS5 and pinned `sqlite-vec` 0.1.9. A packaged
worker handles indexing and vector queries. Memory/skill files, standing notes,
notepads, notebook text, transcripts, extracted attachment text and tool metadata
are indexed per owner. Project files, raw images and untranscribed ink are not.
Search reconciles changes and rechecks source revisions before returning
excerpts. Rebuilding deletes derived data only. Standing notes remain in every
prompt, with up to five memory/skill excerpts within an estimated 2,000 tokens;
named skills are looked up independently of embeddings.

Account → Agent → Semantic retrieval selects this desktop, an explicit paired
desktop, OpenAI API, or OpenRouter. No provider switches automatically. Cloud
providers use the existing sealed API-key account store; desktop cloud calls
can use the paired server's credentials. Codex sign-in embeddings are unverified
and are not used. Keyword retrieval remains available with explicit status when
inference is unavailable or indexing is incomplete.

Settings separate provider selection from the current search status. Save and
discard appear only for unsaved changes; downloads, cancellation and unloading
appear only when applicable. Active downloads show their own progress, including
when selecting another provider. Index rebuilding is under **Index maintenance**.
The status identifies setup, download, indexing, ready, unloaded and offline
states. Model files live in application data and survive application updates.

Local setup downloads Qwen3-Embedding-8B Q4_K_M (4.68 GB) or Q8_0 (8.05 GB),
verifies its pinned SHA-256 and revision, and runs a bundled llama.cpp process.
Queries use Qwen's instruction format; pooling is last-token, normalization is
L2, and vectors have 4096 dimensions. OpenAI supports text-embedding-3-small
(1536 dimensions) and text-embedding-3-large (3072); OpenRouter uses
qwen/qwen3-embedding-8b. Model, revision, quantization, dimensions and encoding
identify incompatible vector profiles. Explicit sharing exposes bounded
inference, never the index or project roots. macOS headroom uses the OS memory
pressure estimate, not the count of entirely unused pages.

`monitor` creates, updates, pauses, resumes and deletes durable observations in
the current conversation. Tasks shows status, filters, errors and recent matches.
Watching consumes no ordinary task slot. Sources are local terminal sessions,
scoped project paths, live browser sessions, agent/inbox events, notes/notebooks,
read-only HTTP, communication ingestion, and existing Leyline events/probes.
HTTP defaults to 30 seconds; connector probe minimums remain in effect. A browser
monitor reconnects when its runtime session is available. File watchers are
backed by reconciliation, including when OS watcher capacity is exhausted.

Exact filters accept `all`, `any`, `not`, and `{field, op, value}` leaves. Operators
are `eq`, `contains`, bounded `glob` (`*`, `?`), `gt`, `gte`, `lt`, `lte`, and
`changed`. Optional `{field, query, threshold}` semantic gating runs only after
the exact filter passes. Unavailable inference blocks that gate visibly.
Initial/reconnected observations establish a baseline without a historical
flood. Matches have durable deduplication and delivery receipts; active turns
drain them between rounds, while idle conversations wake within existing limits.
Clearing, archiving, provider changes and child completion delete subscriptions
and pending delivery, retaining a stopped-monitor notice in the transcript.
Monitoring authorizes observation only, never a reply or external action.

For repeatable Q4/Q8 measurement, run `node ops/embedding-benchmark.mjs corpus.json
report.json` in an isolated desktop runtime with both verified downloads. Corpus
format: `{"documents":[{"id":"a","text":"..."}],"queries":[{"text":"...",
"relevant":["a"]}]}`. The report pins the input hash and profiles and records
rankings, recall@5, reciprocal rank, latency, throughput and sampled peak process
memory. One quantization is loaded at a time; unavailable prerequisites are
reported as unmeasured, never successful results. OS process memory is sampled
once per second and can miss shorter peaks.

Sources: [sqlite-vec JavaScript integration](https://alexgarcia.xyz/sqlite-vec/js.html),
[llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md),
[Qwen files](https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF/tree/69d0e58a13e463cd99a9b83e3f5fee7c10265fab),
[Qwen encoding](https://huggingface.co/Qwen/Qwen3-Embedding-8B),
[OpenAI embeddings](https://developers.openai.com/api/docs/guides/embeddings),
[OpenRouter Qwen](https://openrouter.ai/qwen/qwen3-embedding-8b).

## Validation artifacts

The [recorded comparison](validation/embedding-benchmark.json) uses this exact
[32-passage, 16-query synthetic corpus](validation/embedding-corpus.json) on the
same Apple Silicon Mac, one model at a time. Both profiles retrieved every
labelled answer within their first five results; mean reciprocal rank was
0.9375. Median query latency was 118 ms for Q4 and 115 ms for Q8. This small
acceptance corpus does not establish general retrieval quality. Model caches
were not flushed. Sampled process RSS is recorded, but is not total unified GPU
memory and must not be used to claim Q8 has a smaller total footprint.

The [prompt/tool comparison](validation/tool-token-comparison.json) uses the same
empty account fixture against commit `96fd0dc`: 122 tool schemas and about 33,077
estimated tokens become seven schemas and 2,429 tokens (92.7% less), before any
retrieved passages or explicitly named skills. These are estimates, not provider
billing/tokenizer measurements.
