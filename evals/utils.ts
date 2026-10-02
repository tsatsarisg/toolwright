import { type ModelMessage, type ToolSet, tool } from "ai";
import { z } from "zod";
import { SYSTEM_PROMPT } from "../src/agent/system/prompt.ts";
import type { EvalData, MultiTurnEvalData } from "./types.ts";

/**
 * Build mocked tools from data config.
 * Each tool returns its configured mockReturn value.
 */
export const buildMockedTools = (
	mockTools: MultiTurnEvalData["mockTools"],
): ToolSet => {
	const tools: ToolSet = {};

	for (const [name, config] of Object.entries(mockTools)) {
		// Build parameter schema dynamically
		const paramSchema: Record<string, z.ZodString> = {};
		for (const paramName of Object.keys(config.parameters)) {
			paramSchema[paramName] = z.string();
		}

		tools[name] = tool({
			description: config.description,
			inputSchema: z.object(paramSchema),
			execute: async () => config.mockReturn,
		});
	}

	return tools;
};

/**
 * Build the system prompt and message array from eval data.
 *
 * The system prompt is returned separately so callers can pass it via the
 * SDK's `instructions` option instead of embedding it in `messages` (which the SDK
 * warns against as a prompt-injection risk).
 */
export const buildMessages = (
	data: EvalData | { prompt?: string; systemPrompt?: string },
): { system: string; messages: ModelMessage[] } => {
	const system = data.systemPrompt ?? SYSTEM_PROMPT;
	if (data.prompt === undefined)
		throw new Error("Evaluation requires a prompt.");
	return {
		system,
		messages: [{ role: "user", content: data.prompt }],
	};
};
