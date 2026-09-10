**Section 1 · Desktop only** · [Wiki home](https://github.com/frostdev-ops/rimeward/wiki/Home) · Previous: [Workspace](https://github.com/frostdev-ops/rimeward/wiki/Desktop-Workspace) · Next: [Data and troubleshooting](https://github.com/frostdev-ops/rimeward/wiki/Desktop-Care)

Rime is the agent in your workspace. The model provides reasoning; Rimeward supplies the conversation, tools, project context, memory, and permission checks that let it act.

## Choose a provider

Open **Account → Agent** and configure the provider you want. Then choose the provider/model in the agent ward's configuration or inherit the Rime default.

| Provider | What you supply |
| --- | --- |
| ChatGPT backend (Codex) | The account connection offered by Rimeward. Availability depends on that account and service. |
| OpenRouter | Your OpenRouter connection and access to the selected model. |
| OpenAI API | Your API key and API billing/access. |
| OpenAI-compatible endpoint | The endpoint URL, credentials if required, and a model that supports the tools you need. |

Model lists expose provider-reported capabilities where available. Not every model supports tools or images, and a local server exposing a chat API does not guarantee reliable agent behavior. Prices, model access, and quotas belong to the provider. Rimeward does not include model credits.

A conversation stays with the provider it began on. To change provider, start a new conversation or explicitly delegate work to a child using that provider. Rime can choose another available model within its provider at a round boundary. An unavailable model is reported rather than silently substituted.

## Use a local model

1. Install and start the local model server of your choice separately, such as Ollama, LM Studio, or vLLM.
2. Download a model suitable for tool use; download a vision-capable model if you need images.
3. In **Account → Agent**, add an OpenAI-compatible endpoint using that server's documented API address and model ID.
4. Choose it for Rime and try a simple request, followed by a harmless tool read.

Rimeward does not install the model server or weights. Memory use, response speed, and tool reliability depend on the model and hardware. Use the address your server actually reports, rather than assuming a port or API path. Remote endpoints require HTTPS. Plain HTTP is allowed only for a loopback endpoint used from the desktop; credentials are not forwarded through redirects.

With the endpoint, model, and Rimeward on the same computer, AI can work without a Rimeward server or cloud model service. Tools that read online sites or integrations still need a network connection.

## Give Rime the right context

Open a project page to supply that project's context. Type **@** to select wards by name or page: an editor buffer, terminal output, a browser page, a note, or connected information. You can also attach files.

Mentions capture context when you send. They do not authorize a command, send a message to another agent, or acquire Remote Desktop control. Check the captured source when multiple wards have similar names. Offline or unavailable sources are reported explicitly.

Use the activity view to inspect tool work. A new message can steer a running turn. **Chat history** keeps previous conversations; starting a new chat archives the current one after the operation succeeds.

Use `/compact` to summarize older context while keeping the full transcript on disk. It runs on the conversation's owning computer, including when you send it from another desktop. The connection stays open while the summary is prepared; wait for the result before requesting another compaction.

## Set approvals before giving work to an agent

Review each Rime ward's approvals and unattended-turn limits in its configuration. The default approval policy is oriented around outbound actions, but policies can be changed; do not assume every write or command will always prompt.

Native commands run with your computer account's permissions inside an approved project. **Let Rime control** is on by default in every terminal. You and Rime can type in the same session while it is on. Turn it off to stop Rime input; your keyboard stays active. Native command tools still follow the chat's approval setting.

Rime's targeted patch tool validates edits and protects dirty or human-owned buffers, with recovery copies before destructive writes. Review a patch and the resulting diff for consequential changes. Recovery and permission checks do not replace judgment about a command's effects.

## Keep working during longer tasks

Use **Run in background**, **Ctrl+B**, or `/background` when available. **Tasks** or `/tasks` shows progress, retained output, results, and Stop controls. Backgrounding releases the conversation to continue other work; it does not create permission to bypass an approval.

Use the individual task's **Stop** when you want to stop that work. Stopping a response is not a universal rollback, and stopping a wait does not necessarily terminate the process being observed. Check task and terminal status before running a command again. Runtime restarts mark unfinished task records interrupted rather than replaying them.

Rime can delegate a bounded assignment to a child agent with its own thread. Children inherit tool, project, and approval restrictions; an unattended child reports work that needs confirmation. Multiple agents can consume more model usage, so use delegation when independent work justifies it.

In **Tasks**, choose a child's **Open conversation** to read its transcript and live activity. Send instructions directly while it runs, answer a question it is waiting on, or use **Stop child**. Message delivery shows whether the child read your message or ended before receiving it. **Back to tasks** returns to the parent controls. Completed child conversations remain readable; sending here does not restart a finished run.

Unsent child drafts survive closing and reopening the conversation, and the desktop saves them for an app restart. A waiting question appears above the composer; your answer is tied to that question. Connection loss keeps the transcript and draft visible while reconnecting. If delivery cannot be confirmed, check **Message delivery** before sending the same instruction again.

Child notifications are delivered once. A failed or stopped receiving turn closes its message receipts; recovery does not replay them later. Stopped children retain their results without waking the parent. Queued monitor prompts check that their Leyline is still enabled before starting, and stopping a turn also discards unattended prompts already queued behind it.

## Memory, skills, and automations

Memory and Skills wards expose reusable context and instructions for Rime. MCP wards connect additional tool servers under the configured trust policy. Review a tool server's access before connecting it.

**Leylines** are event-to-action connections between wards. Open Leylines mode, connect a source event to a target action, and configure conditions or templates as needed. Each line carries one trigger to one action; add more lines for fan-out.

Start with something easy to observe: a Button that starts a Routine. Then connect a service incident or another useful event to Rime. Inspect run results and set unattended-turn caps before leaving an automation active. Desktop-only automations require the local app to remain running; they do not become an always-on hosted service by themselves.
