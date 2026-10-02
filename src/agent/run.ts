import {
	type LanguageModel,
	type ModelMessage,
	streamText,
	type ToolSet,
} from "ai";
import { z } from "zod";
import type {
	AgentCallbacks,
	RunOutcome,
	TokenUsageInfo,
	ToolCallInfo,
} from "../types.ts";
import type { ProviderSelection } from "./config.ts";
import {
	compactConversation,
	defaultSummarizer,
} from "./context/compaction.ts";
import {
	calculateUsagePercentage,
	DEFAULT_THRESHOLD,
} from "./context/modelLimits.ts";
import {
	estimateMessagesTokens,
	estimateTokens,
} from "./context/tokenEstimator.ts";
import { executeTool } from "./executeTool.ts";
import { type ResolvedProvider, resolveProvider } from "./model.ts";
import { ExecutionPolicy, type PermissionMode } from "./policy.ts";
import {
	filterCompatibleMessages,
	portableHistory,
} from "./system/filterMessages.ts";
import { getSystemPrompt } from "./system/prompt.ts";
import { inferenceTelemetry } from "./telemetry.ts";
import {
	createTools,
	selectProviderTools,
	toModelTools,
} from "./tools/index.ts";
import { truncateOutput } from "./tools/truncate.ts";
import { Workspace } from "./workspace.ts";

