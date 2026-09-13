import { getUser } from "../../../../lib/users.ts";
import { setSetting } from "../../../../lib/settings.ts";
import type { APIRoute } from "astro";
import { beginIdentity, finishIdentity } from "../../../../lib/identity.ts";
import {
	SESSION_COOKIES,
	getSession,
	sessionId,
	createSession,
	sessionCookieOptions,
	afterLogin,
	ssoStateCookieOptions,
} from "../../../../lib/auth.ts";
import { audit } from "../../../../lib/app-config.ts";
export const GET: APIRoute = async ({ params, url, cookies, redirect }) => {
	const [id, action] = String(params.action).split("/");
	if (!id || !/^[a-z][a-z0-9-]{1,39}$/.test(id))
		return new Response("Unknown connector", { status: 404 });
	try {
		if (!action) {
			const user = getSession(sessionId(cookies));
			if (url.searchParams.has("link") && !user)
				throw new Error("Sign in first");
			const attempt = await beginIdentity(
				id,
				url.searchParams.has("link") ? user?.userId : undefined,
			);
			cookies.set(
				`identity_${attempt.state}`,
				attempt.state,
				ssoStateCookieOptions(),
			);
			return redirect(attempt.url, 303);
		}
		if (action !== "callback")
			return new Response("Not found", { status: 404 });
		const state = url.searchParams.get("state") ?? "",
			name = `identity_${state}`;
		const cookie = cookies.get(name)?.value;
		cookies.delete(name, { path: "/" });
		const result = await finishIdentity(
			id,
			url,
			cookie,
			getSession(sessionId(cookies))?.userId,
		);
		const user=result.user;
		if(result.linked)return redirect("/account#accounts",303);
		if (!user) return redirect("/login?err=pending", 303);
		if (getUser(user)?.role === "admin")
			setSetting("identity_admin_verified", `${user}:${id}`);
		const session = createSession(user);
		for (const name of SESSION_COOKIES)
			cookies.set(name, session.id, sessionCookieOptions(session.expiresAt));
		return redirect(afterLogin(cookies), 303);
	} catch {
		audit(null, "identity.failed", id);
		return redirect("/login?err=sso", 303);
	}
};
