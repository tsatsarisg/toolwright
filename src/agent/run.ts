import { getTracer } from "@lmnr-ai/lmnr";
import {
	type LanguageModel,
	type ModelMessage,
	streamText,
	type ToolSet,
} from "ai";
import type { AgentCallbacks, ToolCallInfo } from "../types.ts";
import { compactConversation } from "./context/compaction.ts";
import {
	calculateUsagePercentage,
	DEFAULT_THRESHOLD,
	getModelLimits,
	isOverThreshold,
} from "./context/modelLimits.ts";
import { estimateMessagesTokens } from "./context/tokenEstimator.ts";
import { executeTool } from "./executeTool.ts";
import { DEFAULT_MODEL, resolveModel } from "./model.ts";
import { filterCompatibleMessages } from "./system/filterMessages.ts";
import { SYSTEM_PROMPT } from "./system/prompt.ts";
import {
	tools as defaultTools,
	READ_ONLY_TOOLS,
	toModelTools,
} from "./tools/index.ts";

const NO_RESPONSE_FALLBACK =
	"I apologize, but I wasn't able to generate a response. Could you please try rephrasing your message?";

/** Opt-in escape hatch for full-content tracing; see the telemetry span config below. */
const RECORD_TELEMETRY_IO = process.env.TOOLWRIGHT_TELEMETRY_RECORD_IO === "1";

export interface RunAgentOptions {
	/** Model id to use (default: gpt-5-mini). Also drives the context-window lookup. */
	model?: string;
	/**
	 * Testing/DI seam: the actual LanguageModel passed to streamText. Defaults
	 * to resolveModel(model). Pass a mock (e.g. ai/test's MockLanguageModelV2)
	 * to drive the loop without a real API call.
	 */
	languageModel?: LanguageModel;
	/** Executable toolset; the model is shown an execute-less view of it. */
	tools?: ToolSet;
	/** System prompt (default: the app's SYSTEM_PROMPT). */
	systemPrompt?: string;
	/** Emit Laminar telemetry spans (default: true). Off for tests/evals. */
	telemetry?: boolean;
}

interface UsageReport {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

/**
 * Estimate (or, when the provider gave us real counts, report) token usage
 * and hand it to the caller's callback. Takes everything it needs as
 * parameters rather than closing over runAgent's locals, so it's testable
 * on its own.
 */
export function reportTokenUsage(
	callbacks: AgentCallbacks,
	systemPrompt: string,
	currentMessages: ModelMessage[],
	contextWindow: number,
	real?: UsageReport,
): void {
	if (!callbacks.onTokenUsage) return;

	let input: number;
	let output: number;
	let total: number;

	if (real && (real.totalTokens ?? 0) > 0) {
		// Prefer the provider's actual counts when we have them.
		input = real.inputTokens ?? 0;
		output = real.outputTokens ?? 0;
		total = real.totalTokens ?? input + output;
	} else {
		// Include the system prompt (sent via the `system` option, not in
		// `messages`) so the estimate reflects the full request.
		const est = estimateMessagesTokens([
			{ role: "system", content: systemPrompt },
			...currentMessages,
		]);
		input = est.input;
		output = est.output;
		total = est.total;
	}

	callbacks.onTokenUsage({
		inputTokens: input,
		outputTokens: output,
		totalTokens: total,
		contextWindow,
		threshold: DEFAULT_THRESHOLD,
		percentage: calculateUsagePercentage(total, contextWindow),
	});
}

function toolResultMessage(tc: ToolCallInfo, value: string): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: tc.toolCallId,
				toolName: tc.toolName,
				output: { type: "text", value },
			},
		],
	};
}

export interface ToolResolution {
	toolMessages: ModelMessage[];
	rejected: boolean;
}

/**
 * Ask approval (skipping read-only tools) and execute each pending tool
 * call in order. Pulled out of runAgent's main loop as its own function —
 * this is the seam that makes approval/rejection sequencing directly
 * testable with a fake approval callback and a fake executor, without
 * touching streamText at all.
 *
 * Once one call is declined, every remaining call in the batch is recorded
 * as declined too, without re-prompting — the API requires a paired tool
 * result for every tool call, and re-prompting after a "no" would just be
 * fatigue for no benefit. This is the loop's only termination flag; it also
 * tells the caller to end the outer turn.
 */
export async function resolveToolCalls(
	toolCalls: ToolCallInfo[],
	executableTools: ToolSet,
	baseMessages: ModelMessage[],
	callbacks: Pick<AgentCallbacks, "onToolApproval" | "onToolCallEnd">,
	reportUsage: (currentMessages: ModelMessage[]) => void,
): Promise<ToolResolution> {
	const toolMessages: ModelMessage[] = [];
	let rejected = false;

	for (const tc of toolCalls) {
		const approved = READ_ONLY_TOOLS.has(tc.toolName)
			? true
			: rejected
				? false
				: await callbacks.onToolApproval(tc.toolName, tc.args);

		if (!approved) {
			rejected = true;
			const declined = "The user declined to run this tool.";
			toolMessages.push(toolResultMessage(tc, declined));
			callbacks.onToolCallEnd(tc.toolCallId, declined);
			continue;
		}

		const toolResult = await executeTool(tc.toolName, tc.args, executableTools);
		callbacks.onToolCallEnd(tc.toolCallId, toolResult);
		toolMessages.push(toolResultMessage(tc, toolResult));
		reportUsage([...baseMessages, ...toolMessages]);
	}

	return { toolMessages, rejected };
}

