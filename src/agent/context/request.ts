import type { ModelMessage } from "ai";
import type { ResolvedProvider } from "../../providers/resolve.ts";
import type { TokenBudget } from "./budget.ts";
import { compactConversation, defaultSummarizer } from "./compaction.ts";
import { DEFAULT_THRESHOLD } from "./modelLimits.ts";
import { estimateMessagesTokens } from "./tokenEstimator.ts";

interface RequestContextOptions {
	systemPrompt: string;
	provider: ResolvedProvider;
	schemaTokens: number;
	budget: TokenBudget;
	signal: AbortSignal;
	telemetry?: boolean;
}

type RequestContext =
	| {
			kind: "ready";
			messages: ModelMessage[];
			inputBudget: number;
			maxOutputTokens: number;
	  }
	| { kind: "limited"; messages: ModelMessage[]; reason: string };

/** Compaction and the next request consume the same cumulative budget and provider. */
export async function prepareRequestContext(
	messages: ModelMessage[],
	options: RequestContextOptions,
): Promise<RequestContext> {
	const { provider, budget, signal } = options;
	const { limits } = provider;
	const cost = () =>
		estimateMessagesTokens([
			{ role: "system", content: options.systemPrompt },
			...messages,
		]).total + options.schemaTokens;
	const inputBudget = Math.min(
		limits.inputLimit,
		Math.floor(limits.contextWindow * DEFAULT_THRESHOLD),
	);
	if (cost() > inputBudget) {
		messages = await compactConversation(
			messages,
			provider,
			defaultSummarizer(
				provider,
				signal,
				(tokens) => budget.recordCompaction(tokens),
				(tokens) => budget.checkCompactionReservation(tokens),
				options.telemetry,
			),
			{ includeCurrentTurn: true },
		);
		if (cost() > inputBudget) {
			return {
				kind: "limited",
				messages,
				reason:
					"Context limit: retained intent, instructions, tool schemas and recent state cannot fit. Narrow the task or use a larger context.",
			};
		}
	}
	return {
		kind: "ready",
		messages,
		inputBudget,
		maxOutputTokens: Math.min(
			limits.outputLimit,
			budget.outputAllowance(cost()),
		),
	};
}
