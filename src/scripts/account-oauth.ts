// The ChatGPT sign-in card, once per DESTINATION.
//
// Each `[data-codex-connect]` block names the connection it manages. Before a sign-in starts the card
// asks this runtime which destinations it can offer and what each one's binding is, and sends that
// binding with the start: a page left open across a server switch, an unpair or a re-designation is
// then refused rather than quietly signing an account in somewhere else. Pending state is kept per
// destination binding, so a local and a server sign-in can both be in progress without either
// adopting the other's callback, and a reload recovers the card's OWN attempt — including a
// server-owned one, which local enumeration would never see.

interface Destination {
	kind: 'local' | 'server';
	binding: string;
	host?: string;
	available: boolean;
}

export function wireCodexConnect(host: HTMLElement) {
const controller = new AbortController();
let disposed = false, generation = 0;
const alive = () => !disposed && host.isConnected;
	const scope = host.dataset.scope || 'account';
	const status = host.querySelector<HTMLElement>('[role="status"]')!;
	const start = host.querySelector<HTMLButtonElement>('[data-start]')!;
	const cancel = host.querySelector<HTMLButtonElement>('[data-cancel]')!;
	const link = host.querySelector<HTMLAnchorElement>('[data-open]')!;
	const manual = host.querySelector<HTMLFormElement>('[data-manual]')!;
	const picker = host.querySelector<HTMLSelectElement>('[data-target]');
	// A desktop can open the system browser for the user; a plain browser cannot.
	const nativeOpen =
		host.dataset.native === '1' ||
		!!document.querySelector('meta[name="rimeward-local"]');
if (scope === 'account' && nativeOpen && host.dataset.native !== '1') {
  start.disabled = true;
  status.textContent = 'Use Provider connections on this desktop to choose the installation to change.';
  const settings = host.querySelector<HTMLElement>('[data-local-settings]');
  if (settings) settings.hidden = false;
  return () => { disposed = true; controller.abort(); };
}
	// Server-proxied HTML is rendered by the server, which cannot know it is inside a desktop window:
	// there the marker is the only signal, so the desktop-only controls are revealed here too.
	if (nativeOpen)
		for (const sel of ['[data-local-settings]', '[data-destination]']) {
			const el = host.querySelector<HTMLElement>(sel);
			if (el) el.hidden = false;
		}
	/** What this card would start: an explicit installation, or `default` — "whatever this card
	 *  offers", which is the connected server where there is one and this runtime where there is not. */
	const wanted = (): 'local' | 'server' | 'default' => {
		const value = host.dataset.destination || picker?.value || 'default';
		return value === 'local' || value === 'server' ? value : 'default';
	};
	let id = '',
		bound = '',
		timer: ReturnType<typeof setTimeout> | undefined;
	const slot = (binding: string) => `oauth:${location.origin}:${scope}:${binding}`;

	async function request(body: Record<string, unknown>) {
		const r = await fetch('/api/account/oauth', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
signal: controller.signal,
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error);
		return data;
	}
	/** What this runtime can offer right now, resolved at the moment of use and never remembered. */
	async function destination(): Promise<Destination> {
const kind = wanted(), binding = host.dataset.oauthBinding;
if ((kind !== 'local' && kind !== 'server') || !binding)
  throw new Error('Reload this provider card before starting sign-in.');
return { kind, binding, available: true };
	}
	function forget() {
if (bound) try { if (sessionStorage.getItem(slot(bound)) === id) sessionStorage.removeItem(slot(bound)); } catch { /* private window */ }
		id = '';
	}
	function end(message: string) {
if (!alive()) return;
generation++;
		status.textContent = message;
		clearTimeout(timer);
		forget();
		start.disabled = false;
		cancel.hidden = true;
		link.hidden = true;
		manual.hidden = true;
	}
	/** Success returns to the card that started it. A page with a refresh hook re-renders in place.
	 *  The legacy account page is its own scope and reloads — EXCEPT when that page is the connected
	 *  server's own HTML and the sign-in was local: reloading there would re-render the server's
	 *  account, which cannot show the connection just made on this desktop. */
	function connected(kind: 'local' | 'server') {
		end('Connected.');
		const refresh = (window as unknown as { __rimeProviderRefresh?: () => void }).__rimeProviderRefresh;
		if (refresh) { refresh(); return; }
		const proxied = !!document.querySelector('meta[name="rimeward-local"]');
		if (kind === 'local' && proxied) location.href = '/desktop/providers';
		else location.reload();
	}
	async function poll() {
if (!id || !alive()) return;
const attempt = id, current = generation;
		try {
const r = await fetch(`/api/account/oauth?id=${encodeURIComponent(attempt)}`, { signal: controller.signal });
			const data = await r.json();
if (!alive() || generation !== current || id !== attempt) return;
			if (!r.ok) {
				end(data.error ?? 'Sign-in is unavailable. Start again.');
				return;
			}
			if (data.url) {
				link.href = data.url;
				link.hidden = false;
				manual.hidden = !!data.automatic;
			}
			if (data.status === 'connected') {
				connected(bound.startsWith('server:') ? 'server' : 'local');
				return;
			}
			if (['failed', 'cancelled', 'expired'].includes(data.status)) {
				end(data.error || `Sign-in ${data.status}.`);
				return;
			}
			status.textContent = `Complete sign-in in your browser · ${data.destination}`;
		} catch (e) {
if (!alive() || generation !== current || id !== attempt) return;
			status.textContent = (e as Error).message;
		}
if (alive() && id === attempt && generation === current && !document.hidden) timer = setTimeout(poll, 3000);
	}
	start.onclick = async () => {
if (!alive() || start.disabled) return;
const current = ++generation;
		start.disabled = true;
		status.textContent = 'Starting sign-in…';
		try {
			const target = await destination();
			const data = await request({
				action: 'start',
				destination: target.kind,
				...(target.binding ? { binding: target.binding } : {}),
			});
if (!alive() || generation !== current) return;
			id = data.id;
			bound = target.binding;
			if (bound) try { sessionStorage.setItem(slot(bound), id); } catch { /* private window */ }
			cancel.hidden = false;
			link.href = data.url;
			link.hidden = false;
			manual.hidden = data.automatic;
			await poll();
		} catch (e) {
if (alive() && generation === current) end((e as Error).message);
		}
	};
	link.addEventListener('click', async (e) => {
		if (!nativeOpen) return;
		e.preventDefault();
		try {
			await request({ action: 'open', id });
		} catch {
			status.textContent =
				'Could not open the browser. Copy the sign-in link and open it in your browser.';
		}
	});
	cancel.onclick = async () => {
if (!alive() || !id) return;
const attempt = id, current = ++generation;
clearTimeout(timer);
		try {
await request({ action: 'cancel', id: attempt });
if (!alive() || current !== generation || attempt !== id) return;
			end('Sign-in cancelled.');
		} catch (e) {
if (!alive() || current !== generation || attempt !== id) return;
			status.textContent = (e as Error).message;
		}
	};
	manual.onsubmit = async (e) => {
		e.preventDefault();
if (!alive() || !id) return;
const attempt = id, current = generation;
		try {
			await request({
				action: 'finish',
id: attempt,
				pasted: new FormData(manual).get('pasted'),
			});
if (!alive() || current !== generation || attempt !== id) return;
			await poll();
		} catch (e) {
if (!alive() || current !== generation || attempt !== id) return;
			status.textContent = (e as Error).message;
		}
	};
const visible = () => {
		clearTimeout(timer);
if (alive() && !document.hidden && id) void poll();
};
document.addEventListener('visibilitychange', visible);

	/** After a reload or a restart: this card's own attempt, if one is still live. Its own — the
	 *  enumeration is asked of the destination this card manages, so a server-owned attempt is
	 *  recovered from the server and never confused with a local one. */
start.disabled = true;
const recovery = generation;
(async () => {
		try {
			const target = await destination().catch(() => null);
if (!alive() || generation !== recovery || !target?.binding) return;
			bound = target.binding;
			let saved = '';
			try { saved = sessionStorage.getItem(slot(bound)) ?? ''; } catch { /* private window */ }
			if (!saved) {
const query = `?attempts=1&binding=${encodeURIComponent(bound)}${target.kind === 'server' ? '&target=server' : ''}`;
const r = await fetch(`/api/account/oauth${query}`, { signal: controller.signal });
				if (!r.ok) return;
				const data = await r.json();
if (!alive() || generation !== recovery) return;
				const mine = (data.attempts ?? []).find((a: { remote?: boolean }) => !!a.remote === (target.kind === 'server'));
				if (!mine) return;
				saved = mine.id;
				try { sessionStorage.setItem(slot(bound), saved); } catch { /* private window */ }
			}
if (!alive() || generation !== recovery) return;
id = saved;
			start.disabled = true;
			cancel.hidden = false;
			void poll();
		} catch { /* a card with nothing to recover simply stays idle */ }
finally { if (alive() && generation === recovery && !id) start.disabled = false; }
	})();
return () => {
  disposed = true; generation++; controller.abort(); clearTimeout(timer);
  document.removeEventListener('visibilitychange', visible);
  start.onclick = null; cancel.onclick = null; manual.onsubmit = null;
};
}

for (const host of document.querySelectorAll<HTMLElement>('[data-codex-connect]'))
	if (!host.dataset.wired) {
		host.dataset.wired = '1';
		wireCodexConnect(host);
	}
