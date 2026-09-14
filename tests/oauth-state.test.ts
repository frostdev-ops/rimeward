import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mintState, takeConnectState, takeState } from '../src/lib/oauth.ts';
import { createSession } from '../src/lib/auth.ts';
import { createUser } from '../src/lib/users.ts';
import { setSetting } from '../src/lib/settings.ts';

test('mintState/takeState roundtrip is one-shot', () => {
  const state = mintState('google', 7);
  assert.match(state, /^[A-Za-z0-9_-]{20,50}$/);
  const pending = takeState(state);
  assert.ok(pending);
  assert.equal(pending.provider, 'google');
  assert.equal(pending.userId, 7);
  assert.equal(typeof pending.at, 'number');
  assert.equal(takeState(state), null, 'second take is null');
});

test('unknown state is null', () => {
  assert.equal(takeState('a'.repeat(32)), null);
});

test('malformed state string is rejected by the regex', () => {
  assert.equal(takeState('short'), null);
  assert.equal(takeState('has spaces and $ymbols!!!!!!'), null);
  assert.equal(takeState('x'.repeat(51)), null);
  assert.equal(takeState(''), null);
});

test('expired state is null', () => {
  const state = 'expired-state-' + 'x'.repeat(20);
  setSetting(
    `oauth_pending:${state}`,
    JSON.stringify({ provider: 'notion', userId: 1, at: Date.now() - 16 * 60 * 1000 })
  );
  assert.equal(takeState(state), null);
});

test('extra fields survive the roundtrip', () => {
  const state = mintState('microsoft', 3, { readonly: true });
  const pending = takeState(state);
  assert.equal(pending?.readonly, true);
});

test('two concurrent states do not clobber each other', () => {
  const a = mintState('google', 1);
  const b = mintState('notion', 2);
  assert.notEqual(a, b);
  const pb = takeState(b);
  const pa = takeState(a);
  assert.equal(pb?.provider, 'notion');
  assert.equal(pb?.userId, 2);
  assert.equal(pa?.provider, 'google');
  assert.equal(pa?.userId, 1);
});

// The connect callbacks are public: the state alone does not say which browser
// is finishing the flow, so the session cookie has to agree with it.
test('takeConnectState only accepts the session that started the flow', () => {
  const victim = createUser('victim@example.com', null);
  const attacker = createUser('attacker@example.com', null);
  const cookieFor = (id: string | undefined) => ({ get: () => (id ? { value: id } : undefined) });

  const mine = createSession(attacker).id;
  assert.equal(takeConnectState(mintState('google', attacker), cookieFor(mine))?.userId, attacker);

  // The attacker's connect URL, walked through by the victim's browser.
  const grafted = mintState('google', attacker);
  const theirs = createSession(victim).id;
  assert.equal(takeConnectState(grafted, cookieFor(theirs)), null, 'cross-session callback');

  assert.equal(takeConnectState(mintState('notion', attacker), cookieFor(undefined)), null, 'no session');
  // A sign-in state carries no userId: it is not a connect state whoever presents it.
  assert.equal(takeConnectState(mintState('google'), cookieFor(mine)), null, 'sso state is not a connect state');
});
