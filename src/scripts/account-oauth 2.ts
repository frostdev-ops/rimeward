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
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error);
		return data;
	}
	/** What this runtime can offer right now, resolved at the moment of use and never remembered. */
	async function destination(): Promise<Destination> {
		const r = await fetch('/api/account/oauth?capabilities=1');
		const data = await r.json();
		if (!r.ok) throw new Error(data.error ?? 'Sign-in is unavailable here.');
		const list: Destination[] = Array.isArray(data.destinations) ? data.destinations : [];
		const choice = wanted();
		const server = list.find((d) => d.kind === 'server');
		const here = list.find((d) => d.kind === 'local') ?? { kind: 'local' as const, binding: '', available: true };
		if (choice === 'local') return here;
		// A card that NAMES the connected server, or that offers one as its default, must not quietly
		// sign in here instead when that server cannot be reached: it says so. `default` resolves to
		// this runtime only where there is no other installation it could have meant — a plain server
		// or a standalone desktop.
		if (choice === 'server' && !server)
			throw new Error('No connected server is designated, so there is nowhere to sign this account in. Nothing was started on this computer.');
		if (server && !server.available)
			throw new Error('The connected server has not been reached yet, so a sign-in cannot be started on it. Choose "This desktop only" to sign in here instead.');
		return server ?? here;
	}
	function forget() {
		if (bound) try { sessionStorage.removeItem(slot(bound)); } catch { /* private window */ }
		id = '';
	}
	function end(message: string) {
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
		if (!id) return;
		try {
			const r = await fetch(`/api/account/oauth?id=${encodeURIComponent(id)}`);
			const data = await r.json();
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
			status.textContent = (e as Error).message;
		}
		if (id && !document.hidden) timer = setTimeout(poll, 3000);
	}
	start.onclick = async () => {
		start.disabled = true;
		status.textContent = 'Starting sign-in…';
		try {
			const target = await destination();
			const data = await request({
				action: 'start',
				destination: target.kind,
				...(target.binding ? { binding: target.binding } : {}),
			});
			id = data.id;
			bound = target.binding;
			if (bound) try { sessionStorage.setItem(slot(bound), id); } catch { /* private window */ }
			cancel.hidden = false;
			link.href = data.url;
			link.hidden = false;
			manual.hidden = data.automatic;
			await poll();
		} catch (e) {
			end((e as Error).message);
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
		try {
			await request({ action: 'cancel', id });
			end('Sign-in cancelled.');
		} catch (e) {
			status.textContent = (e as Error).message;
		}
	};
	manual.onsubmit = async (e) => {
		e.preventDefault();
		try {
			await request({
				action: 'finish',
				id,
				pasted: new FormData(manual).get('pasted'),
			});
			await poll();
		} catch (e) {
			status.textContent = (e as Error).message;
		}
	};
	document.addEventListener('visibilitychange', () => {
		clearTimeout(timer);
		if (!document.hidden && id) void poll();
	});

	/** After a reload or a restart: this card's own attempt, if one is still live. Its own — the
	 *  enumeration is asked of the destination this card manages, so a server-owned attempt is
	 *  recovered from the server and never confused with a local one. */
	(async () => {
		try {
			const target = await destination().catch(() => null);
			if (!target?.binding) return;
			bound = target.binding;
			let saved = '';
			try { saved = sessionStorage.getItem(slot(bound)) ?? ''; } catch { /* private window */ }
			if (!saved) {
				const query = target.kind === 'server' ? '?attempts=1&target=server' : '?attempts=1';
				const r = await fetch(`/api/account/oauth${query}`);
				if (!r.ok) return;
				const data = await r.json();
				const mine = (data.attempts ?? []).find((a: { remote?: boolean }) => !!a.remote === (target.kind === 'server'));
				if (!mine) return;
				saved = mine.id;
				try { sessionStorage.setItem(slot(bound), saved); } catch { /* private window */ }
			}
			id = saved;
			start.disabled = true;
			cancel.hidden = false;
			void poll();
		} catch { /* a card with nothing to recover simply stays idle */ }
	})();
}

for (const host of document.querySelectorAll<HTMLElement>('[data-codex-connect]'))
	if (!host.dataset.wired) {
		host.dataset.wired = '1';
		wireCodexConnect(host);
	}
