import type { AgentCallbacks, ToolCallInfo } from "../../src/agent/types.ts";

/**
 * Fresh AgentCallbacks with tracking arrays for each test. Approval defaults
 * to "always approve" so tests that don't care about the approval path don't
 * have to wire it up.
 */
export function recordCallbacks(
	onToolApproval: AgentCallbacks["onToolApproval"] = async () => true,
) {
	const tokens: string[] = [];
	const toolStarts: ToolCallInfo[] = [];
	const toolEnds: Array<{ id: string; result: string }> = [];
	let completedText: string | null = null;

	const callbacks: AgentCallbacks = {
		onToken: (t) => tokens.push(t),
		onToolCallStart: (name, args, toolCallId) =>
			toolStarts.push({
				toolName: name,
				args: args as Record<string, unknown>,
				toolCallId,
			}),
		onToolCallEnd: (toolCallId, result) =>
			toolEnds.push({ id: toolCallId, result }),
		onComplete: (response) => {
			completedText = response;
		},
		onToolApproval,
	};

	return {
		callbacks,
		tokens,
		toolStarts,
		toolEnds,
		getCompleted: () => completedText,
	};
}
