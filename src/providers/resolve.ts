import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ModelLimits } from "../agent/context/types.ts";
import { loadProviderSettings } from "../config/provider.ts";
import type {
	ConfigContext,
	ProviderSelection,
	ProviderSettings,
} from "../config/types.ts";
import { compatibleChatModel } from "./compatibleChat.ts";
import { providerLimits } from "./limits.ts";
import { createProviderTransport } from "./transport.ts";

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
	const guardedFetch = createProviderTransport(settings, {
		apiKey,
		fetch: context.fetch,
	});
	const client = createOpenAI({
		name: settings.provider === "openai" ? "openai" : "compatible",
		baseURL: settings.baseURL,
		apiKey: apiKey ?? "toolwright-no-auth",
		fetch: guardedFetch,
	});
	const limits = providerLimits(settings);
	return {
		settings,
		languageModel: selectLanguageModel(client, settings, guardedFetch),
		limits,
		request: (route) =>
			guardedFetch(`${settings.baseURL}/${route}`, {
				signal: AbortSignal.timeout(10000),
			}),
	};
}

function selectLanguageModel(
	client: ReturnType<typeof createOpenAI>,
	settings: ProviderSettings,
	transport: typeof globalThis.fetch,
): LanguageModel {
	if (settings.api === "responses") return client.responses(settings.model);
	if (settings.provider === "openai-compatible") {
		return compatibleChatModel(settings.model, settings.baseURL, transport);
	}
	return client.chat(settings.model);
}
