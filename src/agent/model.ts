import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ModelLimits } from "../types.ts";
import { compatibleChatModel } from "./compatibleChat.ts";
import {
	type ConfigContext,
	DEFAULT_MODEL,
	endpointURL,
	loadProviderSettings,
	type ProviderSelection,
	type ProviderSettings,
} from "./config.ts";
import { getModelLimits } from "./context/modelLimits.ts";

export { DEFAULT_MODEL } from "./config.ts";

export interface ResolvedProvider {
	settings: ProviderSettings;
	languageModel: LanguageModel;
	limits: ModelLimits;
	/** Same endpoint/credential/redirect boundary for inference and diagnostics. */
	request: (route: string) => Promise<Response>;
}

export function resolveProvider(
	selection: ProviderSelection = {},
	context: ConfigContext & { fetch?: typeof globalThis.fetch } = {},
): ResolvedProvider {
	const settings = loadProviderSettings(selection, context);
	const env = context.env ?? process.env;
	const apiKey = settings.apiKeyEnv ? env[settings.apiKeyEnv] : undefined;
	const endpoint = endpointURL(settings.baseURL);
	const transport = context.fetch ?? globalThis.fetch;
	const guardedFetch: typeof globalThis.fetch = async (input, init) => {
		const target = new URL(
			input instanceof Request ? input.url : String(input),
		);
		if (
			target.origin !== endpoint.origin ||
			!target.pathname.startsWith(`${endpoint.pathname.replace(/\/$/, "")}/`)
		) {
			throw new Error(
				"Refusing a request outside the configured provider endpoint.",
			);
		}
		if (settings.apiKeyEnv && !apiKey)
			throw new Error(`Missing provider credential: ${settings.apiKeyEnv}`);
		const headers = new Headers(init?.headers);
		// Suppress the SDK's OPENAI_API_KEY fallback and placeholder Authorization.
		if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
		else headers.delete("authorization");
		return transport(input, { ...init, headers, redirect: "error" });
	};
	const client = createOpenAI({
		name: settings.provider === "openai" ? "openai" : "compatible",
		baseURL: settings.baseURL,
		apiKey: apiKey ?? "toolwright-no-auth",
		fetch: guardedFetch,
	});
	const defaults =
		settings.provider === "openai"
			? getModelLimits(settings.model)
			: { contextWindow: 8192, outputLimit: 2048, inputLimit: 6144 };
	const contextWindow = settings.contextWindow ?? defaults.contextWindow;
	const outputLimit =
		settings.maxOutputTokens ??
		Math.min(defaults.outputLimit, Math.floor(contextWindow / 4));
	if (outputLimit >= contextWindow)
		throw new Error("maxOutputTokens must be smaller than contextWindow.");
	return {
		settings,
		languageModel:
			settings.api === "responses"
				? client.responses(settings.model)
				: settings.provider === "openai-compatible"
					? compatibleChatModel(settings.model, settings.baseURL, guardedFetch)
					: client.chat(settings.model),
		limits: {
			contextWindow,
			outputLimit,
			inputLimit:
				settings.provider === "openai-compatible"
					? contextWindow - outputLimit
					: Math.min(defaults.inputLimit, contextWindow - outputLimit),
		},
		request: (route) =>
			guardedFetch(`${settings.baseURL}/${route}`, {
				signal: AbortSignal.timeout(10000),
			}),
	};
}

/** Compatibility helper for callers selecting just a model ID. */
export function resolveModel(modelId: string = DEFAULT_MODEL): LanguageModel {
	return resolveProvider({ model: modelId }).languageModel;
}
