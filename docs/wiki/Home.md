Rimeward is a customizable workspace for AI-assisted work. Its agent, **Rime**, can use the tools you put around it: projects, a browser, notes, integrations, and automations. You choose both the workflow and the look of the place.

This wiki has **two sections**. Start with desktop only if you want the fewest moving parts. Read remote / web if you want a hosted dashboard or access from other devices. You can add a server to a standalone desktop later.

| | Desktop only | Remote / web |
| --- | --- | --- |
| Good fit | Personal productivity and development on one computer. | An always-on dashboard, integrations, and access from elsewhere. |
| Required | A desktop installer; a model connection for AI. | A server and user account; a paired desktop for native tools. |
| Main benefit | Direct access to your files with no Rimeward server to operate. | Web access and server features that can stay online while your desktop is off. |
| Main cost | Local work stops when the app quits; you manage local data and optional services. | Hosting, HTTPS, backups, account security, and streaming proxy configuration. |
| Project execution | On this desktop. | On the owning desktop, reached through the server. |

## 1. Desktop only

1. **[Install and first launch](Desktop-Setup)** — platform requirements, no-server onboarding, and optional source builds.
2. **[Make your workspace](Desktop-Workspace)** — pages, appearance, projects, editing, terminals, browsers, and useful everyday workflows.
3. **[Work with Rime](Desktop-Rime)** — providers, local models, context, approvals, tasks, memory, and Leylines.
4. **[Data, updates, and troubleshooting](Desktop-Care)** — offline behavior, backups, recovery, startup issues, and moving to remote access.

## 2. Remote / web

1. **[Install the web application](Remote-Web-Setup)** — Docker or Node, configuration, an administrator account, HTTPS, and first checks.
2. **[Connect services](Remote-Integrations)** — model access, OAuth callbacks, mail, calendar, Notion, messaging, and service monitoring.
3. **[Pair and use a desktop](Remote-Access)** — connection approval, automatic routing, shared data, and working from another browser or phone.
4. **[Use Remote Desktop](Remote-Screen-Control)** — screen viewing, human/Rime control, permissions, files, audio, and transport limitations.
5. **[Operate and troubleshoot](Remote-Operations)** — backups, upgrades, server shutdown, connection diagnosis, and privacy checks.

### The three pieces

**Desktop app:** owns your local projects, editor recovery, shell processes, and native actions. It works without a Rimeward server.

**Web application:** runs on a server, provides its own dashboard and integrations, and can relay an authenticated connection to your desktop. A server installation does not turn the server into a native development machine.

**Remote Desktop ward:** an optional screen-and-input tool for a paired computer. You do not need it to use remotely routed project editors or terminals.

A **ward** is one tool on a page. **Pages** organize your tools. **Leylines** connect a ward's events to actions. **Rime** is the agent that works with them.

These guides describe the current source. Match features to your [installed release](https://github.com/frostdev-ops/rimeward/releases); platform permissions and service availability still apply. For technical contracts and contributor checks, use the [repository documentation index](https://github.com/frostdev-ops/rimeward/blob/main/docs/README.md).
