import type { ModelMessage, ToolSet } from "ai";
import type { ZodType } from "zod";
import type { Workspace } from "../../workspace/workspace.ts";
import { filterCompatibleMessages } from "../history/filterMessages.ts";
import { truncateOutput } from "../tools/truncate.ts";
import type { AgentCallbacks, ToolCallInfo } from "../types.ts";
import { executeTool } from "./executeTool.ts";
import { ExecutionPolicy } from "./policy.ts";

type ToolCallbacks = Pick<
	AgentCallbacks,
	"onToolApproval" | "onToolCallEnd" | "onCheckpoint"
>;

interface ToolResolutionOptions {
	policy?: ExecutionPolicy;
	workspace?: Workspace;
	signal?: AbortSignal;
	maxChars?: number;
	instructionContext?: string;
}

export interface ToolResolution {
	toolMessages: ModelMessage[];
	rejected: boolean;
	failures: string[];
}

interface ToolCallResult {
	result: string;
	rejected: boolean;
}

function toolResultMessage(call: ToolCallInfo, value: string): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: call.toolCallId,
				toolName: call.toolName,
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

async function resolveToolCall(
	call: ToolCallInfo,
	executableTools: ToolSet,
	callbacks: ToolCallbacks,
	options: ToolResolutionOptions & { policy: ExecutionPolicy },
	rejected: boolean,
): Promise<ToolCallResult> {
	options.signal?.throwIfAborted();
	const definition = Object.hasOwn(executableTools, call.toolName)
		? executableTools[call.toolName]
		: undefined;
	if (!definition) {
		return {
			result: `Tool unavailable for this provider or policy: ${call.toolName}`,
			rejected: true,
		};
	}
	if (rejected) {
		return { result: "The user declined to run this tool.", rejected: true };
	}

	const parsed = (definition.inputSchema as ZodType | undefined)?.safeParse(
		call.args,
	);
	if (parsed && !parsed.success) {
		return {
			result: `Invalid arguments for ${call.toolName}: ${parsed.error.message}`,
			rejected: false,
		};
	}
	const args = (parsed?.data ?? call.args) as Record<string, unknown>;
	const authorization = await options.policy.decide(
		call.toolName,
		args,
		executableTools,
		options.workspace,
	);
	if (authorization.decision === "deny") {
		return {
			result: `Policy denied ${call.toolName} in ${options.policy.mode} mode.`,
			rejected: true,
		};
	}

	const mutation =
		options.workspace &&
		["writeFile", "editFile", "deleteFile"].includes(call.toolName)
			? await options.workspace.prepare(call.toolName, args, options.signal)
			: undefined;
	const guidance = mutation
		? await options.workspace?.instructions(options.signal)
		: undefined;
	if (
		guidance !== undefined &&
		options.instructionContext !== undefined &&
		guidance !== options.instructionContext
	) {
		return {
			result:
				"Additional scoped project instructions were discovered. Review the refreshed guidance before requesting this edit again.",
			rejected: false,
		};
	}

	authorization.details.preview = mutation?.preview;
	const approved =
		authorization.decision === "allow" ||
		(await abortable(
			callbacks.onToolApproval(call.toolName, args, authorization.details),
			options.signal,
		));
	options.signal?.throwIfAborted();
	if (!approved) {
		return { result: "The user declined to run this tool.", rejected: true };
	}
	const result =
		mutation && options.workspace
			? await options.workspace.apply(mutation, options.signal)
			: await executeTool(call.toolName, args, executableTools, options.signal);
	return { result, rejected: false };
}

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

export async function resolveToolCalls(
	toolCalls: ToolCallInfo[],
	executableTools: ToolSet,
	baseMessages: ModelMessage[],
	callbacks: ToolCallbacks,
	reportUsage: (messages: ModelMessage[]) => void,
	options: ToolResolutionOptions = {},
): Promise<ToolResolution> {
	const toolMessages: ModelMessage[] = [];
	const failures: string[] = [];
	const policy = options.policy ?? new ExecutionPolicy();
	let rejected = false;
	for (const call of toolCalls) {
		let result: string;
		try {
			const resolved = await resolveToolCall(
				call,
				executableTools,
				callbacks,
				{ ...options, policy },
				rejected,
			);
			result = resolved.result;
			rejected = resolved.rejected;
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
			failures.push(call.toolName);
		result = boundedToolResult(
			call.toolName,
			result,
			options.maxChars ?? 16000,
		);
		toolMessages.push(toolResultMessage(call, result));
		callbacks.onToolCallEnd(call.toolCallId, result);
		reportUsage([...baseMessages, ...toolMessages]);
		await callbacks.onCheckpoint?.(
			filterCompatibleMessages([...baseMessages, ...toolMessages]),
		);
	}
	return { toolMessages, rejected, failures };
}
