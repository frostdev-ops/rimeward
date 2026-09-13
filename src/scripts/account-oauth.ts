const host = document.querySelector<HTMLElement>("[data-codex-connect]");
if (host) {
	if (document.querySelector('meta[name="rimeward-local"]'))
		host.querySelector<HTMLElement>("[data-local-settings]")!.hidden = false;
	if (document.querySelector('meta[name="rimeward-local"]'))
		host.querySelector<HTMLElement>("[data-destination]")!.hidden = false;
	const status = host.querySelector<HTMLElement>('[role="status"]')!;
	const start = host.querySelector<HTMLButtonElement>("[data-start]")!;
	const cancel = host.querySelector<HTMLButtonElement>("[data-cancel]")!;
	const link = host.querySelector<HTMLAnchorElement>("[data-open]")!;
	const manual = host.querySelector<HTMLFormElement>("[data-manual]")!;
	const key = `oauth:${location.origin}`,
		saved = sessionStorage.getItem(key);
	let id = saved ?? "",
		timer: ReturnType<typeof setTimeout> | undefined;
	async function request(body: Record<string, unknown>) {
		const r = await fetch("/api/account/oauth", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error);
		return data;
	}
	function end(message: string) {
		status.textContent = message;
		clearTimeout(timer);
		sessionStorage.removeItem(key);
		id = "";
		start.disabled = false;
		cancel.hidden = true;
		link.hidden = true;
		manual.hidden = true;
	}
	async function poll() {
		if (!id) return;
		try {
			const r = await fetch(`/api/account/oauth?id=${encodeURIComponent(id)}`);
			const data = await r.json();
			if (!r.ok) {
				end(data.error ?? "Sign-in is unavailable. Start again.");
				return;
			}
			if (data.url) {
				link.href = data.url;
				link.hidden = false;
				manual.hidden = !!data.automatic;
			}
			if (data.status === "connected") {
				end("Connected.");
				location.reload();
				return;
			}
			if (["failed", "cancelled", "expired"].includes(data.status)) {
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
		status.textContent = "Starting sign-in…";
		try {
			const data = await request({
				action: "start",
				destination:
					host.querySelector<HTMLSelectElement>("[data-target]")?.value,
			});
			id = data.id;
			sessionStorage.setItem(key, id);
			cancel.hidden = false;
			link.href = data.url;
			link.hidden = false;
			manual.hidden = data.automatic;
			await poll();
		} catch (e) {
			end((e as Error).message);
		}
	};
	link.addEventListener("click", async (e) => {
		if (!document.querySelector('meta[name="rimeward-local"]')) return;
		e.preventDefault();
		try {
			await request({ action: "open", id });
		} catch {
			status.textContent =
				"Could not open the browser. Copy the sign-in link and open it in your browser.";
		}
	});
	cancel.onclick = async () => {
		try {
			await request({ action: "cancel", id });
			end("Sign-in cancelled.");
		} catch (e) {
			status.textContent = (e as Error).message;
		}
	};
	manual.onsubmit = async (e) => {
		e.preventDefault();
		try {
			await request({
				action: "finish",
				id,
				pasted: new FormData(manual).get("pasted"),
			});
			await poll();
		} catch (e) {
			status.textContent = (e as Error).message;
		}
	};
	document.addEventListener("visibilitychange", () => {
		clearTimeout(timer);
		if (!document.hidden && id) void poll();
	});
	if (id) {
		start.disabled = true;
		cancel.hidden = false;
		void poll();
	}
}
