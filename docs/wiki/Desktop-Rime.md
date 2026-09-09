**Section 1 · Desktop only** · [Wiki home](Home) · Previous: [Workspace](Desktop-Workspace) · Next: [Data and troubleshooting](Desktop-Care)

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

## Set approvals before giving work to an agent

Review each Rime ward's approvals and unattended-turn limits in its configuration. The default approval policy is oriented around outbound actions, but policies can be changed; do not assume every write or command will always prompt.

Native commands run with your computer account's permissions inside an approved project. Tool approval, an existing terminal's **Allow Rime to type**, and a CLI's **Standard / Unrestricted** setting are separate controls. Grant only the autonomy that fits the work.

Rime's targeted patch tool validates edits and protects dirty or human-owned buffers, with recovery copies before destructive writes. Review a patch and the resulting diff for consequential changes. Recovery and permission checks do not replace judgment about a command's effects.

## Keep working during longer tasks

Use **Run in background**, **Ctrl+B**, or `/background` when available. **Tasks** or `/tasks` shows progress, retained output, results, and Stop controls. Backgrounding releases the conversation to continue other work; it does not create permission to bypass an approval.

Use the individual task's **Stop** when you want to stop that work. Stopping a response is not a universal rollback, and stopping a wait does not necessarily terminate the process being observed. Check task and terminal status before running a command again. Runtime restarts mark unfinished task records interrupted rather than replaying them.

Rime can delegate a bounded assignment to a child agent with its own thread. Children inherit tool, project, and approval restrictions; an unattended child reports work that needs confirmation. Multiple agents can consume more model usage, so use delegation when independent work justifies it.

## Memory, skills, and automations

Memory and Skills wards expose reusable context and instructions for Rime. MCP wards connect additional tool servers under the configured trust policy. Review a tool server's access before connecting it.

**Leylines** are event-to-action connections between wards. Open Leylines mode, connect a source event to a target action, and configure conditions or templates as needed. Each line carries one trigger to one action; add more lines for fan-out.

Start with something easy to observe: a Button that starts a Routine. Then connect a service incident or another useful event to Rime. Inspect run results and set unattended-turn caps before leaving an automation active. Desktop-only automations require the local app to remain running; they do not become an always-on hosted service by themselves.
