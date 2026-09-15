# Installation, accounts, and OAuth

## First installation

Configure process host/port, data directory, and `TOKEN_ENC_KEY` through your
installer or environment. Preserve the encryption key in protected backups.
An empty server writes a mode-0600 `setup-token` file in its data directory and
prints the same token to its log at boot (`[setup] Open <url>/setup and enter the
installation token: …`), because under Docker or pm2 the file is not somewhere the
installer can reach. Visit `/setup`, enter that token, and create your
administrator. Claiming is transactional and removes the token. The wizard then
walks the remaining steps in order: Address (public URL), Email (SMTP and a test
message), Access (registration policy), Sign-in (Google, Microsoft, Notion and
Zoho clients plus the SSO switches) and Ready (a summary with a reachability
check). Email and Sign-in can be skipped; the address is required. Any step can
be re-entered later from Admin → Settings → Re-run setup
(`/setup?step=url|email|policy|sso|review`); progress is derived from what is
saved, and finishing marks the installation done. Email comes before Access
because, while password sign-in is on, any policy other than invite-only needs a
successful email delivery check first. Existing installations skip setup.

Browser limits and everything else live under `/admin/settings`. Registration
defaults to invite-only. Approval-required accounts remain pending after email
verification; password recovery cannot approve them. Invitations/recovery expire
in one hour.

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

An identity may create or claim an account only when the provider vouches for
the email address: Google's `email_verified`, Microsoft's `xms_edov` optional claim
(add it to the app registration's token configuration for a multi-tenant
`common`/`organizations`/`consumers` registration; a single-tenant registration is
trusted for its own tenant), or a custom connector's "Trust email" switch.

Generic OIDC connectors require HTTPS. Discovery/token/JWKS requests use the
pinned public-address transport; private-network issuers are not currently
accepted. The maintained OIDC client validates signatures, issuer, audience,
expiry, nonce, state, and PKCE. Existing Google users get a one-time migration
path. No `google_sub` column ever existed — the old rule was an email match for
everyone — so the `legacy_google_users` table was seeded with every user present
at migration time. A Google sign-in whose email matches such a row claims it
once: the claim writes the identity, deletes the legacy row, and applies only to
`status='active'` accounts. New identities never claim an existing account just
by matching email: sign in first and link explicitly. Admins can approve/suspend
users, revoke sessions/devices, and unlink identities. Last-admin and last-login
guards apply. Keep password login until an administrator successfully tests
another method.

## Provider connections

Start ChatGPT connections under Account → Agent and other providers under Connected accounts. A paired
desktop manages both installations from **/desktop/providers**, which always belongs to that desktop:
one card for this desktop, one for the connected server, each showing and changing only its own
connection. Neither Disconnect unpairs the desktop, ends a Rimeward session, revokes a CLI login or
touches the other installation.

Each card is rendered against the identity it manages — this installation's id and sync profile, and
for the server the pairing and its profile as well — and every write carries that identity back. A form
left open across an unpair, a server switch or an account replacement is refused, not applied to
whichever connection is now current. Remote writes travel only over the pairing the desktop already
holds; no server address, user id or bearer token is ever taken from the page.

The destination choice for a new ChatGPT sign-in is rendered by the runtime that can offer it, so a
paired desktop whose server is unreachable can still start a local sign-in. A standalone desktop is
offered only the local scope. Each attempt is bound to its destination when it starts and cannot follow
a later server switch, and a local and a server attempt can be in progress at once without either
adopting the other's callback.

**Which connection serves a model call** is a separate question from which account a form changes, and
from where a conversation runs. Model access on the provider page is one of: *Automatic — connected
server preferred* (the legacy behaviour, and still the default), *This runtime only*, or *Connected
server only*. It is stored on the runtime that owns the run and is never synchronized: "this runtime"
would mean a different machine somewhere else. The route is resolved once when a turn is admitted and
held for that whole turn — its tool rounds, its compaction and any child it starts — so no round can
be billed to a different installation than the one the composer names. That includes the account: if
the connection behind it is replaced mid-turn, the next request stops with a message instead of
running on the replacement. A failure after the request was sent is reported; nothing is re-sent
anywhere else.

