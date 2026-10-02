import type {
	LanguageModelV4,
	LanguageModelV4StreamPart,
	LanguageModelV4Usage,
} from "@ai-sdk/provider";

export type ScriptedLanguageModel = LanguageModelV4;
export type ScriptedStreamPart = LanguageModelV4StreamPart;

/** Current provider-level usage shape; SDK totals are derived from these counts. */
export function scriptedUsage(
	input: number,
	output: number,
): LanguageModelV4Usage {
	return {
		inputTokens: {
			total: input,
			noCache: input,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: { total: output, text: output, reasoning: undefined },
	};
}

export interface ScriptStep {
	error?: string;
	text?: string;
	calls?: Array<{ name: string; args: unknown }>;
	usage?: number;
}

/** Deterministic provider seam for execution and objective coding fixtures. No network or credentials. */
export function scriptedModel(
	steps: ScriptStep[],
	inspect?: (options: unknown) => void,
	onSummary?: () => void,
): ScriptedLanguageModel {
	let index = 0;
	return {
		specificationVersion: "v4",
		provider: "fixture",
		modelId: "fixture",
		supportedUrls: {},
		doGenerate: async () => {
			onSummary?.();
			return {
				content: [
					{
						type: "text",
						text: "Earlier work completed; preserve original goal, recent changes, and verification results.",
					},
				],
				finishReason: { unified: "stop", raw: undefined },
				usage: scriptedUsage(20, 10),
				warnings: [],
			};
		},
		doStream: async (options: unknown) => {
			inspect?.(options);
			const step = steps[index++] ?? { text: "done" };
			if (step.error) throw new Error(step.error);
			const parts: ScriptedStreamPart[] = [
				{ type: "stream-start", warnings: [] },
			];
			if (step.text)
				parts.push(
					{ type: "text-start", id: "text" },
					{ type: "text-delta", id: "text", delta: step.text },
					{ type: "text-end", id: "text" },
				);
			for (const [i, call] of (step.calls ?? []).entries())
				parts.push({
					type: "tool-call",
					toolCallId: `step-${index}-${i}`,
					toolName: call.name,
					input:
						typeof call.args === "string"
							? call.args
							: JSON.stringify(call.args),
				});
			parts.push({
				type: "finish",
				finishReason: {
					unified: step.calls?.length ? "tool-calls" : "stop",
					raw: undefined,
				},
				usage: scriptedUsage(step.usage ?? 20, 5),
			});
			return {
				stream: new ReadableStream({
					start(controller) {
						for (const part of parts) controller.enqueue(part);
						controller.close();
					},
				}),
				warnings: [],
			};
		},
	};
}
