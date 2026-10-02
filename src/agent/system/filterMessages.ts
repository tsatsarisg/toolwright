import type { ModelMessage } from "ai";

/** Common text/tool history for switching models or API protocols. */
export function portableHistory(messages: ModelMessage[]): ModelMessage[] {
	return filterCompatibleMessages(
		messages.map((message) => {
			const { providerOptions: _options, ...clean } = message;
			if (!Array.isArray(message.content)) return clean as ModelMessage;
			const content = message.content
				.filter((part) => {
					const view = part as { type: string; providerExecuted?: boolean };
					if (message.role === "assistant")
						return (
							["text", "tool-call"].includes(view.type) &&
							!view.providerExecuted
						);
					return true;
				})
				.map((part) => {
					const {
						providerOptions: _partOptions,
						providerMetadata: _metadata,
						...value
					} = part as unknown as Record<string, unknown>;
					return value;
				});
			return { ...clean, content } as unknown as ModelMessage;
		}),
	);
}

/** Loose view of a content part; the SDK's union types don't expose every
 * field on every member, so we read fields defensively through this. */
type LoosePart = { type?: string; toolCallId?: string; text?: string };

function asPart(part: unknown): LoosePart {
	return (part ?? {}) as LoosePart;
}

function collectIds(messages: ModelMessage[]) {
	const callIds = new Set<string>();
	const resultIds = new Set<string>();

	for (const msg of messages) {
		if (!Array.isArray(msg.content)) continue;
		for (const raw of msg.content) {
			const part = asPart(raw);
			if (typeof part.toolCallId !== "string") continue;
			if (part.type === "tool-call") callIds.add(part.toolCallId);
			if (part.type === "tool-result") resultIds.add(part.toolCallId);
		}
	}

	return { callIds, resultIds };
}

/**
 * Filter conversation history so it stays valid to replay to the model.
 *
 * Two invariants are enforced:
 *  - The system prompt is owned by runAgent, so any system messages carried in
 *    history are dropped here (prevents them accumulating turn over turn).
 *  - Tool calls and tool results are kept as atomic pairs: a `tool-call` part is
 *    only kept if a matching `tool-result` exists, and vice versa. This prevents
 *    orphaned tool results/calls, which the API rejects with a 400.
 */
export const filterCompatibleMessages = (
	messages: ModelMessage[],
): ModelMessage[] => {
	const { callIds, resultIds } = collectIds(messages);
	const result: ModelMessage[] = [];

	for (const msg of messages) {
		if (msg.role === "system") {
			continue;
		}

		if (msg.role === "user") {
			result.push(msg);
			continue;
		}

		if (msg.role === "assistant") {
			if (typeof msg.content === "string") {
				if (msg.content.trim()) result.push(msg);
				continue;
			}
			if (Array.isArray(msg.content)) {
				const parts = msg.content.filter((raw) => {
					const part = asPart(raw);
					if (part.type === "tool-call") {
						// Keep only calls that have a matching result.
						return (
							typeof part.toolCallId === "string" &&
							resultIds.has(part.toolCallId)
						);
					}
					if (part.type === "text") {
						return typeof part.text === "string" && part.text.trim().length > 0;
					}
					// Preserve other part kinds (reasoning, file, provider tool-result).
					return true;
				});
				if (parts.length > 0) {
					result.push({ ...msg, content: parts } as ModelMessage);
				}
			}
			continue;
		}

		if (msg.role === "tool") {
			if (!Array.isArray(msg.content)) continue;
			const parts = msg.content.filter((raw) => {
				const part = asPart(raw);
				if (part.type !== "tool-result") return true;
				// Keep only results whose originating call survives.
				return (
					typeof part.toolCallId === "string" && callIds.has(part.toolCallId)
				);
			});
			if (parts.length > 0) {
				result.push({ ...msg, content: parts } as ModelMessage);
			}
		}
	}

	return result;
};
