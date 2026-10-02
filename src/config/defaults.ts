import type { ProviderProfile } from "./schema.ts";

export const DEFAULT_MODEL = "gpt-6-luna";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const LOCAL_BASE_URL = "http://127.0.0.1:1234/v1";

export const builtinProfiles = new Map<string, ProviderProfile>([
	["openai", { provider: "openai", model: DEFAULT_MODEL }],
	["lmstudio", { provider: "openai-compatible" }],
]);
