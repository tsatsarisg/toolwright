import { getModelLimits } from "../agent/context/modelLimits.ts";
import type { ModelLimits } from "../agent/context/types.ts";
import type { ProviderSettings } from "../config/types.ts";

export function providerLimits(settings: ProviderSettings): ModelLimits {
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
		contextWindow,
		outputLimit,
		inputLimit:
			settings.provider === "openai-compatible"
				? contextWindow - outputLimit
				: Math.min(defaults.inputLimit, contextWindow - outputLimit),
	};
}
