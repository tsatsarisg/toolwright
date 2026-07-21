import { generateText, type ModelMessage } from "ai";
import { DEFAULT_MODEL, resolveModel } from "../model.ts";
import { extractMessageText } from "./tokenEstimator.ts";

const SUMMARIZATION_PROMPT = `You are a conversation summarizer. Your task is to create a concise summary of the conversation so far that preserves:

1. Key decisions and conclusions reached
2. Important context and facts mentioned
3. Any pending tasks or questions
4. The overall goal of the conversation

Be concise but complete. The summary should allow the conversation to continue naturally.

Conversation to summarize:
`;

/**
 * Format messages array as readable text for summarization
 */
export function messagesToText(messages: ModelMessage[]): string {
	return messages
		.map((msg) => {
			const role = msg.role.toUpperCase();
			const content = extractMessageText(msg);
			return `[${role}]: ${content}`;
		})
		.join("\n\n");
}

/**
 * Find a safe boundary to keep the tail of the conversation intact.
 *
 * We cut at the last user message: everything before it is a candidate for
 * summarization, and the last user turn (plus any assistant/tool exchange
 * that followed) is kept verbatim. Cutting on a user boundary guarantees we
 * never split a tool-call/tool-result pair, which would produce an invalid
 * history.
 */
export function findRecentBoundary(messages: ModelMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			return i;
		}
	}
	return messages.length;
}

/**
 * Index of the first user message — the message that framed the session's
 * original task. Returns -1 if there is none.
 */
export function findTaskIndex(messages: ModelMessage[]): number {
	return messages.findIndex((m) => m.role === "user");
}

/** A function that turns a prompt into a summary. Swappable so compactConversation's orchestration is testable without a real model call. */
export type Summarizer = (prompt: string) => Promise<string>;

function defaultSummarizer(model: string): Summarizer {
	return async (prompt) => {
		const { text } = await generateText({ model: resolveModel(model), prompt });
		return text;
	};
}

/**
 * Compact a conversation by summarizing its middle with an LLM, while
 * pinning the original task message so it can never be summarized away.
 *
 * A long-running session risks losing the framing of what the user actually
 * asked for if compaction only looks at "recent vs. old" — a summarizer can
 * legitimately compress the opening request into something vaguer than the
 * model needs. Keeping message[0] (the first user turn) verbatim, alongside
 * a summary of everything between it and the recent tail, keeps that intent
 * anchored for the life of the session.
 *
 * Returns: [task, summary-of-the-middle, ...recent-messages-verbatim].
 */
export async function compactConversation(
	messages: ModelMessage[],
	model: string = DEFAULT_MODEL,
	summarize: Summarizer = defaultSummarizer(model),
): Promise<ModelMessage[]> {
	// System messages are owned by the caller and handled separately.
	const conversationMessages = messages.filter((m) => m.role !== "system");

	if (conversationMessages.length === 0) {
		return [];
	}

	const recentBoundary = findRecentBoundary(conversationMessages);
	const taskIndex = findTaskIndex(conversationMessages);

	// No task to pin, or the task IS the recent boundary — nothing old to compact.
	if (taskIndex < 0 || taskIndex >= recentBoundary) {
		return conversationMessages;
	}

	const task = conversationMessages[taskIndex];
	const recent = conversationMessages.slice(recentBoundary);
	const middle = [
		...conversationMessages.slice(0, taskIndex),
		...conversationMessages.slice(taskIndex + 1, recentBoundary),
	];

	// Only the pinned task precedes the recent tail — nothing to summarize.
	if (middle.length === 0) {
		return conversationMessages;
	}

	const summary = await summarize(
		SUMMARIZATION_PROMPT + messagesToText(middle),
	);

	return [
		task,
		{
			role: "user",
			content: `[CONVERSATION SUMMARY]\nThe following summarizes the earlier part of our conversation:\n\n${summary}`,
		},
		...recent,
	];
}
