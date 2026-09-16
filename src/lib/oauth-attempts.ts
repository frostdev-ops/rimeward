import crypto from "node:crypto";
import { getDb } from "./db.ts";
import { sessionId } from "./auth.ts";
import { sealToken, openToken } from "./crypto.ts";
import { sweepSettings } from "./settings.ts";
let cleanup: ReturnType<typeof setInterval> | undefined;
export function ensureAuthCleanup() {
	if (cleanup) return;
	const expire = () => {
		const now = Date.now();
		getDb()
			.prepare(
				"UPDATE oauth_attempts SET status='expired',private_enc='' WHERE expires_at<=? AND status IN ('pending','authorizing','completing')",
			)
			.run(now);
		getDb()
			.prepare(
				"UPDATE oauth_broker_grants SET delivery_enc='',previous_refresh_hash='' WHERE expires_at<=?",
			)
			.run(now);
		getDb().prepare("DELETE FROM account_actions WHERE expires_at<=?").run(now);
		for (const prefix of [
			"identity_pending:",
			"oauth_open:",
			"oauth_remote:",
			"integration_remote:",
		])
			sweepSettings(prefix, 900000);
	};
	expire();
	cleanup = setInterval(expire, 60000);
	cleanup.unref();
}
export type AttemptStatus =
	| "pending"
	| "authorizing"
	| "completing"
	| "connected"
	| "cancelled"
	| "expired"
	| "failed";
export interface Attempt {
	id: string;
	user_id: number;
	provider: string;
	destination: string;
	session_hash: string;
	status: AttemptStatus;
	expires_at: number;
	private_enc: string;
	error: string;
	created_at: number;
}
const digest = (s: string) =>
	crypto.createHash("sha256").update(s).digest("hex");
export function startAttempt(
	user: number,
	provider: string,
	destination: string,
	session: string,
	data: unknown,
): Attempt {
	const id = crypto.randomBytes(24).toString("base64url"),
		now = Date.now();
	getDb()
		.prepare("DELETE FROM oauth_attempts WHERE expires_at<?")
		.run(now - 86400000);
	getDb()
		.prepare(
			"INSERT INTO oauth_attempts(id,user_id,provider,destination,session_hash,expires_at,private_enc,created_at) VALUES(?,?,?,?,?,?,?,?)",
		)
		.run(
			id,
			user,
			provider,
			destination,
			digest(session),
			now + 900000,
			sealToken(JSON.stringify(data)),
			now,
		);
	return attemptOf(user, id);
}
export function attemptOf(user: number, id: string, session?: string): Attempt {
	const row = getDb()
		.prepare("SELECT * FROM oauth_attempts WHERE id=? AND user_id=?")
		.get(id, user) as Attempt | undefined;
	if (!row || (session !== undefined && row.session_hash !== digest(session)))
		throw new Error("Sign-in attempt is unavailable");
	if (
		row.expires_at <= Date.now() &&
		["pending", "authorizing", "completing"].includes(row.status)
	) {
		getDb()
			.prepare(
				"UPDATE oauth_attempts SET status='expired',private_enc='' WHERE id=?",
			)
			.run(id);
		row.status = "expired";
		row.private_enc = "";
	}
	return row;
}
/** The binding an attempt is pinned to. Only the desktop relay may name its own —
 *  it reaches us on a session minted by /api/devices/session, which a browser never holds. */
export function attemptSession(
    request: Request,
    cookies: { get(name: string): { value: string } | undefined },
): string | undefined {
    const own = sessionId(cookies),
        named = request.headers.get("x-rimeward-oauth-binding");
    if (
        named &&
        own &&
        getDb().prepare("SELECT 1 FROM device_sessions WHERE session_id=?").get(own)
    )
        return named;
    return own;
}
export function attemptData<T>(row: Attempt): T {
	return JSON.parse(openToken(row.private_enc)) as T;
}
export function attemptView(row: Attempt) {
	return {
		id: row.id,
		provider: row.provider,
		destination: row.destination,
		status: row.status,
		expiresAt: row.expires_at,
		error: row.error,
	};
}
export function cancelAttempt(user: number, id: string, session?: string) {
	attemptOf(user, id, session);
	getDb()
		.prepare(
			"UPDATE oauth_attempts SET status='cancelled',private_enc='' WHERE id=? AND status IN ('pending','authorizing','completing')",
		)
		.run(id);
}
export function claimAttempt(user: number, id: string): Attempt {
	const row = attemptOf(user, id);
	const changed = getDb()
		.prepare(
			"UPDATE oauth_attempts SET status='completing' WHERE id=? AND status IN ('pending','authorizing') AND expires_at>?",
		)
		.run(id, Date.now());
	if (!changed.changes)
		throw new Error("Sign-in has already finished or expired");
	return row;
}
export function completeAttempt(user: number, id: string, write: () => void) {
	getDb().transaction(() => {
		if(!getDb().prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(user))throw new Error('Account is no longer active');
		const row = attemptOf(user, id);
		if (row.status !== "completing")
			throw new Error("Sign-in was cancelled or expired");
		const newer = getDb()
			.prepare(
				"SELECT 1 FROM oauth_attempts WHERE user_id=? AND provider=? AND status='connected' AND rowid>(SELECT rowid FROM oauth_attempts WHERE id=?)",
			)
			.get(user, row.provider, id);
		if (newer) throw new Error("A newer connection is already active");
		write();
		getDb()
			.prepare(
				"UPDATE oauth_attempts SET status='connected',private_enc='' WHERE id=?",
			)
			.run(id);
	})();
}
export function failAttempt(user: number, id: string) {
	attemptOf(user, id);
	getDb()
		.prepare(
			"UPDATE oauth_attempts SET status='failed',private_enc='',error='Sign-in failed. Please start again.' WHERE id=? AND status='completing'",
		)
		.run(id);
}
