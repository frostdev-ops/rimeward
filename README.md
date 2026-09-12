<p align="center">
  <img src="assets/rimeward-lockup.svg" alt="Rimeward by frostdev" width="560">
</p>

<p align="center">
  <strong>A workspace for your agents, your work, and your sense of style.</strong><br>
  An open-source agentic harness built around aesthetics, productivity, and making yourself at home.
</p>

<p align="center">
  <a href="https://github.com/frostdev-ops/rimeward/releases/latest">Download desktop</a> ·
  <a href="https://github.com/frostdev-ops/rimeward/wiki">Read the wiki</a> ·
  <a href="https://github.com/frostdev-ops/rimeward/wiki/Remote-Web-Setup">Self-host</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">
  <a href="https://github.com/frostdev-ops/rimeward/actions/workflows/test.yml"><img src="https://github.com/frostdev-ops/rimeward/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-89cbd5" alt="MIT license"></a>
</p>

<p align="center">
  <img src="docs/goldens/splash.png" alt="Rimeward's animated topographic welcome screen" width="960">
</p>

## Make room for the way you work

Rimeward brings an AI agent, a development workspace, and your everyday tools into a place you can shape. Write code beside a live terminal. Keep your notes, calendar, inbox, and browser within reach. Give your agent context from the things you're looking at, then keep working while it handles a task.

It's an **agentic harness**: the environment around a model that gives it tools, context, memory, approvals, and a way to do useful work. The built-in agent, **Rime**, can work with your projects and dashboard, use a browser, coordinate other agents, and follow automations you set up. You choose its provider and model, what it can access, and when it needs your approval.

The aesthetics are part of the idea. Arrange your own pages, choose the typography and icons, tune the colors and glass, and set a living background or a favorite photo. Build a quiet place to focus, a personal command center, or something in between.

**Start with the desktop app on its own.** Add a server later if you want a web dashboard, services that stay online, or access to your desktop from another device.

## What you can do

| | In Rimeward |
| --- | --- |
| **Work with an agent** | Chat with Rime, attach files, mention a ward with `@`, inspect tool activity, and follow background tasks. Give separate agent wards their own roles and models. |
| **Build things** | Open a local project with an editor, real shell terminals, Git changes, recovery diffs, and bundled linting and formatting. Run your installed Codex or Claude Code CLI in a terminal. |
| **Bring your day together** | Put notes, routines, weather, service health, mail, calendars, Notion, and messaging tools on pages that make sense to you. Connect only the services you use. |
| **Connect actions** | Draw **Leylines** between wards: a button starts a routine, a service incident asks Rime to investigate, or an event feeds the next step of a workflow. |
| **Share a browser with Rime** | Browse in a real Chromium session, keep logins on its owning computer, manage downloads and extensions, and ask Rime about the current page. |
| **Make it feel like yours** | Choose themes, fonts, icon packs, backgrounds, header scenes, page layouts, and instance branding. Appearance belongs to your workspace. |
| **Pick up elsewhere** | With a paired server, use your live desktop-owned editor and terminals from a browser or phone. Add a Remote Desktop ward when you need the computer's screen, too. |

<p align="center">
  <img src="docs/goldens/dashboard.png" alt="A Rimeward page with Rime, a browser, notes, routines, and everyday tools" width="960">
</p>

### A few words you'll see

A **ward** is a tool on a page: an editor, an inbox, a notepad, an agent. **Pages** organize your wards. **Rime** is the agent. **Leylines** connect events in one ward to actions in another. That's enough vocabulary to get started.

## Choose how to run it

