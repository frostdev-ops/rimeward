**Section 1 · Desktop only** · [Wiki home](https://github.com/frostdev-ops/rimeward/wiki/Home) · Previous: [Workspace](https://github.com/frostdev-ops/rimeward/wiki/Desktop-Workspace) · Next: [Data and troubleshooting](https://github.com/frostdev-ops/rimeward/wiki/Desktop-Care)

Rime is the agent in your workspace. The model provides reasoning; Rimeward supplies the conversation, tools, project context, memory, and permission checks that let it act.

## Choose a provider

Open **Account → Agent** and configure the provider you want. Then choose the provider/model in the agent ward's configuration or inherit the Rime default.

On a desktop connected to a server, open **Provider connections** (`/desktop/providers`) instead. That page always belongs to this desktop, online or not, and shows one card per installation: this desktop, and the connected server. Each card's Connect, Reconnect and Disconnect act only on its own connection — Disconnect never unpairs the desktop, ends your Rimeward session, revokes a coding CLI's login, or touches the other installation. A card that was rendered against a connection you have since replaced or unpaired refuses its own writes rather than applying them to whatever is current now.

| Provider | What you supply |
| --- | --- |
| ChatGPT backend (Codex) | The account connection offered by Rimeward. Availability depends on that account and service. |
| OpenRouter | Your OpenRouter connection and access to the selected model. |
| OpenAI API | Your API key and API billing/access. |
| OpenAI-compatible endpoint | The endpoint URL, credentials if required, and a model that supports the tools you need. |

Model lists expose provider-reported capabilities where available. Not every model supports tools or images, and a local server exposing a chat API does not guarantee reliable agent behavior. Prices, model access, and quotas belong to the provider. Rimeward does not include model credits.

A conversation stays with the provider it began on. To change provider, start a new conversation or explicitly delegate work to a child using that provider. Rime can choose another available model within its provider at a round boundary. An unavailable model is reported rather than silently substituted.

## Choose which connection serves the model

Three separate things are true at once, and the composer says two of them: **Runs on …** is the runtime coordinating the conversation, its tools and its workspace; **Model access via …** is the installation whose credential serves and bills the request. Opening a desktop-owned conversation in a browser does not move either — "this runtime" always means the conversation's owner, never the computer you are looking at.

**Model access** on the Provider connections page picks between:

- **Automatic — connected server preferred.** The connected server when it is reachable and offers this provider; otherwise this runtime's own credential for the same provider. This is what Rimeward has always done, and it remains the default.
- **This runtime only.** Only this installation's connection. The server's provider defaults, its endpoint names and its model catalog are not used at all, so a ward cannot inherit a model it has no credential for.
- **Connected server only.** Only the designated server. If it is unavailable the turn fails and says so; a local credential is never used instead.

The choice is stored on the runtime that owns the run and is never synchronized — "this runtime" would name a different machine elsewhere. It changes where inference goes; it never moves where a conversation runs, and never widens tool permissions.

A route is resolved once, when a turn is admitted, and held for that whole turn: every tool round, the compaction that turn triggers, and any child it starts use it. A request that fails after it was sent is reported — it is not re-sent to another account, and no tool action is repeated. If the connected server, its account, or the credential on this runtime changes mid-turn, the next request stops with a message instead of continuing somewhere else.

The preference decides where a **new** conversation goes. A conversation that has already run is pinned to the backend that admitted it, and the pin wins: one admitted on this runtime is never relayed, one admitted on a server is never served here, and a disagreement between the two is a refusal rather than a redirect. The composer says which is which — **Model access via …** while a turn is running is the source actually serving it; **Next turn via …** while idle is what the next one would use.

A conversation that never recorded which backend served it (one last used before that was recorded) is refused on a runtime that has ever been connected to a server: unknown history is not evidence that it ran here. Start a new chat on the endpoint as it stands, or continue it where it ran. A runtime that has never connected to a server keeps serving such conversations, because there was nowhere else they could have run.

Dashboard synchronization and model access are reported separately. A note, conversation or workspace format your server cannot carry yet pauses that sync and says so; it does not move model calls to a different account.

An OpenAI-compatible endpoint NAME means different things on different machines, so a conversation the server serves is pinned to that server's **account** as well as the backend it attests, and is never handed to a local endpoint of the same name — including while the server is unreachable. Two servers can both call an endpoint `http://localhost:11434/v1`; they are not the same backend, and the recorded account is what tells them apart. A server too old to attest a backend leaves the conversation marked as its own, without an address: such a conversation still runs there, and **Continue here** declines it rather than crediting it with an identity nobody verified. Older conversations that never recorded a source are not backfilled from today's settings, and conversations carrying a server-side pin are held back from servers too old to read them (you are told, and nothing is dropped).

## Dictation and voice

A ChatGPT login dictates through the live voice route, which relays to the connected server when that is the route in use; a call keeps the installation it started on for its heartbeat and stop, even if the connection or preference changes underneath it.

Clip dictation (record, send, get text back) uploads from the machine you are on, so it needs an OpenAI key, an OpenRouter key, or an OpenAI-compatible endpoint **on that runtime**. A key that lives only on the connected server is reported as unavailable for dictation rather than offered and then found missing.

## Use a local model

1. Install and start the local model server of your choice separately, such as Ollama, LM Studio, or vLLM.
2. Download a model suitable for tool use; download a vision-capable model if you need images.
3. In **Account → Agent**, add an OpenAI-compatible endpoint using that server's documented API address and model ID.
4. Choose it for Rime and try a simple request, followed by a harmless tool read.

Rimeward does not install the model server or weights. Memory use, response speed, and tool reliability depend on the model and hardware. Use the address your server actually reports, rather than assuming a port or API path. Remote endpoints require HTTPS. Plain HTTP is allowed only for a loopback endpoint used from the desktop; credentials are not forwarded through redirects.

With the endpoint, model, and Rimeward on the same computer, AI can work without a Rimeward server or cloud model service. Tools that read online sites or integrations still need a network connection.

## Give Rime the right context

Connect a Workspace ward to Rime with a Workspace Leyline to supply its folders and explicitly selected instruction files. Without a link, a fresh session uses the default folder on the current machine (your server worker in a browser). Type **@** to select wards by name or page: an editor buffer, terminal output, a browser page, a note, or connected information. You can also attach files.

An existing conversation stays on its original runtime when you open it elsewhere; its owner label shows that location. **New chat** archives the old conversation and creates a new identity. An unlinked ward starts the new conversation on the machine you are using, with browser agents coordinated by the server. A linked ward keeps its coordinator. Cross-machine creation waits for the original runtime to confirm retirement, and refuses active work, unresolved approvals, or dirty workspace buffers. If the connection fails during this change, **Reconcile new conversation** checks the saved receipt without duplicating the conversation or replaying work.

Mentions capture context when you send. They do not authorize a command, send a message to another agent, or acquire Remote Desktop control. Check the captured source when multiple wards have similar names. Offline or unavailable sources are reported explicitly.

Use the activity view to inspect tool work. A new message can steer a running turn. **Chat history** keeps previous conversations; starting a new chat archives the current one after the operation succeeds.

Use `/compact` to summarize older context while keeping the full transcript on disk. It runs on the conversation's owning computer, including when you send it from another desktop. The connection stays open while the summary is prepared; wait for the result before requesting another compaction.

## Answer Rime's questions

Rime can ask inline with one choice, multiple selections, or a text field. By default it pauses the conversation until you choose **Answer & continue**; **Skip** tells it no answer was supplied. Your theme and icons apply to the form, and draft answers survive reloads. Rime can optionally ask without pausing while it does independent work.

**Browser developer tools.** A browser ward records what its pages log and fetch, across every tab,
the person's own browsing included — `browser_console` for console messages and uncaught page errors,
`browser_network` for requests with status, duration and size, `browser_asset` for the body of
something the page loaded. The last 400 of each are kept; asking never starts a ward that is not
already running, and a ward that is not running says so instead of launching. An asset comes out of
the browser's own copy when it still has it, which is the only way to read a response no second
request could reproduce, and otherwise is re-read through the ward's session, carrying its cookies
and usually its cache; the answer says which of the two it was. Nothing here evaluates script in the
page — these read what already happened.

**Dictation without a ChatGPT login.** The composer's microphone works on any connection that can
turn speech into text: with ChatGPT it opens the live voice route as before, and with an OpenAI key,
an OpenAI-compatible endpoint on the ward, or OpenRouter it records a clip and sends it to be
transcribed, appending the text to the draft you are editing. Nothing is sent for you. Read aloud and
Finish & Send belong to the live route and are shown only there; with no connection that can
hear, the microphone is not offered at all.

**Resume…** on a finished child run (completed, failed, stopped or interrupted) starts a *linked new attempt*: a new task whose thread begins as a verbatim copy of the earlier attempt's record, on the same provider, endpoint and model — refused, never swapped, when any of those is no longer configured or listed, or when the earlier thread or its model stamp is missing. Nothing is replayed: tool results in the copy already happened and a call left unanswered reads as interrupted; the attempt is told so and given your instructions (default: continue where it stopped without replaying completed or uncertain actions). It runs under the ward's *current* tools and approvals and reports into the chat you resumed it from, which must still be the active one (a chat that changed underneath is refused). The earlier attempt's row and thread are never edited; the drawer shows *attempt N* and *Resumed later*. Rime's own `task_resume` is narrower: only this thread's children, capped by the calling run's own permissions, and never a run a person stopped or whose stop is unrecorded (migration 035 records who stopped a job; older rows are treated as unknown) — those you resume yourself. One live attempt per lineage; resuming an attempt that was already continued points you at the later one. An attempt refused before it started (a model no longer listed, say) stays as an audit row marked *never started*; it is never a source and never blocks resuming the attempt that did run. Who stopped a run is recorded the moment Stop is asked for, and a person's Stop is never downgraded by an earlier agent cancel or a restart. Ended *ward* threads keep History → **Continue here**. A thread now records the model it ran on (at every run start and model switch; older threads read *not recorded*), and History shows route and model per conversation. Continue here refuses a conversation whose provider is not configured here or whose route (provider and endpoint) differs from the ward's — set the ward's route first; it is never moved. With a recorded model the copy continues on that model and the ward is set to it (the button says so); without one it continues on the ward's current model only when you choose that button explicitly — never a silent default. Either way that model is re-checked against the route's live model list first: one the backend no longer serves, or one it cannot confirm, is refused with nothing copied, no thread opened and the ward's model left alone. A compat endpoint NAME is only a per-runtime alias, so a conversation records the base URL it actually ran against at the moment it ran (migration 037) — repointing the alias afterwards, or removing and re-adding it, changes neither the stored record nor what History shows, and Continue here refuses a thread whose endpoint now points somewhere else, one that never recorded a URL at all, and one from another runtime whose URL is machine-local (`localhost`, a loopback or LAN address means a different server here, however identical the string). Reading history never unseals today's key, so a rotated or unreadable credential cannot hide a conversation. Resuming a child run checks the same recorded backend.

That recorded backend is also what the thread's model calls are **pinned** to: the check happens where the request is built, from the same resolution the URL comes from, so an alias repointed mid-thread refuses the next turn ("point it back, or start a new chat") instead of carrying that conversation's context to another server — and a pinned call is never relayed to a paired server's endpoint of the same name. A backend is recorded only when this runtime is the one that serves it: a desktop paired to a server that offers an endpoint of the same name relays the call there, so such threads honestly read *not recorded* and Continue here declines them. Admission and commit are one boundary rather than a series of checks: the source record's hash, the ward's route and model, its active thread and the resolved backend are all bound when the continuation is admitted and re-checked in the same synchronous transaction that writes it, after the attachment work — a record replaced by a sync in between is refused rather than copied, a model or chat the person changed in between is never overwritten, and attachment rows prepared before a refusal are undone. Conversations on every configured provider (codex, openrouter, openai, compat) are listed locally; the shared-history format is versioned like note formats (chat format 2), so a runtime paired with an older server keeps such conversations local and says so, and an older client is simply not offered them — nothing is dropped or rewritten.

A user-initiated child Resume re-checks its parent chat after model validation and provider loading, immediately before creating the child. Opening another chat during that preflight refuses the attempt with no child thread created; it does not silently continue for the old chat. A Stop is checked again at that boundary, and any newly narrowed ward permissions are applied before the child starts.

Completed task logs are hidden from Rime's default queries and the Tasks drawer. **Show finished** reveals retained history; ordinary logs keep only the newest 100 for up to 30 days. Active tasks, undelivered results for current conversations, and child conversation records are preserved.

## Set approvals before giving work to an agent

Review each Rime ward's approvals and unattended-turn limits in its configuration. The default approval policy is oriented around outbound actions, but policies can be changed; do not assume every write or command will always prompt.

Native commands start in the selected workspace folder on its host, with that OS account's permissions. Virtual paths are resolved by file tools; an ordinary shell is not restricted to the virtual filesystem. **Let Rime control** is on by default in every terminal. You and Rime can type in the same session while it is on. Turn it off to stop Rime input; your keyboard stays active. Native command tools still follow the chat's approval setting.

Rime's targeted patch tool validates edits and protects dirty or human-owned buffers, with recovery copies before destructive writes. Review a patch and the resulting diff for consequential changes. Recovery and permission checks do not replace judgment about a command's effects.

## Keep working during longer tasks

Use **Run in background**, **Ctrl+B**, or `/background` when available. **Tasks** or `/tasks` shows progress, retained output, results, and Stop controls. Backgrounding releases the conversation to continue other work; it does not create permission to bypass an approval.

Use the individual task's **Stop** when you want to stop that work. Stopping a response is not a universal rollback, and stopping a wait does not necessarily terminate the process being observed. Check task and terminal status before running a command again. Runtime restarts mark unfinished task records interrupted rather than replaying them.

Rime can delegate a bounded assignment to a child agent with its own thread. Children inherit tool, project, and approval restrictions; an unattended child reports work that needs confirmation. Multiple agents can consume more model usage, so use delegation when independent work justifies it.

In **Tasks**, choose a child's **Open conversation** to read its transcript and live activity. Send instructions directly while it runs, answer a question it is waiting on, or use **Stop child**. Message delivery shows whether the child read your message or ended before receiving it. **Back to tasks** returns to the parent controls. Completed child conversations remain readable; sending here does not restart a finished run.

Unsent child drafts survive closing and reopening the conversation, and the desktop saves them for an app restart. A waiting question appears above the composer; your answer is tied to that question. Connection loss keeps the transcript and draft visible while reconnecting. If delivery cannot be confirmed, check **Message delivery** before sending the same instruction again.

Child notifications are delivered once. A failed or stopped receiving turn closes its message receipts; recovery does not replay them later. Stopped children retain their results without waking the parent. Queued monitor prompts check that their Leyline is still enabled before starting, and stopping a turn also discards unattended prompts already queued behind it.

Monitor observations appear in the chat as one collapsed **Monitor activity** block per burst, never as messages from you; open it to read the raw text, or use **Tasks** for the full recent matches. Rime answers a monitor wake only when something needs attention. A wake that finds nothing adds no reply, toast or badge, and your own messages and Rime's answers always follow the observations that came before them.

## Memory, skills, and automations

Memory and Skills wards expose reusable context and instructions for Rime. MCP wards connect additional tool servers under the configured trust policy. Review a tool server's access before connecting it.

**Leylines** are event-to-action connections between wards. Open Leylines mode, connect a source event to a target action, and configure conditions or templates as needed. Each line carries one trigger to one action; add more lines for fan-out.

Start with something easy to observe: a Button that starts a Routine. Then connect a service incident or another useful event to Rime. Inspect run results and set unattended-turn caps before leaving an automation active. Desktop-only automations require the local app to remain running; they do not become an always-on hosted service by themselves.
