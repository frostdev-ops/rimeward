for (const host of document.querySelectorAll<HTMLElement>(
	"[data-integration]",
)) {
	const button = host.querySelector<HTMLButtonElement>("button")!,
		status = host.querySelector<HTMLElement>("[role=status]")!,
		link = host.querySelector<HTMLAnchorElement>("a")!;
	const key = `integration:${location.origin}:${host.dataset.integration}`;
	// A local grant is authorized in this very browser, so there is no code to
	// carry to a second device: the link goes straight to the provider.
	const note = (d: { local?: boolean; code?: string; destination?: string }) =>
		d.local
			? `Continue with ${(host.dataset.integration ?? "").replace(/^./, (c) => c.toUpperCase())} in your browser`
			: `Confirm code ${d.code} in your browser · ${d.destination}`;
	let id = sessionStorage.getItem(key) ?? "",
		timer: ReturnType<typeof setTimeout> | undefined;
	const access=host.querySelector<HTMLSelectElement>('[data-access]');
	if(access){const query=new URL(location.href).searchParams;access.value=query.has('readonly')?'readonly':query.has('teams')?'teams':'full';}
	async function call(action: string) {
		const response = await fetch("/api/account/integration", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action,
				id,
				provider: host.dataset.integration,
				options: {
					readonly: access?.value === "readonly",
					teams: access?.value === "teams",
				},
			}),
		});
		const data = await response.json();
		if (!response.ok) throw new Error(data.error);
		return data;
	}
	async function poll() {
		try {
			const data = await call("poll");
      if(data.verificationUrl){link.href=data.verificationUrl;link.hidden=false;status.textContent=note(data);}
			if (data.status === "connected") {
				status.textContent = "Connected";
				sessionStorage.removeItem(key);
				location.reload();
				return;
			}
			if (["failed", "expired", "cancelled"].includes(data.status))
				throw new Error(`Connection ${data.status}`);
			if (!document.hidden) timer = setTimeout(poll, 3000);
		} catch (e) {
			status.textContent = (e as Error).message;
			button.disabled = false;
		}
	}
	link.addEventListener('click',async event=>{if(!document.querySelector('meta[name="rimeward-local"]'))return;event.preventDefault();try{await call('open');}catch(error){status.textContent=(error as Error).message;}});
	button.onclick = async () => {
		button.disabled = true;
		try {
			const data = await call("start");
			id = data.id;
			sessionStorage.setItem(key, id);
			cancel.hidden = false;
			status.textContent = note(data);
			link.href = data.verificationUrl;
			link.hidden = false;
			void poll();
		} catch (e) {
			status.textContent = (e as Error).message;
			button.disabled = false;
		}
	};
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "btn";
	cancel.textContent = "Cancel";
	cancel.hidden = !id;
	host.append(cancel);
	cancel.onclick = async () => {
		clearTimeout(timer);
		try {
			await call("cancel");
			status.textContent = "Connection cancelled";
		} catch {
			status.textContent =
				"Could not reach the destination. Its authorization may still be pending.";
		} finally {
			sessionStorage.removeItem(key);
			id = "";
			cancel.hidden = true;
			link.hidden = true;
			button.disabled = false;
		}
	};
	document.addEventListener("visibilitychange", () => {
		clearTimeout(timer);
		if (!document.hidden && id) void poll();
	});
	if (
		!id &&
		new URL(location.href).searchParams.get("connect") ===
			host.dataset.integration
	) {
		button.click();
		const clean = new URL(location.href);
		for (const key of ["connect", "readonly", "teams"])
			clean.searchParams.delete(key);
		history.replaceState(null, "", clean);
	}
	if (id) {
		button.disabled = true;
		void poll();
	}
	window.addEventListener("pagehide", () => clearTimeout(timer));
}
