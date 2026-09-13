import type { APIRoute } from "astro";
import {
	startIntegration,
	pollIntegration,
	cancelIntegration,
 integrationURL,
} from "../../../lib/broker-client.ts";
import { sessionId } from "../../../lib/auth.ts";
import { isDesktop } from "../../../lib/dev/runtime.ts";
import {
	nativeDesktop,
	rimeConnection,
	instanceRequest,
} from "../../../lib/dev/remote.ts";
import { getSetting, setSetting } from "../../../lib/settings.ts";
export const POST: APIRoute = async ({ request, locals, cookies }) => {
	if (
		isDesktop() &&
		(request.headers.has("x-rimeward-native-token") ||
			request.headers.get("x-rimeward-relayed") === "1")
	)
		return new Response("Open sign-in on this desktop directly", {
			status: 403,
		});
	try {
		const session =
			request.headers.get("x-rimeward-oauth-binding") ?? sessionId(cookies);
		if (!session) throw new Error("Sign in first");
		const b = await request.json(),
			user = locals.user!.userId;
		const connection = isDesktop() ? await rimeConnection(user) : undefined;
		const binding = getSetting(`integration_remote:${user}:${b.id}`);
		let result;
		if (
			binding ||
			(connection && b.action === "start" && b.destination !== "local")
		) {
			if (!connection || (binding && binding !== connection.id))
				throw new Error("Reconnect the original destination server");
			const response = await instanceRequest(
				user,
				"/api/account/integration",
				new Request("https://rimeward.invalid/api/account/integration", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(b),
				}),
			);
			result = await response.json();
			if (!response.ok)
				throw new Error(result.error ?? "Update the destination server");
			if (b.action === "start")
				setSetting(`integration_remote:${user}:${result.id}`, connection.id);
		} else if (b.action === "start")
			result = await startIntegration(user, b.provider, session, b.options);
		else if (b.action === "poll")
			result = await pollIntegration(user, String(b.id), session);
		else if (b.action === "cancel") {
			await cancelIntegration(user, String(b.id), session);
			result = { status: "cancelled" };
		} else throw new Error("Unknown operation");
		if ((b.action === "start" || b.action === "open") && isDesktop())
			try {
				await nativeDesktop("open-url", { url: result.verificationUrl });
			} catch {}
		return Response.json(result, { headers: { "cache-control": "no-store" } });
	} catch (e) {
		return Response.json(
			{ error: (e as Error).message },
			{ status: 400, headers: { "cache-control": "no-store" } },
		);
	}
};
