import { generateText, type ModelMessage, stepCountIs, type ToolSet } from "ai";
import { DEFAULT_MODEL, resolveModel } from "../src/agent/model.ts";
import { SYSTEM_PROMPT } from "../src/agent/system/prompt.ts";
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
	const { system, messages } = buildMessages(data);

	// Filter to only tools specified in data
	const tools: ToolSet = {};
	for (const toolName of data.tools) {
		if (availableTools[toolName]) {
			tools[toolName] = availableTools[toolName];
		}
	}

	const result = await generateText({
		model: resolveModel(data.config?.model ?? DEFAULT_MODEL),
		system,
		messages,
		tools,
		stopWhen: stepCountIs(1), // Single step - just get tool selection
		temperature: data.config?.temperature ?? undefined,
	});

	// Extract tool calls from the result
	const toolCalls = (result.toolCalls ?? []).map((tc) => ({
		toolName: tc.toolName,
		args: "args" in tc ? tc.args : {},
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
	const tools = buildMockedTools(data.mockTools);

	// Separate the system prompt from the conversation so it can be passed via
	// the `system` option rather than embedded in `messages`.
	let system = SYSTEM_PROMPT;
	let messages: ModelMessage[];
	if (data.messages) {
		const systemMessage = data.messages.find((m) => m.role === "system");
		if (systemMessage && typeof systemMessage.content === "string") {
			system = systemMessage.content;
		}
		messages = data.messages.filter((m) => m.role !== "system");
	} else {
		messages = [{ role: "user", content: data.prompt! }];
	}

	const result = await generateText({
		model: resolveModel(data.config?.model ?? DEFAULT_MODEL),
		system,
		messages,
		tools,
		stopWhen: stepCountIs(data.config?.maxSteps ?? 20),
	});

	// Extract all tool calls in order from steps
	const allToolCalls: string[] = [];
	const steps = result.steps.map((step) => {
		const stepToolCalls = (step.toolCalls ?? []).map((tc) => {
			allToolCalls.push(tc.toolName);
			return {
				toolName: tc.toolName,
				args: "args" in tc ? tc.args : {},
			};
		});

		const stepToolResults = (step.toolResults ?? []).map((tr) => ({
			toolName: tr.toolName,
			result: "result" in tr ? tr.result : tr,
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
		text: result.text,
		steps,
		toolsUsed,
		toolCallOrder: allToolCalls,
	};
}