The preference decides where a NEW conversation goes. A conversation that has already run is pinned
to the backend it was admitted on, and that pin outranks the preference: a conversation admitted here
is never relayed, one admitted on a server is never served locally, and where the two disagree the
turn is refused rather than redirected. A conversation that never recorded which backend served it —
one last used before that was recorded — is refused on a runtime that has been connected to a server,
because unknown history is not evidence that it ran here; start a new chat on the endpoint instead.

Dashboard synchronization and model access are reported separately. A note, workspace or conversation
format the server cannot yet carry pauses that sync and says so; it does not move model calls to
another account.

Clip dictation records here and uploads from here, so it needs a key on this runtime. A key that lives
only on the connected server is reported as unavailable for dictation rather than advertised. A ChatGPT
login dictates through the live voice route instead, which does relay; a voice call keeps the
installation it started on for its heartbeat and stop.

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

A connection a browser starts in its own session on the server is already bound to
that session, so it goes straight to the provider's consent screen and returns to
the account page — no code to confirm. Only that case skips the code. A start a
paired desktop relays to the server is bound to the desktop's binding, not to any
browser here, so it keeps the confirmation hop like the standalone desktop does:
the browser that opens it may hold no session on this server, and signing in on the
broker page is what binds the callback. Broker approval shows a confirmation code
and account. Broker use does not pair the desktop or sync files. Only the
initiating runtime has the claim credential. Delivery is encrypted until
acknowledged; durable provider tokens remain at the destination. Broker refresh
uses a scoped grant and a short-lived encrypted rotation receipt for retrying
lost responses. Refreshes serialize per connection. Disconnect cancels pending
attempts and disables broker access. Provider-side revocation is best-effort
where supported. Notion supports rotating tokens and legacy tokens; Zoho
exchange/refresh/revocation validate regional endpoints.

`rimeward://oauth/complete` only raises the native window. It carries no credentials
and cannot authenticate or navigate to arbitrary destinations. Backend polling
remains authoritative.

Administrators add an account as an emailed invitation (default) or with a
generated password shown once; the role chosen on the form applies to both. The
invited person accepts from the emailed link by continuing with any enabled
sign-in provider or, while password sign-in is on, by setting a password.
There is no mode that creates a row with neither a password nor an identity,
because nothing could ever sign in to one. The users table shows each row's
usable methods.

## Validation and rollout

Run the focused tests and built UI smoke:

```
node --test tests/identity-redesign.test.ts tests/oauth-integration.test.ts tests/codex-loopback.test.ts
npm run build
node tests/auth-ui-smoke.mjs
```

The UI smoke uses disposable data, sends no email, and writes screenshots only
under a temporary directory. Existing UI/remote-workspace and staged desktop/
standalone checks remain required. Real provider consent, SMTP delivery, and
installed-app handoff on each OS require separate acceptance. Ship server/broker
support before desktops depend on it; preserve legacy callback registrations
during rollout. These changes do not deploy a broker or change live providers.

## Migration numbering

The identity and broker migrations shipped as `036_identity.sql` and
`037_oauth_broker.sql`, numbers already taken by `036_conversation_model.sql` and
`037_conversation_endpoint.sql`. They are now `041_identity.sql` and
`042_oauth_broker.sql`. The runner keys `applied_migrations` on the file name, so a
database that applied the old names must be renamed in place before it is opened
again:

```sql
UPDATE applied_migrations SET name='041_identity.sql' WHERE name='036_identity.sql';
UPDATE applied_migrations SET name='042_oauth_broker.sql' WHERE name='037_oauth_broker.sql';
CREATE INDEX IF NOT EXISTS login_identity_user ON login_identities(user_id);
```

Nothing was deployed with the old names.
