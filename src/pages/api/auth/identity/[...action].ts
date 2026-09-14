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
import { limitAccountAction, peekAction } from "../../../../lib/account-access.ts";
export const GET: APIRoute = async ({ params, url, cookies, redirect }) => {
	const [id, action] = String(params.action).split("/");
	if (!id || !/^[a-z][a-z0-9-]{1,39}$/.test(id))
		return new Response("Unknown connector", { status: 404 });
	try {
		if (!action) {
			const attempt = await beginIdentity(id);
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
		// The state echo this replaced. Nothing reads it any more; this is where a
		// browser still carrying one hands it back.
		cookies.delete("rimeward_sso", { path: "/" });
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
/** Binding an identity onto an account, and spending an invitation, are writes: a GET
 *  let any page start one for a signed-in visitor. Two layers pin them to this site:
 *  middleware.ts runs csrfBlocked() BEFORE the PUBLIC_PREFIXES allowlist, which compares
 *  the Origin of a form post (or of a post declaring no content type) against
 *  PUBLIC_BASE_URL, and the session cookie is SameSite=Lax, so a cross-site post carries
 *  no session at all. */
export const POST: APIRoute = async ({
	params,
	request,
	cookies,
	redirect,
}) => {
	const [id, action] = String(params.action).split("/");
	if (!id || !/^[a-z][a-z0-9-]{1,39}$/.test(id))
		return new Response("Unknown connector", { status: 404 });
	if (action !== "link" && action !== "invite")
		return new Response("Not found", { status: 404 });
	const user = action === "link" ? getSession(sessionId(cookies)) : undefined;
	if (action === "link" && !user)
		return new Response("Sign in first", { status: 401 });
	try {
		let token: string | undefined;
		if (action === "invite") {
			// Public and unauthenticated, and a start runs OIDC discovery: nothing happens
			// until the invitation is real. The retry window belongs to the invitation, not
			// to clientAddress — behind a reverse proxy that is one address for every
			// visitor, so a stranger could spend the whole window for everybody.
			token = String((await request.formData()).get("token") ?? "").trim();
			const invite = token ? peekAction(token) : null;
			if (invite?.purpose !== "invite")
				return new Response("Missing invitation", { status: 400 });
			limitAccountAction(`invite:${invite.user_id}`);
		}
		const attempt = await beginIdentity(id, user?.userId, token);
		cookies.set(
			`identity_${attempt.state}`,
			attempt.state,
			ssoStateCookieOptions(),
		);
		return redirect(attempt.url, 303);
	} catch {
		audit(null, "identity.failed", id);
		return redirect("/login?err=sso", 303);
	}
};
