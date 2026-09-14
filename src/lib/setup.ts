// The installation wizard's own state. Progress is DERIVED — the only thing
// stored is the terminal `setup_done` marker finishSetup writes, so re-entering
// a step later from the admin console never rewinds anything.
import {
	CONFIG,
	config,
	publicOrigin,
	audit,
	saveConfig,
	type ConfigKey,
} from "./app-config.ts";
import { getDb } from "./db.ts";
import { identityConnectors } from "./identity.ts";
import { setupDone } from "./installation.ts";
import { getSetting, setSetting } from "./settings.ts";

export const SETUP_STEPS = [
	"claim",
	"url",
	"email",
	"policy",
	"sso",
	"review",
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** A connected-service client is only usable with BOTH halves on file. */
const OAUTH_CLIENTS: Record<string, readonly ConfigKey[]> = {
	google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
	microsoft: ["MS_CLIENT_ID", "MS_CLIENT_SECRET"],
	notion: ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"],
	zoho: ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET"],
};

export function setupStatus(): {
	origin: string;
	smtpVerified: boolean;
	policy: string;
	passwordLogin: boolean;
	connectors: string[];
	oauth: string[];
	done: boolean;
} {
	return {
		origin: publicOrigin(),
		smtpVerified: !!getSetting("smtp_verified"),
		policy: config("REGISTRATION_POLICY"),
		passwordLogin: config("PASSWORD_LOGIN") === "true",
		connectors: identityConnectors()
			.filter((c) => c.enabled)
			.map((c) => c.name),
		oauth: Object.entries(OAUTH_CLIENTS)
			.filter(([, keys]) => keys.every((key) => !!config(key)))
			.map(([id]) => id),
		done: setupDone(),
	};
}

export function finishSetup(actor: number): void {
	setSetting("setup_done", new Date().toISOString());
	audit(actor, "installation.finished");
}

/** Save the CONFIG fields a wizard step posted. A key the form never carried is
 *  untouched, and a blank secret means "keep what is stored" — the page never
 *  renders a secret back, so an empty box is absence of input, not a clear.
 *  saveConfig's own validation throws; the step shows the message, and the whole
 *  step is one transaction so a throw halfway down the list writes nothing. */
export function saveConfigForm(
	form: FormData,
	keys: ConfigKey[],
	actor: number | null,
): void {
	getDb().transaction(() => {
		for (const key of keys) {
			if (!form.has(key)) continue;
			const value = String(form.get(key) ?? "");
			if (!value.trim() && (CONFIG[key] as { secret?: boolean }).secret)
				continue;
			// An unchanged field is not a write. saveConfig drops smtp_verified on
			// ANY SMTP_* write and identity_admin_verified on any GOOGLE_*/MS_*/
			// SSO_WORKSPACE_DOMAIN one, so re-posting a form the admin only read
			// would silently re-lock the step they just unlocked.
			if (value.trim() === config(key)) continue;
			saveConfig(key, value, actor);
		}
	})();
}
