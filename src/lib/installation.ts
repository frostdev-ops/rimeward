import { isDesktop } from "./dev/runtime.ts";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, getDb } from "./db.ts";
import { createUser, userCount } from "./users.ts";
import { audit, saveConfig } from "./app-config.ts";
import { getSetting, setSetting } from "./settings.ts";

const file = () => path.join(DATA_DIR, "setup-token");
export function needsSetup() {
	return !isDesktop() && userCount() === 0;
}
/** The wizard has run to the end; until then /setup is reachable over a LAN address. */
export function setupDone() {
	return getSetting("setup_done") !== null;
}
/** Created once with exclusive permissions; only the installer can read it. */
export function ensureSetupToken() {
	if (!needsSetup()) return;
	try {
		fs.writeFileSync(file(), crypto.randomBytes(32).toString("base64url"), {
			mode: 0o600,
			flag: "wx",
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}
export function claimInstallation(
	token: string,
	email: string,
	password: string,
	origin: string,
) {
	if (!needsSetup()) throw new Error("Installation is already configured");
	const expected = fs.readFileSync(file(), "utf8");
	if (
		token.length !== expected.length ||
		!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
	)
		throw new Error("Invalid installation token");
	if (
		!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
		password.length < 12 ||
		password.length > 1024
	)
		throw new Error(
			"Use a valid email and a password of at least 12 characters",
		);
	const user = getDb()
		.transaction(() => {
			if (!needsSetup()) throw new Error("Installation is already configured");
			saveConfig("PUBLIC_BASE_URL", origin, null);
			const id = createUser(email, password, "admin");
			setSetting("installation_complete", "true");
			audit(id, "installation.claimed");
			return id;
		})
		.immediate();
	fs.rmSync(file(), { force: true });
	return user;
}
