**Section 2 · Remote / web** · [Wiki home](https://github.com/frostdev-ops/rimeward/wiki/Home) · Previous: [Screen control](https://github.com/frostdev-ops/rimeward/wiki/Remote-Screen-Control)

## Keep the service understandable

Run one persistent application instance against its intended data directory, with a process manager or the supplied Compose restart policy. Watch application health, available storage, certificate expiry, and backup completion. Scheduled Leylines use the server process timezone; set `TZ` deliberately before relying on due times.

Give shutdown at least ten seconds. Browser profiles need graceful Chromium shutdown to flush session data, and native/background work has its own interruption handling. A restart is not permission to replay a failed action.

Useful checks:

```sh
node bin/rimeward.mjs doctor
node bin/rimeward.mjs users list
node bin/rimeward.mjs monitors list
```

For Compose, prefix these commands with `docker compose exec app`. Use `docker compose ps` and `docker compose logs --tail=100 app` for container status and recent logs. Keep logs private and remove sensitive values before sharing diagnostics.

## Back up the web application

Use the CLI for an online SQLite backup and the application subdirectories it knows about:

```sh
node bin/rimeward.mjs backup /srv/backups/rimeward-2026-09-09
```

Choose a **new, empty destination** outside the app's data directory for each run. The date is only an example. The command copies `homepage.db` plus existing `backgrounds`, `attachments`, `agent`, `browser`, `browser-downloads`, and `brand` directories. It uses SQLite's backup API rather than copying a live database file.

Also preserve:

- `TOKEN_ENC_KEY` and relevant environment/service configuration, stored securely with access controls.
- Any custom data outside the command's listed directories.
- Proxy/CDN configuration and the application revision needed for rollback.

The database copy is online-consistent; file copies and changing browser profiles are not a transaction with that database. Quiesce writes and close active browser work for a coordinated full snapshot. Do not casually copy a live SQLite file or its WAL separately and call that a valid backup.

For the supplied Docker volume, create the backup inside the mounted data volume, then copy it out:

```sh
docker compose exec app node bin/rimeward.mjs backup /data/backups/rimeward-2026-09-09
mkdir -p ./backups
docker compose cp app:/data/backups/rimeward-2026-09-09 ./backups/
```

Use a unique name each time and move the exported backup to protected storage outside the server. The CLI's fixed subdirectory list does not recursively include `/data/backups`. Backups left only in the same Docker volume do not protect against losing that volume.

A web backup does not back up desktop projects, `workspaces.db`, OS credentials, or native processes. Follow [desktop care](https://github.com/frostdev-ops/rimeward/wiki/Desktop-Care) separately. Dashboard/history synchronization is not a substitute for either backup.

## Restore deliberately

Stop the application before restore and preserve the current data for recovery. Restore the matching encryption key/configuration first. For a stopped direct-Node instance:

```sh
node bin/rimeward.mjs restore /srv/backups/rimeward-2026-09-09
```

The restore command replaces the database but copies the listed file directories over existing ones; it is not a clean mirror and can leave unrelated newer files. For a precise rollback, restore into a fresh data directory with the correct ownership and point the service at it. Keep the previous directory until verification is complete.

For Compose, stop the service and use a one-off container with the same named volume/environment, or restore into a replacement volume. The CLI and backup must both be accessible to that container. Avoid `docker compose down -v`: it deletes the named application volume.

Start the matching application revision, check login and decryption of a service connection, and verify a page, an attachment, and Rime history. Test recovery periodically rather than discovering a missing encryption key during an outage.

## Upgrade and roll back

The server checks GitHub for a newer release every six hours. When one is published, the dashboard header shows an update chip for every user, admins see the details under **Users → Updates**, and the **Update available** leyline trigger (anchored on a Services ward) can send it anywhere a leyline reaches: push, chat, mail. The policy under **Updates** is *notify* by default; *install* has a Node install update itself and restart; *off* stops the checks.

1. Read the target release notes and note the existing application revision.
2. Take a fresh backup and retain the existing app and service/proxy configuration.
3. Finish or stop important tasks and close browser work gracefully.
4. Install the release:
   - **Node**: `node bin/rimeward.mjs update --yes` (or the chip's **Install** as an admin). It downloads the prebuilt release archive, verifies its checksum, installs dependencies in a staging directory beside the checkout, then swaps the directories in — the live tree changes for milliseconds, not for the length of an install. The archive is cached under the data directory; the replaced tree is kept in `.update/prev`.
   - **Docker**: `docker compose pull && docker compose up -d` (the image is `ghcr.io/frostdev-ops/rimeward`, tagged per version and `latest`), or rebuild from the tagged revision.
5. Restart the service: pass `--restart "<your reload command>"` or set `RIMEWARD_RESTART_CMD` (for example `pm2 reload rimeward`) so the CLI and the automatic install can run it. Without either, the automatic install exits the process and relies on the supervisor restarting it (pm2 does; systemd needs `Restart=always`).
6. Verify the public login, a saved page, live updates, and any paired desktop routes you use.
7. Update desktop installations when protocol/capability changes require matching clients. Installed apps offer the new version themselves once its release is published.

To go back: `node bin/rimeward.mjs update --rollback` swaps `.update/prev` back, then restart. Database migrations run on open. An old application binary is not a complete rollback after a schema change: preserve and restore the matching database/files/configuration if necessary. Do not apply undocumented manual schema edits to force a downgrade.

## Check remote access after a deployment

Verify more than a successful homepage response:

- Authorize a desktop through the public HTTPS origin and confirm its device WebSocket stays connected.
- Open a project from a separate browser and verify a harmless read plus streamed terminal output.
- Disconnect the desktop and confirm the interface reports it unavailable. Reconnect without replaying input.
- Revoke a disposable pairing and confirm further access fails.
- Check `no-store` responses and every proxy/CDN layer's buffering and cache exclusions.
- With disposable data, inspect origin logs, cache/temp paths, server data, and backup output for unexpected copies of a unique relay marker. Shared Rime history is intentionally stored; raw project relay payloads must not be persistently cached or logged.

For screen streaming, separately check OS permissions, direct WebRTC, fallback behavior, audio when enabled, and forced TURN if configured. A signed build or a reachable TLS port alone does not establish those paths.

## Troubleshoot by symptom

| Symptom | Likely next check |
| --- | --- |
| Sign-in redirects or origin checks fail | `PUBLIC_BASE_URL`, HTTPS termination, hostname, and the URL the browser actually uses. |
| OAuth reports a bad redirect | Exact callback URL, provider registration, and credentials on the authorizing runtime. |
| Pages load but devices never connect | Use `server.mjs`; verify WebSocket upgrades for `/api/devices/connect` and the proxy path. |
| Chat/terminal updates arrive in bursts | Response buffering, compression/CDN transformations, idle timeouts, and live-stream routing. |
| Remote editor is unavailable | Owning desktop running/awake, current pairing, compatible versions, and authenticated relay health. |
| Browser login or downloads seem missing | The ward's owning runtime and profile. An unavailable owner must not fall back silently to another computer. |
| Rime works on web but not during a desktop outage | Configure a separate local provider; server keys are not copied. |
| Screen is viewable but input fails | Control ownership, host access policy, OS permissions, and compositor/secure-desktop limits. |
| Screen uses Compatibility mode | WebRTC reachability and media support; TURN requires real provisioning, not just a secret. |
| Restored credentials fail to decrypt | The matching `TOKEN_ENC_KEY`; avoid generating a replacement for an existing database. |
| Monitor shows the wrong environment | PM2/Docker/systemd probes run where the application runs, including inside a container. |

Use **Devices → Remote Desktop diagnostics** for owner-scoped session failures and transport metrics. Its TURN TLS check is distinct from allocation/media verification. Keep sensitive payloads out of diagnostics and issue reports.
