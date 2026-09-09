**Section 2 · Remote / web** · [Wiki home](https://github.com/frostdev-ops/rimeward/wiki/Home) · Previous: [Integrations](https://github.com/frostdev-ops/rimeward/wiki/Remote-Integrations) · Next: [Screen control](https://github.com/frostdev-ops/rimeward/wiki/Remote-Screen-Control)

Remote access connects a desktop you own to your Rimeward account on a server you trust. The server supplies the web entry point; the desktop continues to own project files, editor recovery, terminals, and native execution.

## Pair the desktop

1. Install and launch Rimeward on the computer that owns your projects.
2. On first launch, choose **Bring your dashboard**; from an existing standalone setup, open **Connections**.
3. Enter your server's HTTPS address.
4. Follow the browser authorization flow, sign in to the intended server account, and approve the desktop connection.
5. Return to the desktop and open Rimeward. Confirm that the expected dashboard appears and the connection is available.
6. Open or create a project from that desktop if you have not already done so.

Device credentials are kept through the OS credential store. Approval does not copy CLI logins or project folders. Use current, compatible server and desktop releases; an older client can require an update for newer ward capabilities.

## Use the same work from a browser or phone

Sign in to the same server account on another device and open the dashboard. Project pages appear alongside other pages. Open the editor or terminal ward you need; Rimeward routes the request to its owning computer.

There is no need to toggle a local/server workspace mode. In the desktop app, work on its own project stays local. On the web, the corresponding ward controls the live desktop through the server. Other integrations use the account/runtime that owns them.

For editing, **Take over** transfers buffer control when needed. For terminals, **Take control** acquires input; **Review & take control** handles uncertain input after connection loss. A phone offers extra keys for shell work. Closing a terminal view is not the same as stopping the process.

You do not need screen-recording or Accessibility permission for the project-editor/terminal route itself. Use a Remote Desktop ward only when you need to see and interact with the physical computer's screen.

## What is shared, and what stays put?

| Data | Behavior after pairing |
| --- | --- |
| Pages, ward configuration, theme, icons, backgrounds | Shared dashboard state, with local recovery/conflict handling. |
| Rime files, memory, skills, attachments, chat transcripts | Synchronized account-scoped agent data. This can include code excerpts and tool output. |
| Project folders and files | Stay on the original computer. Remote reads/edits travel through the live relay. |
| Editor recovery and workspace database | Desktop-owned; not replicated into the server database. |
| Native terminals, processes, and task execution | Stay on the computer where they started. Viewing history does not migrate a process. |
| Pending confirmations and input ownership | Not copied into a continuation or replayed after reconnect. |
| Provider/integration credentials | Stay on the installation that holds them; connected access is routed. |
| Browser profiles and retained downloads | Stay with the browser's runtime. Explicitly importing a download into chat makes it a conversation attachment. |

On first connection the server supplies the shared dashboard and Rime profile; existing desktop project pages and custom wards are merged in. A pre-join dashboard is retained locally. Conflicting shared Rime versions remain recoverable through **Chat history → Recovered version**.

**This is a trusted-server design.** HTTPS protects network transport, but the server operator can access relayed plaintext and stored shared Rime content. Project folders not being mirrored does not mean no project information passes through the server or reaches a model provider. Use an instance and providers appropriate for your work.

## Continue a conversation elsewhere

**Chat history → Continue here** creates a continuation on the current runtime while preserving the original conversation. Attachments and history can follow; pending actions and native processes do not. Check the originating task if something was already running before launching it again.

The first connected server supplies Rime's default profile/provider access. Ward-specific choices still apply. For new model calls during a server outage, configure a local provider in the desktop independently.

## Understand outages

| Situation | What to expect |
| --- | --- |
| Desktop sleeps, quits, or loses its connection | Its editor, terminal actions, browser sessions, and screen become unavailable remotely. Server features can remain usable. |
| Server goes down | Its web dashboard, integrations, and relay are unavailable. The desktop still opens its local app and projects. |
| Connection returns | State is reconciled. Uncertain terminal input and mutations are not automatically replayed. Reacquire control where required. |
| A client is too old | Update the affected installation. Do not discard local data to get around an update requirement. |

Remote access does not wake or run a powered-off computer. Arrange the host's power settings for the availability you need, and understand the cost of leaving it running.

## Revoke access

Use **Connections** or the account's device controls to remove the pairing when it is no longer wanted. Verify that a separate signed-in viewer can no longer reach that computer through the revoked connection.

For an immediate **screen-control** stop, use the desktop tray's **Stop remote access**. That latch suspends viewing and synthetic screen input until a local action resumes it; native terminal commands continue independently. It is not a substitute for revoking an entire pairing or stopping a native task.
