import type { APIRoute } from "astro";
import {
	beginBroker,
	pollBroker,
	acknowledgeBroker,
	cancelBroker,
	refreshBroker,
} from "../../../lib/oauth-broker.ts";
import { limitAccountAction } from "../../../lib/account-access.ts";
export const POST: APIRoute = async ({ request, clientAddress }) => {
	if (request.headers.has("origin"))
		return new Response("Native broker client required", { status: 403 });
	try {
		const text = await request.text();
		if (text.length > 32768) throw new Error("Request too large");
		const b = JSON.parse(text);
		let result: unknown;
		if (b.action === "start") {
			limitAccountAction(`broker:${clientAddress}`);
			result = beginBroker(b.provider, undefined, b.options);
		} else if (b.action === "poll")
			result = pollBroker(String(b.id), String(b.key));
		else if (b.action === "ack") {
			acknowledgeBroker(String(b.id), String(b.key));
			result = { ok: true };
		} else if (b.action === "cancel") {
			cancelBroker(String(b.id), String(b.key));
			result = { ok: true };
		} else if (b.action === "refresh")
			result = await refreshBroker(
				String(b.id),
				String(b.key),
				String(b.token),
				b.meta,
			);
		else throw new Error("Unknown broker operation");
		return Response.json(result, { headers: { "cache-control": "no-store" } });
	} catch {
		return Response.json(
			{
				error: "Broker request failed. Check your connection and start again.",
			},
			{ status: 400, headers: { "cache-control": "no-store" } },
		);
	}
};
