import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import { builtinProfiles, DEFAULT_MODEL, OPENAI_BASE_URL } from "./defaults.ts";
import {
	credentialVariableFor,
	defaultEndpoint,
	endpointURL,
} from "./endpoint.ts";
import {
	configSchema,
	type ProjectConfiguration,
	type ProviderProfile,
	profileSchema,
	projectSchema,
} from "./schema.ts";
import type {
	ConfigContext,
	ProviderSelection,
	ProviderSettings,
} from "./types.ts";

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
	const profile =
		config?.profiles?.[profileName] ?? builtinProfiles.get(profileName);
	if (!profile) throw new Error(`Unknown provider profile: ${profileName}`);
	const switched =
		selection.provider !== undefined && selection.provider !== profile.provider;
	const merged = mergeProfile(profile, selection, project);
	// Switching provider families does not retain the other provider's implicit defaults.
	const provider = merged.provider;
	const baseURL = endpointURL(
		merged.baseURL ?? defaultEndpoint(provider),
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
	const apiKeyEnv = credentialVariableFor(selection, profile, {
		provider,
		baseURL,
	});
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
		endpointURL(baseURL).origin === endpointURL(OPENAI_BASE_URL).origin;
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

function mergeProfile(
	profile: ProviderProfile,
	selection: ProviderSelection,
	project?: ProjectConfiguration,
): ProviderProfile {
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
	return profileSchema.parse({
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
}
