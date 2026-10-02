import { type ModelMessage, streamText } from "ai";
import { resolveProvider } from "../providers/resolve.ts";
import { inferenceTelemetry } from "../providers/telemetry.ts";
import { Workspace } from "../workspace/workspace.ts";
import { TokenBudget, TokenBudgetExceeded } from "./context/budget.ts";
import { prepareRequestContext } from "./context/request.ts";
import { estimateToolSchemaTokens } from "./context/schemaTokens.ts";
import { estimateMessagesTokens } from "./context/tokenEstimator.ts";
import { reportTokenUsage } from "./context/usage.ts";
import { hasFailedCommands, ToolFailureTracker } from "./execution/failures.ts";
import { ExecutionPolicy } from "./execution/policy.ts";
import { resolveToolCalls } from "./execution/resolveToolCalls.ts";
import {
	filterCompatibleMessages,
	portableHistory,
} from "./history/filterMessages.ts";
import { getSystemPrompt } from "./prompt.ts";
import { collectModelStream } from "./stream.ts";
import {
	createTools,
	selectProviderTools,
	toModelTools,
} from "./tools/index.ts";
import type { AgentCallbacks, RunAgentOptions, RunOutcome } from "./types.ts";

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
	const budget = new TokenBudget(options.maxTokens ?? 200000);
	const maxFailures = options.maxFailures ?? 3;
	const timeout = AbortSignal.timeout(options.maxTurnMs ?? 600000);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout])
		: timeout;
	const schemaCost = estimateToolSchemaTokens(modelTools);
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
	let completedTools = 0;
	let outcome: RunOutcome["status"] = "success";
	let reason = "Completed";
	let thrown: unknown;
	const failures = new ToolFailureTracker();
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
			if (steps >= maxSteps || budget.exhausted) {
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
			const context = await prepareRequestContext(messages, {
				systemPrompt,
				provider: { ...provider, languageModel },
				schemaTokens: schemaCost,
				budget,
				signal,
				telemetry: options.telemetry,
			});
			messages = context.messages;
			if (context.kind === "limited") {
				outcome = "limited";
				reason = context.reason;
				break;
			}
			const { inputBudget, maxOutputTokens } = context;
			reportTokenUsage(callbacks, systemPrompt, messages, limits.contextWindow);
			const result = streamText({
				model: languageModel,
				instructions: systemPrompt,
				messages,
				tools: modelTools,
				maxOutputTokens,
				abortSignal: signal,
				maxRetries: completedTools > 0 ? 0 : 1,
				onError: () => {},
				telemetry: inferenceTelemetry(provider.settings, options.telemetry),
			});
			steps++;
			const { toolCalls, text } = await collectModelStream(
				result.stream,
				callbacks,
				signal,
			);
			const finishReason = await result.finishReason;
			messages.push(...(await result.response).messages);
			response += text ? (response ? "\n\n" : "") + text : "";
			const usage = await result.usage;
			budget.recordRequest(
				usage.totalTokens ??
					estimateMessagesTokens([
						{ role: "system", content: systemPrompt },
						...messages,
					]).total,
			);
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
			failures.record(toolCalls, resolved.failures);
			if (resolved.rejected) {
				outcome = "approval-blocked";
				reason = "A required tool was denied by policy or user approval";
				break;
			}
			if (failures.hasRepeatedFailures(maxFailures)) {
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
	if (outcome === "success" && failures.unresolvedTools.length) {
		outcome = "failed";
		reason = `Unresolved tool failures: ${failures.unresolvedTools.join(", ")}`;
	}
	if (
		outcome === "success" &&
		workspace &&
		hasFailedCommands(workspace.commands)
	) {
		outcome = "failed";
		reason = "An executed command/check has an unresolved failure";
	}
	messages = filterCompatibleMessages(messages);
	await callbacks.onOutcome?.({
		status: outcome,
		reason,
		steps,
		totalTokens: budget.totalTokens,
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
