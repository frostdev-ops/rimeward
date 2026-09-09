**Section 1 · Desktop only** · [Wiki home](Home) · Previous: [Work with Rime](Desktop-Rime)

## Know what lives locally

The desktop owns its application profile, local dashboard database, workspace database, editor recovery, native task receipts, browser profiles, and retained browser downloads. Project folders remain at the paths you approved. The encryption key and connection credentials depend on the operating system's credential storage.

The application identifier is `io.frostdev.rimeward`. On macOS the profile is under `~/Library/Application Support/io.frostdev.rimeward/`; Windows and Linux use their platform's application-data location. The launcher uses Tauri's app-data directory, so locate that directory for your platform rather than copying the repository's development `data/` folder and assuming it is your installed profile.

## Back up and update

1. Finish or stop important tasks, save working files, and quit Rimeward gracefully.
2. Back up the Rimeward application profile using your normal protected local backup process. A stopped app allows a consistent copy of its databases and recovery files.
3. Back up your projects separately with Git and your usual project-backup tools. Rimeward profile backup does not include those folders.
4. Preserve OS credential storage through your platform's supported backup/migration process. Copying databases alone does not guarantee encrypted credentials will work on another computer.
5. Install the newer official release while retaining the existing profile. Reopen and confirm pages, projects, history, and provider access.

Do not delete the profile or reset the credential vault as a first troubleshooting step. Keep a backup before upgrades. If a new version has opened and migrated a database, restoring an old app binary alone is not a complete rollback; use the matching pre-upgrade profile if a rollback is necessary.

The repository CLI's `backup` command is a **web/application database backup**, not a complete desktop migration tool. It does not include `workspaces.db`, project folders, native process state, or your OS credential vault. Avoid treating it as a one-command desktop backup.

## What works offline?

| Feature | Without the internet or a connected Rimeward server |
| --- | --- |
| Local project editor, Git tools, shell | Available while the desktop runtime is running, subject to each command's own network needs. |
| Saved dashboard, notes, local history | Available locally. |
| Local model endpoint | Can provide new turns if its service and downloaded model are available. |
| Cloud model provider | Requires that provider's service and network access. |
| Mail, calendar, Notion, online browser pages | Require their external services for fresh data/actions. |
| Remote clients | Cannot reach this desktop while it is offline. |

If you later pair a server, an outage does not move native work to the server. New Rime turns need a separately configured local provider when the shared server provider is unavailable.

## Troubleshoot by symptom

| Symptom | First checks |
| --- | --- |
| Rime cannot send a new turn | Confirm the selected provider/model, account access or credits, and endpoint availability. A visible old transcript does not prove a live provider connection. |
| A CLI session will not start | Install and authenticate that CLI on this computer; confirm it is available to the app's environment. Rime's model connection is separate. |
| A terminal tab disappeared | Use **… → Reopen**. Closing the tab hides it without ending the process. |
| The app restarted but a build is no longer running | Native processes do not resume from saved terminal screens. Inspect output before choosing **Start again**. |
| A file has conflicting changes | Open **Compare changes** or recovery history. Choose the intended version instead of repeatedly saving over it. |
| Browser changes have not applied | Finish open forms, then use **Restart browser to apply** in Extensions. Keep the profile for saved logins. |
| OAuth returns a redirect error | Compare the provider registration to the actual local origin and exact callback path. The desktop uses a stable loopback port. |
| The launcher stops before the dashboard | Record the failing startup stage and safe diagnostic code. Check app integrity and OS credential-store availability without resetting the profile. |

Startup stages distinguish profile files, credential access, port allocation, backend startup, and the initial HTTP handshake. On Windows, use a current installer before diagnosing an old startup failure as a bad credential store. See the [startup reference](https://github.com/frostdev-ops/rimeward/blob/main/docs/development-workspaces.md#desktop-startup-diagnostics).

When reporting a bug, include your OS, app version, the failing stage, and a short reproduction with sensitive values removed. Do not post credential-store contents, cookies, private project files, or your application databases.

## Add remote access later

You do not need to reinstall or relocate projects. Set up a server or obtain an account on one you trust, then use **Connections** in the desktop app. Read [Pair and use a desktop](Remote-Access) before connecting so you understand the shared dashboard and Rime-history synchronization.
