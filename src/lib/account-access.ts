import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { config, publicOrigin, audit } from "./app-config.ts";
import { getDb } from "./db.ts";
import { getSetting, setSetting } from "./settings.ts";
import {
	createUser,
	getUserByEmail,
	getUser,
	setUserPassword,
} from "./users.ts";

const digest = (value: string) =>
	crypto.createHash("sha256").update(value).digest("hex");
export function accountEmail(value: string) {
	const email = value.trim().toLowerCase();
	if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
		throw new Error("Enter a valid email");
	return email;
}
export function accountPassword(value: string) {
	if (value.length < 12 || value.length > 1024)
		throw new Error("Use a password between 12 and 1024 characters");
	return value;
}
function mailer() {
	if (!config("SMTP_HOST") || !config("SMTP_FROM"))
		throw new Error("Email delivery is not configured");
	return nodemailer.createTransport({
		host: config("SMTP_HOST"),
		port: +config("SMTP_PORT"),
		secure: config("SMTP_SECURE") === "true",
		requireTLS: config("SMTP_SECURE") !== "true",
		auth: config("SMTP_USER")
			? { user: config("SMTP_USER"), pass: config("SMTP_PASSWORD") }
			: undefined,
		connectionTimeout: 15000,
		greetingTimeout: 15000,
		socketTimeout: 30000,
	});
}
export async function verifyMail(to: string) {
	const transport = mailer();
	try {
		await transport.sendMail({
			from: config("SMTP_FROM"),
			to: accountEmail(to),
			subject: "Rimeward email delivery check",
			text: "Rimeward can send account emails through this configuration.",
		});
		setSetting("smtp_verified", new Date().toISOString());
	} finally {
		transport.close();
	}
}
export function actionToken(
	user: number,
	purpose: "verify" | "reset" | "invite",
) {
	const token = crypto.randomBytes(32).toString("base64url");
	getDb()
		.prepare("DELETE FROM account_actions WHERE expires_at<=?")
		.run(Date.now());
	getDb()
		.prepare(
			"INSERT INTO account_actions(digest,user_id,purpose,expires_at) VALUES(?,?,?,?)",
		)
		.run(digest(token), user, purpose, Date.now() + 3600000);
	return token;
}
async function sendAction(
	user: number,
	purpose: "verify" | "reset" | "invite",
) {
	const token = actionToken(user, purpose),
		transport = mailer();
	try {
		await transport.sendMail({
			from: config("SMTP_FROM"),
			to: getUser(user)!.email,
			subject: "Your Rimeward account",
			text: `Continue with your Rimeward account: ${publicOrigin()}/recover?token=${token}\nThis link expires in one hour. If you did not request it, ignore this email.`,
		});
	} catch {
		getDb()
			.prepare("DELETE FROM account_actions WHERE digest=?")
			.run(digest(token));
		throw new Error("Could not deliver the account email");
	} finally {
		transport.close();
	}
}
export async function registerAccount(email: string, password: string) {
	email = accountEmail(email);
	accountPassword(password);
	if (
		config("REGISTRATION_POLICY") === "invite" ||
		config("PASSWORD_LOGIN") !== "true" ||
		!getSetting("smtp_verified")
	)
		throw new Error("Public password registration is unavailable");
	const id = getDb().transaction(() => {
		if (getUserByEmail(email)) return null;
		const id = createUser(email, password);
		getDb().prepare("UPDATE users SET status='pending' WHERE id=?").run(id);
		return id;
	})();
	if (id) await sendAction(id, "verify");
}
export async function recoverAccount(email: string) {
	const user = getUserByEmail(accountEmail(email));
	if (user && user.status !== "suspended")
		await sendAction(
			user.id,
			user.status === "active" || user.email_verified ? "reset" : "verify",
		);
}
export async function inviteAccount(email: string, actor: number) {
	email = accountEmail(email);
	if (getUserByEmail(email)) throw new Error("Account already exists");
	const id = createUser(email, null);
	getDb().prepare("UPDATE users SET status='pending' WHERE id=?").run(id);
	await sendAction(id, "invite");
	audit(actor, "user.invited", String(id));
}
export function redeemAction(token: string, password: string) {
	accountPassword(password);
	return getDb().transaction(() => {
		const action = getDb()
			.prepare("SELECT * FROM account_actions WHERE digest=? AND expires_at>?")
			.get(digest(token), Date.now()) as
			| { user_id: number; purpose: string }
			| undefined;
		if (!action || getUser(action.user_id)?.status === "suspended")
			throw new Error("This link is invalid or expired");
		getDb()
			.prepare("DELETE FROM account_actions WHERE user_id=?")
			.run(action.user_id);
		setUserPassword(action.user_id, password);
		const status =
			action.purpose === "reset"
				? getUser(action.user_id)!.status
				: action.purpose === "verify" &&
						config("REGISTRATION_POLICY") !== "open"
					? "pending"
					: "active";
		getDb()
			.prepare("UPDATE users SET email_verified=1,status=? WHERE id=?")
			.run(status, action.user_id);
		audit(action.user_id, "account.recovered");
		return status;
	})();
}
/** Persistent bounded rate window for public account actions. */
export function limitAccountAction(key: string) {
	const bucket = `auth_limit:${digest(key)}`;
	getDb().transaction(() => {
		getDb()
			.prepare(
				"DELETE FROM settings WHERE key LIKE 'auth_limit:%' AND updated_at<datetime('now','-15 minutes')",
			)
			.run();
		const n = +(getSetting(bucket) ?? "0");
		if (n >= 5) throw new Error("Too many attempts. Try again in 15 minutes.");
		setSetting(bucket, String(n + 1));
	})();
}