/**
 * Run one agent turn.
 *
 * Returns the conversation history WITHOUT the system prompt — runAgent owns
 * the system prompt and prepends it on every call, so callers must store and
 * pass back only the conversation.
 */
export async function runAgent(
	userMessage: string,
	conversationHistory: ModelMessage[],
	callbacks: AgentCallbacks,
	options: RunAgentOptions = {},
): Promise<ModelMessage[]> {
	const modelId = options.model ?? DEFAULT_MODEL;
	const languageModel = options.languageModel ?? resolveModel(modelId);
	const executableTools = options.tools ?? defaultTools;
	const modelTools = toModelTools(executableTools);
	const systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
	const telemetryEnabled = options.telemetry ?? true;

	const modelLimits = getModelLimits(modelId);
	const contextWindow = modelLimits.contextWindow;

	// Filter history, then compact if adding this turn would exceed the threshold.
	let workingHistory = filterCompatibleMessages(conversationHistory);
	const preCheckTokens = estimateMessagesTokens([
		{ role: "system", content: systemPrompt },
		...workingHistory,
		{ role: "user", content: userMessage },
	]);

	if (isOverThreshold(preCheckTokens.total, contextWindow)) {
		workingHistory = await compactConversation(workingHistory, modelId);
	}

	// The system prompt is passed to the model via the dedicated `system` option
	// (below), not embedded in `messages` — embedding it triggers an SDK warning
	// and is a prompt-injection risk.
	const messages: ModelMessage[] = [
		...workingHistory,
		{ role: "user", content: userMessage },
	];

	let fullResponse = "";

	const appendResponseText = (text: string) => {
		if (!text) return;
		fullResponse += fullResponse ? `\n\n${text}` : text;
	};

	const reportUsage = (real?: UsageReport) =>
		reportTokenUsage(callbacks, systemPrompt, messages, contextWindow, real);

	reportUsage();

	while (true) {
		const result = streamText({
			model: languageModel,
			system: systemPrompt,
			messages,
			tools: modelTools,
			...(telemetryEnabled && {
				experimental_telemetry: {
					isEnabled: true,
					// The AI SDK records full prompts/tool args/results onto spans by
					// default — meaning file contents, shell output, etc. would ship
					// to Laminar's cloud once LMNR_API_KEY is set. Keep spans (useful
					// for timing/flow) but not their content, unless explicitly opted
					// into via TOOLWRIGHT_TELEMETRY_RECORD_IO=1.
					recordInputs: RECORD_TELEMETRY_IO,
					recordOutputs: RECORD_TELEMETRY_IO,
					tracer: getTracer(),
				},
			}),
		});

		const toolCalls: ToolCallInfo[] = [];
		let currentText = "";
		let streamError: Error | null = null;

		try {
			for await (const chunk of result.fullStream) {
				if (chunk.type === "text-delta") {
					currentText += chunk.text;
					callbacks.onToken(chunk.text);
				}

				if (chunk.type === "tool-call") {
					const input = "input" in chunk ? chunk.input : {};
					toolCalls.push({
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						args: input as Record<string, unknown>,
					});
					callbacks.onToolCallStart(chunk.toolName, input, chunk.toolCallId);
				}
			}
		} catch (error) {
			streamError = error as Error;
			// Rethrow only if we got nothing usable and it isn't the benign
			// "no output generated" case we know how to recover from.
			if (
				!currentText &&
				!streamError.message.includes("No output generated")
			) {
				throw streamError;
			}
		}

		// If the stream errored, end the turn gracefully: keep whatever text we
		// have (or a fallback) and record it in history so the UI and the model
		// see the same thing. Awaiting finishReason/response here could reject.
		if (streamError) {
			const text = currentText || NO_RESPONSE_FALLBACK;
			if (!currentText) {
				callbacks.onToken(text);
			}
			appendResponseText(text);
			messages.push({ role: "assistant", content: text });
			reportUsage();
			break;
		}

		appendResponseText(currentText);

		const finishReason = await result.finishReason;
		const responseMessages = await result.response;
		messages.push(...responseMessages.messages);
		reportUsage(await result.usage);

		if (finishReason !== "tool-calls" || toolCalls.length === 0) {
			break;
		}

		const { toolMessages, rejected } = await resolveToolCalls(
			toolCalls,
			executableTools,
			messages,
			callbacks,
			(current) =>
				reportTokenUsage(callbacks, systemPrompt, current, contextWindow),
		);
		messages.push(...toolMessages);

		if (rejected) {
			break;
		}
	}

	callbacks.onComplete(fullResponse);

	// Return history without the system prompt; runAgent re-adds it next turn.
	return messages.filter((m) => m.role !== "system");
}
