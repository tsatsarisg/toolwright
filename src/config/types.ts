import type { z } from "zod";
import type { apiSchema, providerSchema } from "./schema.ts";

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
