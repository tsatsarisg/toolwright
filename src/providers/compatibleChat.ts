import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";

/** Use the compatible protocol without OpenAI-specific model-name heuristics. */
export function compatibleChatModel(
	modelId: string,
	baseURL: string,
	fetch: typeof globalThis.fetch,
): LanguageModelV4 {
	return createOpenAICompatible({
		name: "compatible",
		baseURL,
		fetch,
		includeUsage: true,
	}).chatModel(modelId);
}
