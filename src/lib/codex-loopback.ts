import http from "node:http";
/** The fixed registered callback port is shared with Codex; never steal it. */
let listener:
	| { id: string; server: http.Server; timer: NodeJS.Timeout }
	| undefined;
export function codexListenerActive(id: string) {
	return listener?.id === id;
}
export function closeCodexListener(id: string) {
	if (listener?.id === id) {
		clearTimeout(listener.timer);
		listener.server.close();
		listener = undefined;
	}
}
export async function listenForCodex(
	id: string,
	state: string,
	finish: (url: string) => Promise<void>,
) {
	if (listener) throw new Error("Another desktop sign-in is in progress");
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost:1455");
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("Content-Type", "text/html; charset=utf-8");
		if (
			req.method !== "GET" ||
			req.headers.host !== "localhost:1455" ||
			url.pathname !== "/auth/callback" ||
			url.searchParams.get("state") !== state
		) {
			res.writeHead(400);
			res.end("This sign-in request does not match.");
			return;
		}
		try {
			await finish(url.toString());
			res.end(
				`<title>Connected to ChatGPT</title><p>Connected to ChatGPT.</p><a href="rimeward://oauth/complete?id=${encodeURIComponent(id)}">Return to Rimeward</a>`,
			);
		} catch {
			res.writeHead(400);
			res.end("Sign-in could not finish. Return to Rimeward and try again.");
		} finally {
			closeCodexListener(id);
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(1455, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const timer = setTimeout(() => closeCodexListener(id), 900000);
	timer.unref();
	listener = { id, server, timer };
}
