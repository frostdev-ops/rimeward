import { isDesktop } from "./dev/runtime.ts";
import { getDb } from "./db.ts";
import { getSetting, setSetting, deleteSetting } from "./settings.ts";
import { sealToken, openToken } from "./crypto.ts";

type Field = {
	label: string;
	group: string;
	default: string;
	secret?: boolean;
	choices?: readonly string[];
	restart?: boolean;
};
export const CONFIG = {
	PUBLIC_BASE_URL: {
		label: "Public URL",
		group: "Installation",
		default: "http://localhost:4321",
	},
	REGISTRATION_POLICY: {
		label: "Registration",
		group: "Sign-in",
		default: "invite",
		choices: ["invite", "approval", "open"],
	},
	PASSWORD_LOGIN: {
		label: "Password login",
		group: "Sign-in",
		default: "true",
		choices: ["true", "false"],
	},
	SSO_WORKSPACE_DOMAIN: {
		label: "Allowed SSO domains (comma separated)",
		group: "Sign-in",
		default: "",
	},
	GOOGLE_SSO_ENABLED: {
		label: "Google sign-in enabled",
		group: "Sign-in",
		default: "true",
		choices: ["true", "false"],
	},
	MS_SSO_ENABLED: {
		label: "Microsoft sign-in enabled",
		group: "Sign-in",
		default: "false",
		choices: ["true", "false"],
	},
	GOOGLE_CLIENT_ID: { label: "Google client ID", group: "OAuth", default: "" },
	GOOGLE_CLIENT_SECRET: {
		label: "Google client secret",
		group: "OAuth",
		default: "",
		secret: true,
	},
	MS_CLIENT_ID: { label: "Microsoft client ID", group: "OAuth", default: "" },
	MS_CLIENT_SECRET: {
		label: "Microsoft client secret",
		group: "OAuth",
		default: "",
		secret: true,
	},
	MS_TENANT_ID: {
		label: "Microsoft tenant",
		group: "OAuth",
		default: "common",
	},
	NOTION_CLIENT_ID: { label: "Notion client ID", group: "OAuth", default: "" },
	NOTION_CLIENT_SECRET: {
		label: "Notion client secret",
		group: "OAuth",
		default: "",
		secret: true,
	},
	ZOHO_CLIENT_ID: { label: "Zoho client ID", group: "OAuth", default: "" },
	ZOHO_CLIENT_SECRET: {
		label: "Zoho client secret",
		group: "OAuth",
		default: "",
		secret: true,
	},
	SMTP_HOST: { label: "SMTP host", group: "Email", default: "" },
	SMTP_PORT: { label: "SMTP port", group: "Email", default: "587" },
	SMTP_SECURE: {
		label: "Implicit TLS (port 465)",
		group: "Email",
		default: "false",
		choices: ["true", "false"],
	},
	SMTP_USER: { label: "SMTP username", group: "Email", default: "" },
	SMTP_PASSWORD: {
		label: "SMTP password",
		group: "Email",
		default: "",
		secret: true,
	},
	SMTP_FROM: { label: "Sender email", group: "Email", default: "" },
	BROWSER_PROFILES: {
		label: "Browser profile directory (blank uses app data)",
		group: "Runtime",
		default: "",
		restart: true,
	},
	BROWSER_MAX_SESSIONS: {
		label: "Maximum browser sessions",
		group: "Runtime",
		default: "3",
		restart: true,
	},
	RIMEWARD_RTC_VIEWERS: {
		label: "Maximum browser viewers",
		group: "Runtime",
		default: "4",
	},
	OAUTH_USE_BROKER: {
		label: "Use an external broker on this server",
		group: "OAuth",
		default: "false",
		choices: ["true", "false"],
	},
	OAUTH_BROKER_URL: {
		label: "Optional OAuth broker URL",
		group: "OAuth",
		default: "https://frostdev.io",
	},
} satisfies Record<string, Field>;
export type ConfigKey = keyof typeof CONFIG;
export function config(key: ConfigKey): string {
	if (key === "PUBLIC_BASE_URL" && isDesktop())
		return process.env.PUBLIC_BASE_URL ?? CONFIG.PUBLIC_BASE_URL.default;
	const field: Field = CONFIG[key];
	const stored = getSetting(`config:${key}`);
	if (stored !== null) return field.secret ? openToken(stored) : stored;
	// Upgrade the old plaintext secret slot transactionally on first use.
	const legacy = getSetting(`secret:${key}`);
	if (legacy !== null) {
		getDb().transaction(() => {
			setSetting(`config:${key}`, field.secret ? sealToken(legacy) : legacy);
			deleteSetting(`secret:${key}`);
		})();
		return legacy;
	}
	return process.env[key]?.trim() || field.default;
}
export function configuredOrigin(): string | undefined {
	if (
		process.env.PUBLIC_BASE_URL ||
		getSetting("config:PUBLIC_BASE_URL") !== null
	)
		return publicOrigin();
	return undefined;
}
export function publicOrigin(): string {
	return config("PUBLIC_BASE_URL").replace(/\/$/, "");
}
export function audit(actor: number | null, event: string, target = "") {
	getDb()
		.prepare("INSERT INTO auth_audit(actor,event,target) VALUES(?,?,?)")
		.run(actor, event, target.slice(0, 200));
}
export function configView(key: ConfigKey) {
	const field: Field = CONFIG[key],
		value = config(key);
	return {
		key,
		...field,
		value: field.secret ? "" : value,
		configured: !!value,
		source:
			getSetting(`config:${key}`) !== null
				? "saved"
				: process.env[key]
					? "environment"
					: "default",
	};
}
export function saveConfig(
	key: ConfigKey,
	value: string | null,
	actor: number | null,
) {
	const field: Field = CONFIG[key];
	if (!field) throw new Error("Unknown setting");
	if (key === "PUBLIC_BASE_URL" && isDesktop())
		throw new Error("The desktop owns its local URL");
	if (
		key !== "PASSWORD_LOGIN" &&
		config("PASSWORD_LOGIN") === "false" &&
		(key.startsWith("GOOGLE_") ||
			key.startsWith("MS_") ||
			key === "SSO_WORKSPACE_DOMAIN")
	)
		throw new Error(
			"Re-enable password login before changing the configured sign-in methods",
		);
	if (value !== null) {
		value = value.trim();
		if (
			key === "PASSWORD_LOGIN" &&
			value === "false" &&
			!getSetting("identity_admin_verified")?.startsWith(`${actor}:`)
		)
			throw new Error(
				"Sign in successfully as an administrator with an alternate method before disabling passwords",
			);
		if (value.length > 8192) throw new Error("Setting is too long");
		if (field.choices && !field.choices.includes(value))
			throw new Error("Invalid setting value");
		if (["PUBLIC_BASE_URL", "OAUTH_BROKER_URL"].includes(key) && value) {
			const url = new URL(value);
			if (
				!["http:", "https:"].includes(url.protocol) ||
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				url.pathname !== "/"
			)
				throw new Error("Use an origin without a path or credentials");
			if (key === "OAUTH_BROKER_URL" && url.protocol !== "https:")
				throw new Error("Broker requires HTTPS");
			value = url.origin;
		}
		if (
			["SMTP_PORT", "BROWSER_MAX_SESSIONS", "RIMEWARD_RTC_VIEWERS"].includes(
				key,
			) &&
			(!/^\d+$/.test(value) ||
				+value < 1 ||
				+value > (key === "SMTP_PORT" ? 65535 : 100))
		)
			throw new Error("Invalid limit");
		if (
			key === "REGISTRATION_POLICY" &&
			value !== "invite" &&
			config("PASSWORD_LOGIN") === "true" &&
			!getSetting("smtp_verified")
		)
			throw new Error(
				"Verify email delivery before enabling public password registration",
			);
		if (
			key === "PASSWORD_LOGIN" &&
			value === "true" &&
			config("REGISTRATION_POLICY") !== "invite" &&
			!getSetting("smtp_verified")
		)
			throw new Error("Verify email delivery first");
	}
	getDb().transaction(() => {
		if (value === null) {
			deleteSetting(`config:${key}`);
			deleteSetting(`secret:${key}`);
		} else setSetting(`config:${key}`, field.secret ? sealToken(value) : value);
		if (
			key !== "PASSWORD_LOGIN" &&
			(key.startsWith("GOOGLE_") ||
				key.startsWith("MS_") ||
				key === "SSO_WORKSPACE_DOMAIN")
		)
			deleteSetting("identity_admin_verified");
		if (key.startsWith("SMTP_")) deleteSetting("smtp_verified");
		audit(actor, "config.changed", key);
	})();
}

export function identityEnabled(id:string):boolean {
  if(id==='google')return config('GOOGLE_SSO_ENABLED')==='true' && !!config('GOOGLE_CLIENT_ID');
  if(id==='microsoft')return config('MS_SSO_ENABLED')==='true' && !!config('MS_CLIENT_ID');
  const connectors=JSON.parse(getSetting('identity_connectors')??'[]') as {id:string;enabled:boolean}[];
  return connectors.some(c=>c.id===id&&c.enabled);
}
