import { generateText, isStepCount, type ModelMessage, type ToolSet } from "ai";
import { resolveProvider } from "../src/agent/model.ts";
import { getSystemPrompt } from "../src/agent/system/prompt.ts";
import { inferenceTelemetry } from "../src/agent/telemetry.ts";
import { selectProviderTools } from "../src/agent/tools/index.ts";
import type {
	EvalData,
	MultiTurnEvalData,
	MultiTurnResult,
	SingleTurnResult,
} from "./types.ts";
import { buildMessages, buildMockedTools } from "./utils.ts";

export async function singleTurnExecutor(
	data: EvalData,
	availableTools: ToolSet,
): Promise<SingleTurnResult> {
	const { messages } = buildMessages(data);
	const provider = resolveProvider(data.config);

	// Filter to only tools specified in data
	const tools: ToolSet = {};
	for (const toolName of data.tools) {
		if (availableTools[toolName]) {
			tools[toolName] = availableTools[toolName];
		}
	}

	const result = await generateText({
		model: provider.languageModel,
		telemetry: inferenceTelemetry(provider.settings),
		maxOutputTokens: provider.limits.outputLimit,
		instructions:
			data.systemPrompt ??
			getSystemPrompt(
				Object.keys(selectProviderTools(provider.settings, tools)),
			),
		messages,
		tools: selectProviderTools(provider.settings, tools),
		stopWhen: isStepCount(1), // Single step - just get tool selection
		temperature: data.config?.temperature ?? undefined,
	});

	// Extract tool calls from the result
	const toolCalls = (result.toolCalls ?? []).map((tc) => ({
		toolName: tc.toolName,
		args: tc.input,
	}));

	const toolNames = toolCalls.map((tc) => tc.toolName);

	return {
		toolCalls,
		toolNames,
		selectedAny: toolNames.length > 0,
	};
}

/**
 * Multi-turn executor with mocked tools.
 * Runs a complete agent loop with tools returning fixed values.
 */
export async function multiTurnWithMocks(
	data: MultiTurnEvalData,
): Promise<MultiTurnResult> {
	const provider = resolveProvider(data.config);
	const tools = selectProviderTools(
		provider.settings,
		buildMockedTools(data.mockTools),
	);

	// Separate the system prompt from the conversation so it can be passed via
	// the `instructions` option rather than embedded in `messages`.
	let system = getSystemPrompt(Object.keys(tools));
	let messages: ModelMessage[];
	if (data.messages) {
		const systemMessage = data.messages.find((m) => m.role === "system");
		if (systemMessage && typeof systemMessage.content === "string") {
			system = systemMessage.content;
		}
		messages = data.messages.filter((m) => m.role !== "system");
	} else {
		if (data.prompt === undefined)
			throw new Error("Evaluation requires a prompt or messages.");
		messages = [{ role: "user", content: data.prompt }];
	}

	const result = await generateText({
		model: provider.languageModel,
		telemetry: inferenceTelemetry(provider.settings),
		maxOutputTokens: provider.limits.outputLimit,
		instructions: system,
		messages,
		tools,
		stopWhen: isStepCount(data.config?.maxSteps ?? 20),
	});

	// Extract all tool calls in order from steps
	const allToolCalls: string[] = [];
	const steps = result.steps.map((step) => {
		const stepToolCalls = (step.toolCalls ?? []).map((tc) => {
			allToolCalls.push(tc.toolName);
			return {
				toolName: tc.toolName,
				args: tc.input,
			};
		});

		const stepToolResults = (step.toolResults ?? []).map((tr) => ({
			toolName: tr.toolName,
			result: tr.output,
		}));

		return {
			toolCalls: stepToolCalls.length > 0 ? stepToolCalls : undefined,
			toolResults: stepToolResults.length > 0 ? stepToolResults : undefined,
			text: step.text || undefined,
		};
	});

	// Extract unique tools used
	const toolsUsed = [...new Set(allToolCalls)];

	return {
		providerSelection: {
			profile: provider.settings.profile,
			model: provider.settings.model,
		},
		text: result.text,
		steps,
		toolsUsed,
		toolCallOrder: allToolCalls,
	};
}
