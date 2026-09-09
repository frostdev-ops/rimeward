**Section 2 · Remote / web** · [Wiki home](https://github.com/frostdev-ops/rimeward/wiki/Home) · Next: [Connect services](https://github.com/frostdev-ops/rimeward/wiki/Remote-Integrations)

The web application is useful on its own: it hosts dashboards, integrations, browser wards, and server-side Rime work. Pairing a desktop adds access to that computer's projects and native tools. You do not need screen streaming just to use a remote editor or terminal.

If someone already operates a Rimeward server for you, obtain an account from them and go to [Pair and use a desktop](https://github.com/frostdev-ops/rimeward/wiki/Remote-Access). Only follow the hosting steps below when you are operating your own instance.

## What you take on

You need a server you control, persistent storage, and a domain with HTTPS for remote access. Choose either **Docker Compose** or **Node with a process manager**. Both need correct public URLs, a protected encryption key, backups, and streaming-aware proxy configuration.

Run the app as an unprivileged user. Keep the application port on loopback behind the reverse proxy. Do not expose the desktop's local runtime or enable desktop-only execution flags on the server. Native projects belong to paired desktop installations.

## 1. Get the source and configure the instance

```sh
git clone https://github.com/frostdev-ops/rimeward.git
cd rimeward
cp .env.example .env
openssl rand -base64 32
```

Save the generated value as `TOKEN_ENC_KEY` in `.env` and keep a protected copy with your backup material. Generate it once for the installation; replacing it makes previously sealed credentials unreadable. Do not commit `.env` or paste the key into an issue.

Set these values before starting:

```dotenv
PUBLIC_BASE_URL=https://rimeward.example.com
TOKEN_ENC_KEY=PASTE_YOUR_GENERATED_KEY_HERE
HOST=127.0.0.1
PORT=3005
```

Replace the domain with the actual address users will visit. `PUBLIC_BASE_URL` controls OAuth redirects, origin checks, and secure-cookie behavior. The placeholder above is not a usable key.

For a local web-only trial, use `PUBLIC_BASE_URL=http://localhost:3005` with the production server or Docker port. For `npm run dev:env`, use `http://localhost:4321`. A local web trial does not provide the desktop app's native tools.

## 2A. Run with Docker Compose

Install Docker Engine and Compose using the supported process for your server. From the repository:

First change `HOST=0.0.0.0` in `.env` for the container. The `env_file` entries override the image's defaults, so leaving the Node example's `HOST=127.0.0.1` would make the app unreachable through Docker's published port. Leave `HOMEPAGE_DATA_DIR` unset to use the image's `/data` volume path, or explicitly set it to `/data`.

```sh
docker compose up -d --build
docker compose exec app node bin/rimeward.mjs users create you@example.com --admin
docker compose exec app node bin/rimeward.mjs doctor
```

The create command prints the generated password once. Store it securely and use it for your first login. The doctor command reports missing configuration; optional integration credentials need not be supplied until you use them.

The supplied Compose file publishes `127.0.0.1:3005`, stores application data in a named volume at `/data`, includes Chromium's dependencies and seccomp profile, and gives the process a graceful shutdown period. `HOST=0.0.0.0` listens **inside the container** while the published host port remains loopback-only. Keep that distinction when customizing networking.

Choose the server's timezone in Compose's `TZ` environment setting before starting scheduled work; its default is UTC. Container process monitors only see what is available inside the container. Do not give it Docker socket access merely to populate a dashboard.

## 2B. Run directly with Node

Install Node **22.18 or newer**, npm, and the platform build prerequisites for native Node modules. Use the lockfile:

```sh
npm ci
npx playwright-core install --with-deps chromium
node bin/rimeward.mjs users create you@example.com --admin
node bin/rimeward.mjs doctor
npm run build
TZ=UTC node --env-file=.env server.mjs
```

Chromium's system-library installation may require administrative privileges on Linux. Install/download the browser for the same service user, or explicitly configure a browser path it can access. The app itself should run unprivileged. Chromium is optional if you will not use Browser wards; it is bundled in the Docker path.

The final command runs in the foreground. For continued operation, configure your process manager to run **`node --env-file=.env server.mjs`** from the checkout, set `TZ` in its process environment, restart on failure, and allow at least ten seconds for graceful shutdown. Keep the working directory and absolute data location stable between upgrades.

Use `HOMEPAGE_DATA_DIR` for persistent application storage outside a replaceable checkout; otherwise data defaults to `./data`. Create it with permissions for the service user. The app applies database migrations when it first opens the database.

Use **`server.mjs`**, not the generated Astro entry directly: it installs the WebSocket upgrade handling that devices and live dashboard streams require.

## 3. Put HTTPS and the proxy in front

Point your domain's DNS at the server and provision a valid TLS certificate. Adapt the [nginx example](https://github.com/frostdev-ops/rimeward/blob/main/ops/nginx.example.conf) with your domain and certificate paths. Install the [runtime relay snippet](https://github.com/frostdev-ops/rimeward/blob/main/ops/runtime-relay.nginx.conf) at its include location:

```sh
sudo install -m 644 ops/runtime-relay.nginx.conf /etc/nginx/snippets/rimeward-runtime-relay.conf
sudo nginx -t
```

Create the snippets directory first if your nginx installation does not have it. Enable the adapted virtual host using your distribution's nginx layout, then test again and reload only after the configuration passes.

The supplied files preserve WebSocket upgrades for device connections, shared live events, and the legacy browser tunnel. They also disable buffering for long-lived streams. Retain those routes rather than replacing them with a single generic proxy location.

For desktop relay and routed ward APIs, disable **request/response buffering, disk spill, caching, and payload logging** at every proxy layer. The app emits `Cache-Control: no-store`; a CDN override can defeat it. Apply equivalent exclusions to `/runtime/`, `/api/devices/connect`, `/api/devices/harness`, `/api/live/stream`, and routed development, browser, note, agent, instance, and remote-desktop APIs. The snippet is the exact route reference.

If using Cloudflare, adapt the [relay rule templates](https://github.com/frostdev-ops/rimeward/blob/main/ops/cloudflare-relay.json) within your existing rulesets. Preserve unrelated rules. Check Workers, analytics injection, payload capture, and cache overrides as well. See the [proxy contract](https://github.com/frostdev-ops/rimeward/blob/main/docs/development-workspaces.md#server-configuration-required-for-remote-access) for details.

## 4. Sign in and verify the web app

1. Open your public HTTPS address and sign in with the administrator account.
2. Create a page or a note, reload, and confirm it persists.
3. Check the public URL and timezone before connecting OAuth services or schedules.
4. Configure a provider under **Account → Agent** and test it when you are ready to use model credits.
5. Add only the service connections and wards you need.
6. If using remote access, pair a desktop and verify live updates, offline behavior, and revocation using [the access guide](https://github.com/frostdev-ops/rimeward/wiki/Remote-Access).

## Benefits and limits

A server gives you a dashboard reachable from browsers and a place for integrations and automations to stay running. Its cost is ongoing operation: updates, certificates, secrets, backups, and network configuration. Pairing does not upload your project folders or let native commands run on the ordinary server. The desktop must remain online for its files, processes, and screen to be reachable.
