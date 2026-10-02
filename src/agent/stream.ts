import type { TextStreamPart, ToolSet } from "ai";
import type { AgentCallbacks, ToolCallInfo } from "./types.ts";

export async function collectModelStream(
	stream: AsyncIterable<TextStreamPart<ToolSet>>,
	callbacks: Pick<AgentCallbacks, "onToken" | "onToolCallStart">,
	signal: AbortSignal,
): Promise<{ text: string; toolCalls: ToolCallInfo[] }> {
	const toolCalls: ToolCallInfo[] = [];
	let text = "";
	for await (const chunk of stream) {
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
	return { text, toolCalls };
}
