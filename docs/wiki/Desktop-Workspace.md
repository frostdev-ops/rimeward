**Section 1 · Desktop only** · [Wiki home](Home) · Previous: [Setup](Desktop-Setup) · Next: [Work with Rime](Desktop-Rime)

## Build a place you want to work in

A page can be a project, a daily planner, a reading space, or a collection of services you watch. There is no separate development-page mode: the wards on a page determine what it does.

1. Open **Edit** and add the tools you need from the ward catalog.
2. Arrange and resize them. Use containers to group related tools and spacers for breathing room.
3. Open a ward's **Configure** dialog to choose its content, account, or behavior.
4. Use page tabs to separate different kinds of work.
5. Open **Account** for theme, typography, icons, glass, backgrounds, and header appearance.

Try a small starting layout: **Rime + Browser + Notepad + Routine**. For a daily overview, add Agenda and an Inbox after connecting those services. For operations, add Services and Incidents. A simple layout is easier to use than an empty card for every available integration.

## Open a project

Choose **Open project** and select an existing folder or create a named project. Rimeward reuses the existing project page when it can; a new one starts with Editor and Rime side by side, with Terminal and Changes below. Rime inherits that page's project context.

The folder remains where you selected it. Rimeward keeps references and recovery state; it does not import the folder into a proprietary project store. Project toolchains and dependencies are yours to install as usual.

## Edit and review files

Use the Editor's explorer to open files. **Cmd/Ctrl+P** opens a file quickly and **Cmd/Ctrl+S** saves. The **…** menu includes find/replace, go to line, word wrap, formatting, and recovery history.

Tabs retain undo history. If a file changes outside Rimeward while your buffer is dirty, **Compare changes** lets you choose the version explicitly. Closing a dirty tab keeps its recovery data for reopening. Treat recovery as help with interruptions, not a replacement for Git or backups.

Biome supplies linting and formatting for supported languages; the Problems panel shows current-file diagnostics. Formatting updates the buffer, so save to write it to disk. Analysis uses a bundled configuration rather than executing project scripts or plugins. Other languages can still have syntax highlighting without a configured linter.

Use Changes for Git review. This editor does not currently provide full language-server support, cross-file type checking, a debugger, or VS Code extension compatibility. Run project checks in a terminal when you need them.

## Use real terminals

**Open terminal** starts your shell. **+** adds a Shell, Codex, or Claude Code session; additional shell and permission settings live under **More options**. CLI agents must already be installed and signed in on this computer.

Session tabs run across the top. Closing a tab hides that view and **does not stop its process**. Reopen it from **… → Reopen**. Use **End session** to end a process, or the interrupt action when appropriate. Removing a ward also detaches its view rather than treating it as a request to kill the process.

Terminal controls deliberately distinguish two permissions:

| Control | Effect |
| --- | --- |
| **Allow Rime to type** | Lets Rime send input to that session, including answers to CLI prompts. New sessions start with this off. |
| **Standard / Unrestricted** | Changes a Codex/Claude CLI's own permission mode on its next start. Unrestricted bypasses that CLI's protections. |

A shell runs with your desktop user's OS permissions. **Take control** gives you input ownership and pauses agent input; **Let Rime type** releases human ownership. Search with **Cmd+F** or **Ctrl+Shift+F**; ordinary Ctrl+F remains available to the shell.

Quitting Rimeward stops its native processes. Saved screens can return after launch, but a saved screen does not resume the old process. **Start again** explicitly starts a new one.

## Browse, read, and capture

A Browser ward is a real Chromium session with its own profile. Its logins, extensions, and retained downloads belong to the runtime that runs it. Choose the local computer when working entirely on desktop.

Use **Downloads** to inspect transfers, save a copy, or download the currently displayed file. Retained downloads have limits of 25 MB per file, two minutes per transfer, one active transfer per ward, and 100 files. Removing the ward removes its profile and retained downloads, so save files you need first.

**Extensions → Install ZIP** accepts supported Manifest V3 packages. Review permissions, enable the extension, then use **Restart browser to apply** after finishing open forms. This does not install extensions into your ordinary Chrome/Edge profile or fetch Chrome Web Store listings. See the [extension reference](https://github.com/frostdev-ops/rimeward/blob/main/docs/browser-extensions.md) for compatibility and limits.

Mention the Browser or Notepad with **@** in Rime to provide context. Browser mentions capture the current page without switching tabs; notes can include saved text and ink. Imported downloads become conversation attachments and may be shared if you later enable Rime synchronization.

## Three workflows to try

- **Build:** open a project, ask Rime to explain a file, inspect its proposed changes, and run the project's checks in a terminal.
- **Focus:** place a routine timer beside your notes and calendar; use a Leyline to start the next step when a round ends.
- **Research:** keep Browser and Notepad beside Rime, mention the page you're reading, and ask for a summary tied to that context.

Continue with [Rime and automations](Desktop-Rime) to configure the model and decide how much autonomy it gets.
