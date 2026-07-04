import { generateText, type ModelMessage } from "ai";
import { openai } from "@ai-sdk/openai";
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
function messagesToText(messages: ModelMessage[]): string {
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
 * We cut at the last user message: everything before it gets summarized, and
 * the last user turn (plus any assistant/tool exchange that followed) is kept
 * verbatim. Cutting on a user boundary guarantees we never split a
 * tool-call/tool-result pair, which would produce an invalid history.
 */
function findRecentBoundary(messages: ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return i;
    }
  }
  return messages.length;
}

/**
 * Compact a conversation by summarizing its older messages with an LLM.
 *
 * The most recent turn is the one the model needs verbatim, so only the older
 * tail is summarized. Returns:
 * - A single user message containing the summary
 * - The recent messages, unchanged
 *
 * The system prompt is prepended by the caller.
 */
export async function compactConversation(
  messages: ModelMessage[],
  model: string = "gpt-5-mini",
): Promise<ModelMessage[]> {
  // System messages are owned by the caller and handled separately.
  const conversationMessages = messages.filter((m) => m.role !== "system");

  if (conversationMessages.length === 0) {
    return [];
  }

  const boundary = findRecentBoundary(conversationMessages);
  const older = conversationMessages.slice(0, boundary);
  const recent = conversationMessages.slice(boundary);

  // Nothing old enough to summarize — leave the conversation as-is.
  if (older.length === 0) {
    return conversationMessages;
  }

  const { text: summary } = await generateText({
    model: openai(model),
    prompt: SUMMARIZATION_PROMPT + messagesToText(older),
  });

  return [
    {
      role: "user",
      content: `[CONVERSATION SUMMARY]\nThe following summarizes the earlier part of our conversation:\n\n${summary}`,
    },
    ...recent,
  ];
}
