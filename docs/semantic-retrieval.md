# Retrieval and background monitors

Rime keeps seven bootstrap tools: `search_tools`, `search_knowledge`,
`read_knowledge`, `ask_user_question`, `task_list`, `task_output`, and
`task_cancel`. Before responding to each new user message, it preloads up to
five additional tools from the raw message (up to 2,000 characters). User input
arriving mid-turn is processed before the next model request. Monitor wakes and
agent notifications reuse the retained set without automatic selection.

Preloading shares a two-second deadline across concurrent MCP catalog connections
and hybrid retrieval. Timeout or retrieval failure falls back to keyword matches
against available definitions. Stop cancels preparation; late results cannot
change a request already in flight. A preparation status appears as
“Loading relevant tools…”; no tool is executed by preloading.

Automatic matches and explicit `search_tools` results are retained as names in
`agent_conversation_tools`, independently of compactable replay. New messages do
not unload tools, and restart/compaction preserve the set. Every request resolves
current schemas and permissions; unavailable tools are omitted without forgetting
their names. A new or imported conversation starts fresh. Forks copying history
also copy the retained names; independently spawned children start fresh. There
is no total tool-count limit or silent eviction: schemas count toward the normal
context budget. Reasons, approvals, routing, sandbox restrictions and MCP
revision checks still apply. Explicit search loads at most ten schemas per call.

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

Account → Agent → Semantic retrieval selects either the self-hosted
Qwen3-Embedding-8B model or a cloud provider (OpenAI API, OpenRouter). The
self-hosted choice carries a priority list of runtimes — this computer, the
paired server (from a desktop), and paired desktops that share their model —
and each query uses the first one that answers, so a laptop going offline hands
over to the next computer without any change of settings. Every runtime in the
list serves the same model variant; a runtime that fails is skipped for thirty
seconds, an offline desktop costs nothing. The selection is stored per runtime:
a server has its own list, and a server can host the model itself (Account →
Semantic retrieval installs the pinned llama.cpp build into its data directory
and downloads the weights). Cloud providers are never switched to automatically;
they are a different vector profile. Cloud providers use the existing sealed
API-key account store; desktop cloud calls can use the paired server's
credentials. Codex sign-in embeddings are unverified and are not used. Keyword
retrieval remains available with explicit status when no runtime is available or
indexing is incomplete.

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
Delivery is rate limited per monitor by `minIntervalSeconds` (1–3600, default 5,
stored with the monitor and shown in Tasks): the first eligible alert goes at
once, later ones no sooner than the interval apart, pending matches coalesce into
one notice, and a trailing notice follows once the source goes quiet. This is
separate from `source.intervalSeconds`, which paces polling.

Terminal sources observe rendered screen rows, never raw bytes: after each output
flush the headless terminal's viewport, plus exactly the rows that flush scrolled
above it, is read back, and only rows not in the previous frame or on screen in the
last 5 s are emitted. Rows compare by exact text; only Claude Code / Codex status
chrome (a spinner-led row, or one carrying "esc to interrupt") has its frame glyph
and counters normalized, so spinner ticks, timers and status-bar repaints drop while
new progress, questions, results, failures and exit state pass. Long bursts arrive
as several 16 kB pages; rows that scrolled out of an unretained buffer before they
were read add an explicit "rows scrolled out of view" line. `terminal_read` and
`terminal_wait` return the rendered screen by default (an exited session's retained
snapshot, rendered readable); `raw: true` adds the ordered raw bytes.
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
retrieved passages or explicitly named skills. This historical comparison predates
automatic preloading and conversation retention; current requests also include
retained and newly selected tool schemas. These are estimates, not provider
billing/tokenizer measurements.