export interface RunAgentOptions extends ProviderSelection {
	resolvedProvider?: ResolvedProvider;
	languageModel?: LanguageModel;
	tools?: ToolSet;
	systemPrompt?: string;
	telemetry?: boolean;
	workspace?: Workspace;
	policy?: ExecutionPolicy;
	mode?: PermissionMode;
	signal?: AbortSignal;
	maxSteps?: number;
	maxTokens?: number;
	maxTurnMs?: number;
	maxFailures?: number;
}
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
function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return pending;
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		pending
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}
export interface ToolResolution {
	toolMessages: ModelMessage[];
	rejected: boolean;
	failures: string[];
}
export async function resolveToolCalls(
	toolCalls: ToolCallInfo[],
	executableTools: ToolSet,
	baseMessages: ModelMessage[],
	callbacks: Pick<
		AgentCallbacks,
		"onToolApproval" | "onToolCallEnd" | "onCheckpoint"
	>,
	reportUsage: (messages: ModelMessage[]) => void,
	options: {
		policy?: ExecutionPolicy;
		workspace?: Workspace;
		signal?: AbortSignal;
		maxChars?: number;
		instructionContext?: string;
	} = {},
): Promise<ToolResolution> {
	const toolMessages: ModelMessage[] = [];
	const failures: string[] = [];
	const policy = options.policy ?? new ExecutionPolicy();
	let rejected = false;
	for (const tc of toolCalls) {
		let result: string;
		try {
			options.signal?.throwIfAborted();
			const definition = Object.hasOwn(executableTools, tc.toolName)
				? executableTools[tc.toolName]
				: undefined;
			if (!definition) {
				result = `Tool unavailable for this provider or policy: ${tc.toolName}`;
				rejected = true;
			} else if (rejected) result = "The user declined to run this tool.";
			else {
				const parsed = (
					definition.inputSchema as z.ZodType | undefined
				)?.safeParse(tc.args);
				if (parsed && !parsed.success)
					result = `Invalid arguments for ${tc.toolName}: ${parsed.error.message}`;
				else {
					const args = (parsed?.data ?? tc.args) as Record<string, unknown>;
					const authorization = await policy.decide(
						tc.toolName,
						args,
						executableTools,
						options.workspace,
					);
					if (authorization?.decision === "deny") {
						result = `Policy denied ${tc.toolName} in ${options.policy?.mode} mode.`;
						rejected = true;
					} else {
						const mutation =
							options.workspace &&
							["writeFile", "editFile", "deleteFile"].includes(tc.toolName)
								? await options.workspace.prepare(
										tc.toolName,
										args,
										options.signal,
									)
								: undefined;
						const guidance = mutation
							? await options.workspace?.instructions(options.signal)
							: undefined;
						if (
							guidance !== undefined &&
							options.instructionContext !== undefined &&
							guidance !== options.instructionContext
						) {
							result =
								"Additional scoped project instructions were discovered. Review the refreshed guidance before requesting this edit again.";
						} else {
							if (authorization)
								authorization.details.preview = mutation?.preview;
							const auto = authorization.decision === "allow";
							const approved =
								auto ||
								(await abortable(
									callbacks.onToolApproval(
										tc.toolName,
										args,
										authorization?.details,
									),
									options.signal,
								));
							options.signal?.throwIfAborted();
							if (!approved) {
								rejected = true;
								result = "The user declined to run this tool.";
							} else
								result =
									mutation && options.workspace
										? await options.workspace.apply(mutation, options.signal)
										: await executeTool(
												tc.toolName,
												args,
												executableTools,
												options.signal,
											);
						}
					}
				}
			}
		} catch (error) {
			if (options.signal?.aborted) {
				for (const remaining of toolCalls.slice(toolMessages.length)) {
					const cancelled =
						"Tool interrupted; it will not be replayed automatically.";
					toolMessages.push(toolResultMessage(remaining, cancelled));
					callbacks.onToolCallEnd(remaining.toolCallId, cancelled);
				}
				await callbacks.onCheckpoint?.(
					filterCompatibleMessages([...baseMessages, ...toolMessages]),
				);
				return { toolMessages, rejected: true, failures };
			}
			result = `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (/^(Error:|Invalid arguments|Unknown tool)/.test(result))
			failures.push(tc.toolName);
		result = boundedToolResult(tc.toolName, result, options.maxChars ?? 16000);
		toolMessages.push(toolResultMessage(tc, result));
		callbacks.onToolCallEnd(tc.toolCallId, result);
		reportUsage([...baseMessages, ...toolMessages]);
		await callbacks.onCheckpoint?.(
			filterCompatibleMessages([...baseMessages, ...toolMessages]),
		);
	}
	return { toolMessages, rejected, failures };
}

function schemaTokens(tools: ToolSet): number {
	return estimateTokens(
		JSON.stringify(
			Object.entries(tools).map(([name, definition]) => {
				let schema: unknown;
				try {
					schema = z.toJSONSchema(definition.inputSchema as z.ZodType);
				} catch {
					schema = {};
				}
				return { name, description: definition.description, schema };
			}),
		),
	);
}

class TokenBudgetExceeded extends Error {}

function boundedToolResult(
	name: string,
	result: string,
	maxChars: number,
): string {
	if (name === "runCommand") {
		try {
			const command = JSON.parse(result);
			if (
				typeof command.stdout === "string" &&
				typeof command.stderr === "string"
			) {
				return JSON.stringify({
					...command,
					stdout: truncateOutput(command.stdout, Math.floor(maxChars / 3)),
					stderr: truncateOutput(command.stderr, Math.floor(maxChars / 3)),
				});
			}
		} catch {
			/* Validation and execution errors are plain text. */
		}
	}
	return truncateOutput(result, maxChars);
}

export async function runAgent(
	userMessage: string,
	conversationHistory: ModelMessage[],
	callbacks: AgentCallbacks,
	options: RunAgentOptions = {},
): Promise<ModelMessage[]> {
	const started = Date.now();
	const provider = options.resolvedProvider ?? resolveProvider(options);
	const languageModel = options.languageModel ?? provider.languageModel;
	const workspace =
		options.workspace ?? (options.tools ? undefined : await Workspace.open());
	const policy = options.policy ?? new ExecutionPolicy(options.mode ?? "edit");
	const executableTools = selectProviderTools(
		provider.settings,
		options.tools ??
			(workspace ? createTools(workspace, callbacks.onCommandOutput) : {}),
	);
	if (policy.mode === "plan") delete executableTools.webSearch;
	const modelTools = toModelTools(executableTools);
	const limits = provider.limits;
	const maxSteps = options.maxSteps ?? 40;
	const maxTokens = options.maxTokens ?? 200000;
	const maxFailures = options.maxFailures ?? 3;
	const timeout = AbortSignal.timeout(options.maxTurnMs ?? 600000);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout])
		: timeout;
	const schemaCost = schemaTokens(modelTools);
	let messages: ModelMessage[] = [
		...filterCompatibleMessages(
			provider.settings.api === "chat-completions"
				? portableHistory(conversationHistory)
				: conversationHistory,
		),
		{ role: "user", content: userMessage },
	];
	let response = "";
	let steps = 0;
	let totalTokens = 0;
	let completedTools = 0;
	let outcome: RunOutcome["status"] = "success";
	let reason = "Completed";
	let thrown: unknown;
	const failureCounts = new Map<string, number>();
	const unresolved = new Set<string>();
	const checkpoint = async (history: ModelMessage[] = messages) => {
		await callbacks.onCheckpoint?.(filterCompatibleMessages(history));
	};
	try {
		if (!provider.settings.capabilities.streaming)
			throw new Error(
				"This profile does not support streaming required by the agent.",
			);
		// Text-only sessions prevent the SDK from fetching remote image/file URLs in strict local-only mode.
		if (
			provider.settings.localOnly &&
			messages.some(
				(m) =>
					Array.isArray(m.content) &&
					m.content.some((p) => p.type === "image" || p.type === "file"),
			)
		)
			throw new Error(
				"Local-only sessions accept text and local tool results; external media inputs are unavailable.",
			);
		while (true) {
			signal.throwIfAborted();
			if (steps >= maxSteps || totalTokens >= maxTokens) {
				outcome = "limited";
				reason =
					steps >= maxSteps
						? "Maximum model steps reached"
						: "Cumulative token budget reached";
				break;
			}
			let instructions = (await workspace?.instructions(signal)) ?? "";
			const systemPrompt =
				(options.systemPrompt ??
					getSystemPrompt(Object.keys(executableTools))) +
				instructions +
				`\nPermission mode: ${policy.mode}.\nWorkspace: ${workspace?.root ?? "injected tools"}.\nActual runtime state: ${workspace?.report() ?? "No workspace changes tracked."}`;
			const cost = () =>
				estimateMessagesTokens([
					{ role: "system", content: systemPrompt },
					...messages,
				]).total + schemaCost;
			const inputBudget = Math.min(
				limits.inputLimit,
				Math.floor(limits.contextWindow * 0.8),
			);
			if (cost() > inputBudget) {
				messages = await compactConversation(
					messages,
					{ ...provider, languageModel },
					defaultSummarizer(
						{ ...provider, languageModel },
						signal,
						(tokens) => {
							totalTokens += tokens;
							if (totalTokens >= maxTokens)
								throw new TokenBudgetExceeded(
									"Cumulative token budget reached during compaction.",
								);
						},
						(reserved) => {
							if (reserved > maxTokens - totalTokens)
								throw new TokenBudgetExceeded(
									"Cumulative token budget cannot fit compaction.",
								);
						},
						options.telemetry,
					),
					{ includeCurrentTurn: true },
				);
				if (cost() > inputBudget) {
					outcome = "limited";
					reason =
						"Context limit: retained intent, instructions, tool schemas and recent state cannot fit. Narrow the task or use a larger context.";
					break;
				}
			}
			const remainingOutput = maxTokens - totalTokens - cost();
			if (remainingOutput < 1)
				throw new TokenBudgetExceeded(
					"Cumulative token budget cannot fit the next request.",
				);
			reportTokenUsage(callbacks, systemPrompt, messages, limits.contextWindow);
			const result = streamText({
				model: languageModel,
				instructions: systemPrompt,
				messages,
				tools: modelTools,
				maxOutputTokens: Math.min(limits.outputLimit, remainingOutput),
				abortSignal: signal,
				maxRetries: completedTools > 0 ? 0 : 1,
				onError: () => {},
				telemetry: inferenceTelemetry(provider.settings, options.telemetry),
			});
			steps++;
			const toolCalls: ToolCallInfo[] = [];
			let text = "";
			for await (const chunk of result.stream) {
				signal.throwIfAborted();
				if (chunk.type === "error") throw chunk.error;
				if (chunk.type === "text-delta") {
					text += chunk.text;
					callbacks.onToken(chunk.text);
				}
				if (chunk.type === "tool-call" && !chunk.providerExecuted) {
					const args =
						chunk.input && typeof chunk.input === "object"
							? (chunk.input as Record<string, unknown>)
							: {};
					toolCalls.push({
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						args,
					});
					callbacks.onToolCallStart(chunk.toolName, args, chunk.toolCallId);
				}
			}
			const finishReason = await result.finishReason;
			messages.push(...(await result.response).messages);
			response += text ? (response ? "\n\n" : "") + text : "";
			const usage = await result.usage;
			totalTokens +=
				usage.totalTokens ??
				estimateMessagesTokens([
					{ role: "system", content: systemPrompt },
					...messages,
				]).total;
			reportTokenUsage(
				callbacks,
				systemPrompt,
				messages,
				limits.contextWindow,
				usage,
			);
			if (!toolCalls.length) {
				if (finishReason === "error" || finishReason === "other") {
					outcome = "failed";
					reason = `Model stopped with ${finishReason} finish reason`;
				}
				if (finishReason === "length") {
					outcome = "limited";
					reason = "Model output limit reached";
				}
				break;
			}
			// Refresh guidance discovered from tool paths before the next request. Mutations wait for the model to see it.
			instructions = (await workspace?.instructions(signal)) ?? instructions;
			const resolved = await resolveToolCalls(
				toolCalls,
				executableTools,
				messages,
				callbacks,
				(current) =>
					reportTokenUsage(
						callbacks,
						systemPrompt,
						current,
						limits.contextWindow,
					),
				{
					policy,
					workspace,
					signal,
					maxChars: Math.min(
						12000,
						Math.max(256, Math.floor(inputBudget * 0.8)),
					),
					instructionContext: instructions,
				},
			);
			messages.push(...resolved.toolMessages);
			signal.throwIfAborted();
			completedTools += toolCalls.length;
			for (const call of toolCalls) {
				if (resolved.failures.includes(call.toolName)) {
					unresolved.add(call.toolName);
					const key = JSON.stringify([call.toolName, call.args]);
					failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
				} else {
					unresolved.delete(call.toolName);
					failureCounts.delete(JSON.stringify([call.toolName, call.args]));
				}
			}
			if (resolved.rejected) {
				outcome = "approval-blocked";
				reason = "A required tool was denied by policy or user approval";
				break;
			}
			if ([...failureCounts.values()].some((count) => count >= maxFailures)) {
				outcome = "limited";
				reason = "Repeated identical tool failures";
				break;
			}
			await checkpoint();
		}
	} catch (error) {
		if (signal.aborted) {
			outcome =
				timeout.aborted && !options.signal?.aborted ? "limited" : "cancelled";
			reason =
				outcome === "limited" ? "Turn time limit reached" : "Cancelled by user";
		} else if (error instanceof TokenBudgetExceeded) {
			outcome = "limited";
			reason = error.message;
		} else {
			outcome = "failed";
			reason = error instanceof Error ? error.message : String(error);
			thrown = error;
		}
	}
	if (outcome === "success" && unresolved.size) {
		outcome = "failed";
		reason = `Unresolved tool failures: ${[...unresolved].join(", ")}`;
	}
	if (outcome === "success" && workspace) {
		const latest = new Map(
			workspace.commands.map((command) => [command.command, command]),
		);
		if (
			[...latest.values()].some(
				(command) =>
					command.exitCode !== 0 || command.timedOut || command.overflowed,
			)
		) {
			outcome = "failed";
			reason = "An executed command/check has an unresolved failure";
		}
	}
	messages = filterCompatibleMessages(messages);
	await callbacks.onOutcome?.({
		status: outcome,
		reason,
		steps,
		totalTokens,
		durationMs: Date.now() - started,
	});
	await checkpoint();
	const report = workspace?.report();
	const finalText =
		response +
		(outcome !== "success" ? `\n\nStopped: ${reason}` : "") +
		(report ? `\n\n${report}` : "");
	callbacks.onComplete(finalText);
	if (thrown) throw thrown;
	return messages;
}
