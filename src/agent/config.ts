import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_MODEL = "gpt-6-luna";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const LOCAL_BASE_URL = "http://127.0.0.1:1234/v1";

const providerSchema = z.enum(["openai", "openai-compatible"]);
const apiSchema = z.enum(["responses", "chat-completions"]);
const positiveInteger = z.number().int().positive();
const capabilitiesSchema = z
	.object({
		tools: z.boolean().optional(),
		streaming: z.boolean().optional(),
		hostedWebSearch: z.boolean().optional(),
	})
	.strict();
const profileSchema = z
	.object({
		provider: providerSchema,
		api: apiSchema.optional(),
		baseURL: z.string().optional(),
		apiKeyEnv: z.string().min(1).optional(),
		model: z.string().min(1).optional(),
		contextWindow: positiveInteger.optional(),
		maxOutputTokens: positiveInteger.optional(),
		localOnly: z.boolean().optional(),
		telemetry: z.boolean().optional(),
		capabilities: capabilitiesSchema.optional(),
	})
	.strict();
const configSchema = z
	.object({
		defaultProfile: z.string().min(1).optional(),
		profiles: z.record(z.string().min(1), profileSchema).optional(),
	})
	.strict();
// Project files cannot select credentials, endpoints, or relax local-only policy.
const projectSchema = z
	.object({
		profile: z.string().min(1).optional(),
		model: z.string().min(1).optional(),
		contextWindow: positiveInteger.optional(),
		maxOutputTokens: positiveInteger.optional(),
	})
	.strict();

export type ProviderKind = z.infer<typeof providerSchema>;
export type ModelApi = z.infer<typeof apiSchema>;
export interface ProviderSelection {
	profile?: string;
	provider?: ProviderKind;
	api?: ModelApi;
	baseURL?: string;
	apiKeyEnv?: string;
	model?: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	localOnly?: boolean;
	trustProjectConfig?: boolean;
}
export interface ConfigContext {
	configPath?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Diagnostics may list available models before one is selected. */
	requireModel?: boolean;
}
export interface ProviderSettings {
	profile: string;
	provider: ProviderKind;
	api: ModelApi;
	baseURL: string;
	apiKeyEnv?: string;
	model: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	localOnly: boolean;
	telemetry: boolean;
	capabilities: {
		tools: boolean;
		streaming: boolean;
		hostedWebSearch: boolean;
	};
}

function readConfig<T>(file: string, schema: z.ZodType<T>): T | undefined {
	let raw: string;
	try {
		raw = readFileSync(file, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Cannot read configuration: ${file}`);
	}
	try {
		return schema.parse(JSON.parse(raw));
	} catch {
		throw new Error(
			`Invalid configuration: ${file}. Check supported fields and value types.`,
		);
	}
}

export function endpointURL(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Provider base URL must be an absolute HTTP(S) URL.");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"Provider base URL must use HTTP(S) without embedded credentials, query, or fragment.",
		);
	}
	return url;
}

export function loadProviderSettings(
	selection: ProviderSelection = {},
	context: ConfigContext = {},
): ProviderSettings {
	const env = context.env ?? process.env;
	const configPath =
		context.configPath ?? path.join(os.homedir(), ".toolwright", "config.json");
	const config = readConfig(configPath, configSchema);
	const project = selection.trustProjectConfig
		? readConfig(
				path.join(context.cwd ?? process.cwd(), ".toolwright", "config.json"),
				projectSchema,
			)
		: undefined;
	const profileName =
		selection.profile ??
		env.TOOLWRIGHT_PROFILE ??
		project?.profile ??
		config?.defaultProfile ??
		"openai";
	const builtin: z.infer<typeof profileSchema> | undefined =
		profileName === "openai"
			? { provider: "openai" as const, model: DEFAULT_MODEL }
			: profileName === "lmstudio"
				? { provider: "openai-compatible" as const }
				: undefined;
	const profile = config?.profiles?.[profileName] ?? builtin;
	if (!profile) throw new Error(`Unknown provider profile: ${profileName}`);
	const switched =
		selection.provider !== undefined && selection.provider !== profile.provider;
	const baseProfile = switched ? { provider: selection.provider } : profile;
	const overrideKeys = new Set([
		"provider",
		"api",
		"baseURL",
		"apiKeyEnv",
		"model",
		"contextWindow",
		"maxOutputTokens",
		"localOnly",
	]);
	const overrides = Object.fromEntries(
		Object.entries(selection).filter(
			([key, value]) => overrideKeys.has(key) && value !== undefined,
		),
	);
	const merged = profileSchema.parse({
		...baseProfile,
		...(project && {
			model: project.model ?? (!switched ? profile.model : undefined),
			contextWindow:
				project.contextWindow ??
				(!switched ? profile.contextWindow : undefined),
			maxOutputTokens:
				project.maxOutputTokens ??
				(!switched ? profile.maxOutputTokens : undefined),
		}),
		...overrides,
	});
	// Switching provider families does not retain the other provider's implicit defaults.
	const provider = merged.provider;
	const baseURL = endpointURL(
		merged.baseURL ??
			(provider === "openai" ? OPENAI_BASE_URL : LOCAL_BASE_URL),
	).href.replace(/\/$/, "");
	const api =
		merged.api ?? (provider === "openai" ? "responses" : "chat-completions");
	const model =
		selection.model ??
		env.TOOLWRIGHT_MODEL ??
		project?.model ??
		(!switched ? profile.model : undefined) ??
		(provider === "openai" ? DEFAULT_MODEL : undefined);
	if (!model && context.requireModel !== false)
		throw new Error(
			`Select a model for profile "${profileName}" with --model or user configuration. Use "toolwright models" to list IDs.`,
		);
	const origin = endpointURL(baseURL).origin;
	const originalOrigin = endpointURL(
		profile.baseURL ??
			(profile.provider === "openai" ? OPENAI_BASE_URL : LOCAL_BASE_URL),
	).origin;
	const apiKeyEnv =
		selection.apiKeyEnv ??
		(origin === originalOrigin && !switched ? profile.apiKeyEnv : undefined) ??
		(provider === "openai" && origin === endpointURL(OPENAI_BASE_URL).origin
			? "OPENAI_API_KEY"
			: undefined);
	const localOnly = merged.localOnly ?? false;
	if (
		localOnly &&
		!["localhost", "127.0.0.1", "[::1]"].includes(endpointURL(baseURL).hostname)
	) {
		throw new Error(
			"Local-only profiles require a loopback endpoint (localhost, 127.0.0.1, or ::1).",
		);
	}
	const hostedSupported =
		provider === "openai" &&
		api === "responses" &&
		origin === endpointURL(OPENAI_BASE_URL).origin;
	return {
		profile: profileName,
		provider,
		api,
		baseURL,
		apiKeyEnv,
		model: model ?? "",
		contextWindow: merged.contextWindow,
		maxOutputTokens: merged.maxOutputTokens,
		localOnly,
		telemetry: !localOnly && (merged.telemetry ?? provider === "openai"),
		capabilities: {
			tools: merged.capabilities?.tools ?? true,
			streaming: merged.capabilities?.streaming ?? true,
			hostedWebSearch:
				!localOnly &&
				hostedSupported &&
				(merged.capabilities?.hostedWebSearch ?? true),
		},
	};
}
