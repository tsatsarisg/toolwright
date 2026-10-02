import type { ModelMessage } from "ai";
import type { AgentCallbacks } from "../types.ts";
import { calculateUsagePercentage, DEFAULT_THRESHOLD } from "./modelLimits.ts";
import { estimateMessagesTokens } from "./tokenEstimator.ts";
import type { TokenUsageInfo } from "./types.ts";

interface UsageReport {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}
export function reportTokenUsage(
	callbacks: AgentCallbacks,
	systemPrompt: string,
	currentMessages: ModelMessage[],
	contextWindow: number,
	real?: UsageReport,
): void {
	if (!callbacks.onTokenUsage) return;
	const estimate = estimateMessagesTokens([
		{ role: "system", content: systemPrompt },
		...currentMessages,
	]);
	const hasReal = (real?.totalTokens ?? 0) > 0;
	const input = hasReal ? (real?.inputTokens ?? 0) : estimate.input;
	const output = hasReal ? (real?.outputTokens ?? 0) : estimate.output;
	const total = hasReal
		? (real?.totalTokens ?? input + output)
		: estimate.total;
	const usage: TokenUsageInfo = {
		inputTokens: input,
		outputTokens: output,
		totalTokens: total,
		contextWindow,
		threshold: DEFAULT_THRESHOLD,
		percentage: calculateUsagePercentage(total, contextWindow),
	};
	callbacks.onTokenUsage(usage);
}
