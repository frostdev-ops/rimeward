**Section 2 · Remote / web** · [Wiki home](https://github.com/frostdev-ops/rimeward/wiki/Home) · Previous: [Web setup](https://github.com/frostdev-ops/rimeward/wiki/Remote-Web-Setup) · Next: [Pair a desktop](https://github.com/frostdev-ops/rimeward/wiki/Remote-Access)

Connect services in two stages: the operator enables any required application credentials, then each user authorizes their own account and configures its wards. Most installations can start with a model provider and add other services later.

## Rime's model access

Use **Account → Agent** to connect the ChatGPT backend (Codex), OpenRouter, an OpenAI API key, or an OpenAI-compatible endpoint. Select a provider/model for the default Rime profile or for individual agent wards.

A paired desktop can use the connected server's provider access while the server retains the credentials. That does not sign a local Codex/Claude CLI in, and it does not make server credentials available when the server is offline. Configure a separate local provider for that case. Local model HTTP endpoints are a desktop-only loopback allowance; remote endpoints require HTTPS.

## OAuth applications and callbacks

The operator registers an OAuth application with each service being used, then supplies the corresponding environment variables on the runtime that performs authorization. Replace `{BASE}` below with the exact `PUBLIC_BASE_URL`, with no extra trailing slash.

| Service | Environment variables | Registered callback URLs |
| --- | --- | --- |
| Google sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `{BASE}/api/auth/google/callback` |
| Gmail and Google Calendar | Same Google application credentials | `{BASE}/api/connect/google/callback` |
| Microsoft / Outlook / Teams | `MS_CLIENT_ID`, `MS_CLIENT_SECRET`; optional `MS_TENANT_ID` (default `common`) | `{BASE}/api/connect/microsoft/callback` |
| Notion | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` | `{BASE}/api/connect/notion/callback` |
| Zoho Mail | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` | `{BASE}/api/connect/zoho/callback` |

Use the provider's current registration process and allow the required account/audience and redirect URLs. After changing the process environment, restart the server gracefully. With Compose, recreate the container so it receives the changed environment. Then use the user's **Account** page to connect the service.

Do not put OAuth client secrets in ward text, browser URLs, or repository files. OAuth application credentials are operator configuration, not the same thing as a user's completed account connection.

**Standalone desktop caveat:** callback paths are the same, but the base must be the actual stable loopback origin of that desktop, and the provider must accept that redirect type. The current OAuth client-credential loader reads the runtime environment (with legacy database settings overrides); there is no general graphical OAuth-app registration wizard. Providing those client credentials to a packaged desktop is an advanced runtime-configuration task. You do not need OAuth integrations to use the desktop, and a connected server can supply integrations without copying its secrets to the desktop.

## Accounts and sign-in

Create a password user with the CLI or administer users through the app. For a Google SSO-only user, the CLI supports:

```sh
node bin/rimeward.mjs users create you@example.com --sso
```

Without `SSO_WORKSPACE_DOMAIN`, Google sign-in is restricted to invited addresses. Setting that variable permits accounts from the specified Workspace domain to sign in without individual invitations; its first user becomes admin. Use it only if that domain-wide enrollment is intended.

Use distinct accounts for people who need access. Pairing and Remote Desktop permissions belong to the owning account; this release does not provide general cross-account desktop sharing.

## Put integrations to work

| Tool | Setup and everyday use |
| --- | --- |
| Mail | Connect a supported account in Account, then choose it in an Inbox ward. Gmail, Outlook, Zoho, and generic mail connections have different provider requirements. Use the actual host, port, TLS, and credentials required by your mail service. |
| Calendar | Connect Google, Outlook, or iCloud as appropriate, then select calendars in Agenda. A Notion database can also supply agenda items. |
| Notion | Authorize the pages/databases you intend to expose, then choose them in Notion wards. If an item is missing, check integration access before changing queries. |
| Messaging | Configure the service/account/channel for the messaging ward. Discord, Telegram, Slack, Twilio, Matrix, Teams, and push integrations depend on their own bot, token, or account setup. Review destination and Rime approval settings before enabling sends. |
| Browser | Install Chromium for the server or select a supported browser placement/provider. Profiles and logins stay on that browser's runtime. |
| Weather and routines | Configure location on the Weather ward and timing on the Routine ward. Server schedules use the process timezone. |

Service access, rate limits, and billing remain with each provider. An integration being listed in the catalog does not mean it is configured or available without a provider account.

## Monitor services

An administrator manages the registry at **`/admin/monitors`**, or with the CLI:

```sh
node bin/rimeward.mjs monitors add --label "Public site" --group "Web" --kind http --url https://example.com
node bin/rimeward.mjs monitors list
```

A Services ward can show a group, selected targets, or the registry. HTTP/TCP targets probe permitted network addresses. PM2, Docker, and systemd targets observe the machine/environment where the monitoring process runs. Inside Docker, that normally means the container; it does not automatically see host processes or other computers.

If needed, `PM2_BIN`, `DOCKER_BIN`, and `SYSTEMCTL_BIN` supply explicit executable paths. Do not expand host permissions simply to make a monitoring card work.

## Brand your instance

The admin settings and CLI control the site name, tagline, splash cards, footer, and brand assets. For example:

```sh
node bin/rimeward.mjs splash --name "My workspace" --tagline "A place to get things done"
node bin/rimeward.mjs brand install wordmark ./my-wordmark.svg
```

Use `node bin/rimeward.mjs --help` and each command's `--help` for supported options. Brand files live in application data; keep them with backups. Individual users can still personalize their own dashboard appearance.