| | Desktop only | Remote / web |
| --- | --- | --- |
| **Best for** | A personal workspace on one computer. | A browser dashboard, always-on services, or reaching a paired desktop elsewhere. |
| **What you install** | The desktop app. Node and Chromium are bundled. | A Rimeward server; add the desktop app for local projects and native tools. |
| **What you manage** | Your app, files, model connection, and optional integrations. | Server updates, HTTPS, accounts, backups, integrations, and relay configuration. |
| **Where work runs** | On your computer; cloud model calls use your chosen provider. | Web features on the server; project files, shells, and native tools on the paired desktop. |
| **When the desktop is off** | Local work and local automations stop. | Server features remain available; that desktop's tools and screen do not. |
| **Complexity** | The easiest starting point. Local models and OAuth integrations add setup. | More flexibility and more administration. Screen streaming adds permissions and network considerations. |
| **Guide** | [Desktop setup](https://github.com/frostdev-ops/rimeward/wiki/Desktop-Setup) | [Remote / web setup](https://github.com/frostdev-ops/rimeward/wiki/Remote-Web-Setup) |

### Desktop: get started in a few steps

1. Download an installer from [Releases](https://github.com/frostdev-ops/rimeward/releases/latest): **Apple Silicon macOS**, **Windows**, or **Linux**. See the [platform requirements](https://github.com/frostdev-ops/rimeward/wiki/Desktop-Setup#requirements).
2. Launch Rimeward. Under **Start right here**, choose **Continue without connecting** or **Open or create a project**.
3. Open **Account → Agent** to connect a model provider when you're ready to use Rime.
4. Open a project, or edit a page and add the wards you want.

No Rimeward server, domain, Docker installation, or separate Node installation is needed. A standalone app can still use online services: **desktop-only does not mean every feature works offline**. For offline AI, configure a local model endpoint and download its model first.

[Set up the desktop →](https://github.com/frostdev-ops/rimeward/wiki/Desktop-Setup)

### Remote / web: start with a server

Rimeward's web application works on its own for dashboards, integrations, and server-side agents. Pair the desktop app when you want local development tools or screen control from the web. Pairing uses **Connections** and approval in your normal browser.

The [server guide](https://github.com/frostdev-ops/rimeward/wiki/Remote-Web-Setup) covers Docker and Node installations, first login, HTTPS, and the required streaming proxy configuration. The [remote guide](https://github.com/frostdev-ops/rimeward/wiki/Remote-Access) walks through pairing and daily use.

**Your projects stay on their computer.** Remote clients control the live desktop; project folders are not mirrored to the server. Shared Rime history, attachments, and memory can contain code and tool output. The server is trusted and can see relayed content; this is not end-to-end encryption against its operator.

## A closer look

Rime supports persistent background monitors, tools loaded through search, and
semantic retrieval over existing knowledge. See [retrieval setup and operation](docs/semantic-retrieval.md).

Replies stream as they arrive, with an expandable timeline for each action.
Scrolling up pauses automatic following; **Latest** returns to the live response.
Compact, expanded, and child-agent chats share your theme and font settings,
respect reduced motion, and retain incomplete replies when a response stops.
Agent wards have a four-row minimum to leave room for the visible chat controls.

<p align="center">
  <img src="docs/goldens/editor.png" alt="The desktop editor with a project explorer, file tabs, and inline diagnostics" width="960">
</p>

<details>
<summary><strong>Agent conversations, automations, and remote access</strong></summary>

<p align="center">
  <img src="docs/goldens/chat.png" alt="An expanded Rime conversation with tool activity and code" width="960">
  <img src="docs/goldens/leylines.png" alt="Leylines connecting ward events and actions" width="960">
</p>
<p align="center">
  <img src="docs/goldens/editor-phone.png" alt="A desktop-owned editor viewed on a phone" width="260">
  <img src="docs/goldens/terminal-phone.png" alt="A live terminal viewed on a phone" width="260">
  <img src="docs/goldens/chat-phone.png" alt="Rime on a phone" width="260">
</p>

Screenshots use demonstration data. Available features depend on your installed version, platform, and connected services.

</details>

## Models, permissions, and expectations

Rime supports the **ChatGPT backend (Codex)**, **OpenRouter**, the **OpenAI API**, and **OpenAI-compatible endpoints** such as local model servers. Configure providers under **Account → Agent**. Provider access, billing, model availability, and any separately installed CLI authentication remain your responsibility; downloading Rimeward does not include model credits.

Approvals are configurable per agent ward. Native terminal commands use your desktop account's permissions. Review those settings before enabling unattended work. Local files and shells do not depend on a Rimeward server, but connected integrations and cloud models need their respective services.

Rimeward is actively developed. Its editor includes file editing, recovery, and Biome diagnostics; language servers, a full debugger, and VS Code extension compatibility are outside the current editor. Intel Mac installers are not provided. Check release notes before relying on a feature described by the latest source.

## Documentation

The [wiki](https://github.com/frostdev-ops/rimeward/wiki) has two sections:

- **[Desktop only](https://github.com/frostdev-ops/rimeward/wiki/Desktop-Setup)** — install, connect a model, build your workspace, work with Rime, and look after your local data.
- **[Remote / web](https://github.com/frostdev-ops/rimeward/wiki/Remote-Web-Setup)** — host the web app, configure integrations, pair computers, use remote tools, and maintain the server.

For implementation details, see the [documentation index](docs/README.md). Wiki sources live in [docs/wiki](docs/wiki/Home.md) so documentation changes can be reviewed with the code.

## Built with

[Astro](https://astro.build), TypeScript, Tailwind CSS, and SQLite power the application. [Tauri](https://tauri.app) wraps the desktop with a bundled Node runtime and Chromium. CodeMirror and Biome power editing; xterm.js and node-pty provide real terminals.

To work on Rimeward itself, follow [CONTRIBUTING.md](CONTRIBUTING.md) for the development environment and checks. Bug reports and focused improvements are welcome in [Issues](https://github.com/frostdev-ops/rimeward/issues) and pull requests.

## License

[MIT](LICENSE). Make it your own.
