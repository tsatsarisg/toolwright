import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/** Default model id used whenever a caller doesn't specify one. */
export const DEFAULT_MODEL = "gpt-5-mini";

/** Resolve a model id to a Vercel AI SDK model instance. The one place that calls openai(). */
export function resolveModel(modelId: string = DEFAULT_MODEL): LanguageModel {
	return openai(modelId);
}
