# Installation, accounts, and OAuth

## First installation

Configure process host/port, data directory, and `TOKEN_ENC_KEY` through your
installer or environment. Preserve the encryption key in protected backups.
An empty server writes a mode-0600 `setup-token` file in its data directory.
Visit `/setup`, enter that token, and create your administrator. Claiming is
transactional and removes the token. Existing installations skip setup.

Continue to `/admin/settings` for public URL, registration, SMTP, SSO, OAuth
clients, and browser limits. Optional steps can be completed later. Registration
defaults to invite-only. Public password signup needs a successful email delivery
check. Approval-required accounts remain pending after email verification;
password recovery cannot approve them. Invitations/recovery expire in one hour.

Saved settings override environment fallbacks. “Use environment value” removes
the override. Secrets are encrypted and never rendered back into forms. Legacy
`secret:*` values migrate on read. Process binding, data-directory location,
encryption root, native credentials, worker identity, executable paths, and
restart commands remain outside web administration. Browser directory/session
limits require restart; saving does not restart the process.

Desktop local use needs no hosted account. `/desktop/settings` manages local
configuration even when paired; the normal account page belongs to the server.

## SSO

Login identities are separate from mail/calendar grants. Register these redirects:

```
{public-url}/api/auth/google/callback
{public-url}/api/auth/identity/microsoft/callback
{public-url}/api/auth/identity/{connector-id}/callback
```

Generic OIDC connectors require HTTPS. Discovery/token/JWKS requests use the
pinned public-address transport; private-network issuers are not currently
accepted. The maintained OIDC client validates signatures, issuer, audience,
expiry, nonce, state, and PKCE. Existing Google users get a one-time migration
path. New identities never claim an existing account just by matching email:
sign in first and link explicitly. Admins can approve/suspend users, revoke
sessions/devices, and unlink identities. Last-admin and last-login guards apply.
Keep password login until an administrator successfully tests another method.

## Provider connections

Start ChatGPT connections under Account → Agent and other providers under Connected accounts. Paired desktops default to the
connected server; ChatGPT also offers an explicit local destination. Each attempt
is bound to its destination and cannot follow a later server switch.

ChatGPT opens the system browser with a temporary callback listener at
`http://localhost:1455/auth/callback`. A busy port falls back to the labelled
manual flow without disturbing other software. Remote/headless users retain that
compatibility flow. Device-code login is not enabled: the CLI documentation does
not establish a supported third-party protocol. No Codex auth cache is accessed.

Integration callbacks retain `{public-url}/api/connect/{provider}/callback` for
Google, Microsoft, Notion, and Zoho. Servers can use their own clients or opt into
an external broker. Standalone desktops use the configured HTTPS broker (default
URL `https://frostdev.io`). That service must run this protocol and have registered
provider clients; configuring the URL does not deploy or register it.

Browser approval shows a confirmation code and account. Broker use does not pair
the desktop or sync files. Only the initiating runtime has the claim credential.
Delivery is encrypted until acknowledged; durable provider tokens remain at the
destination. Broker refresh uses a scoped grant and a short-lived encrypted
rotation receipt for retrying lost responses. Refreshes serialize per connection.
Disconnect cancels pending attempts and disables broker access. Provider-side
revocation is best-effort where supported. Notion supports rotating tokens and
legacy tokens; Zoho exchange/refresh/revocation validate regional endpoints.

`rimeward://oauth/complete` only raises the native window. It carries no credentials
and cannot authenticate or navigate to arbitrary destinations. Backend polling
remains authoritative.

## Validation and rollout

Run the focused tests and built UI smoke:

```
node --test tests/identity-redesign.test.ts tests/codex-loopback.test.ts
npm run build
node tests/auth-ui-smoke.mjs
```

The UI smoke uses disposable data, sends no email, and writes screenshots only
under a temporary directory. Existing UI/remote-workspace and staged desktop/
standalone checks remain required. Real provider consent, SMTP delivery, and
installed-app handoff on each OS require separate acceptance. Ship server/broker
support before desktops depend on it; preserve legacy callback registrations
during rollout. These changes do not deploy a broker or change live providers.
