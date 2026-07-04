import { streamText, type ModelMessage, type ToolSet } from "ai";
import { openai } from "@ai-sdk/openai";
import { getTracer } from "@lmnr-ai/lmnr";
import { tools as defaultTools, toModelTools } from "./tools/index.ts";
import { executeTool } from "./executeTool.ts";
import { SYSTEM_PROMPT } from "./system/prompt.ts";
import type { AgentCallbacks, ToolCallInfo } from "../types.ts";
import {
  estimateMessagesTokens,
  getModelLimits,
  isOverThreshold,
  calculateUsagePercentage,
  compactConversation,
  DEFAULT_THRESHOLD,
} from "./context/index.ts";
import { filterCompatibleMessages } from "./system/filterMessages.ts";

const DEFAULT_MODEL = "gpt-5-mini";

const NO_RESPONSE_FALLBACK =
  "I apologize, but I wasn't able to generate a response. Could you please try rephrasing your message?";

export interface RunAgentOptions {
  /** Model id to use (default: gpt-5-mini). */
  model?: string;
  /** Executable toolset; the model is shown an execute-less view of it. */
  tools?: ToolSet;
  /** System prompt (default: the app's SYSTEM_PROMPT). */
  systemPrompt?: string;
  /** Emit Laminar telemetry spans (default: true). Off for tests/evals. */
  telemetry?: boolean;
}

/**
 * Run one agent turn.
 *
 * Returns the conversation history WITHOUT the system prompt — runAgent owns
 * the system prompt and prepends it on every call, so callers must store and
 * pass back only the conversation.
 */
export async function runAgent(
  userMessage: string,
  conversationHistory: ModelMessage[],
  callbacks: AgentCallbacks,
  options: RunAgentOptions = {},
): Promise<ModelMessage[]> {
  const model = options.model ?? DEFAULT_MODEL;
  const executableTools = options.tools ?? defaultTools;
  const modelTools = toModelTools(executableTools);
  const systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
  const telemetryEnabled = options.telemetry ?? true;

  const modelLimits = getModelLimits(model);
  const contextWindow = modelLimits.contextWindow;

  // Filter history, then compact if adding this turn would exceed the threshold.
  let workingHistory = filterCompatibleMessages(conversationHistory);
  const preCheckTokens = estimateMessagesTokens([
    { role: "system", content: systemPrompt },
    ...workingHistory,
    { role: "user", content: userMessage },
  ]);

  if (isOverThreshold(preCheckTokens.total, contextWindow)) {
    workingHistory = await compactConversation(workingHistory, model);
  }

  // The system prompt is passed to the model via the dedicated `system` option
  // (below), not embedded in `messages` — embedding it triggers an SDK warning
  // and is a prompt-injection risk.
  const messages: ModelMessage[] = [
    ...workingHistory,
    { role: "user", content: userMessage },
  ];

  let fullResponse = "";

  const appendResponseText = (text: string) => {
    if (!text) return;
    fullResponse += fullResponse ? `\n\n${text}` : text;
  };

  const reportTokenUsage = (real?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  }) => {
    if (!callbacks.onTokenUsage) return;

    let input: number;
    let output: number;
    let total: number;

    if (real && (real.totalTokens ?? 0) > 0) {
      // Prefer the provider's actual counts when we have them.
      input = real.inputTokens ?? 0;
      output = real.outputTokens ?? 0;
      total = real.totalTokens ?? input + output;
    } else {
      // Include the system prompt (sent via the `system` option, not in
      // `messages`) so the estimate reflects the full request.
      const est = estimateMessagesTokens([
        { role: "system", content: systemPrompt },
        ...messages,
      ]);
      input = est.input;
      output = est.output;
      total = est.total;
    }

    callbacks.onTokenUsage({
      inputTokens: input,
      outputTokens: output,
      totalTokens: total,
      contextWindow,
      threshold: DEFAULT_THRESHOLD,
      percentage: calculateUsagePercentage(total, contextWindow),
    });
  };

  reportTokenUsage();

  while (true) {
    const result = streamText({
      model: openai(model),
      system: systemPrompt,
      messages,
      tools: modelTools,
      ...(telemetryEnabled && {
        experimental_telemetry: {
          isEnabled: true,
          tracer: getTracer(),
        },
      }),
    });

    const toolCalls: ToolCallInfo[] = [];
    let currentText = "";
    let streamError: Error | null = null;

    try {
      for await (const chunk of result.fullStream) {
        if (chunk.type === "text-delta") {
          currentText += chunk.text;
          callbacks.onToken(chunk.text);
        }

        if (chunk.type === "tool-call") {
          const input = "input" in chunk ? chunk.input : {};
          toolCalls.push({
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            args: input as Record<string, unknown>,
          });
          callbacks.onToolCallStart(chunk.toolName, input, chunk.toolCallId);
        }
      }
    } catch (error) {
      streamError = error as Error;
      // Rethrow only if we got nothing usable and it isn't the benign
      // "no output generated" case we know how to recover from.
      if (
        !currentText &&
        !streamError.message.includes("No output generated")
      ) {
        throw streamError;
      }
    }

    // If the stream errored, end the turn gracefully: keep whatever text we
    // have (or a fallback) and record it in history so the UI and the model
    // see the same thing. Awaiting finishReason/response here could reject.
    if (streamError) {
      const text = currentText || NO_RESPONSE_FALLBACK;
      if (!currentText) {
        callbacks.onToken(text);
      }
      appendResponseText(text);
      messages.push({ role: "assistant", content: text });
      reportTokenUsage();
      break;
    }

    appendResponseText(currentText);

    const finishReason = await result.finishReason;
    const responseMessages = await result.response;
    messages.push(...responseMessages.messages);
    reportTokenUsage(await result.usage);

    if (finishReason !== "tool-calls" || toolCalls.length === 0) {
      break;
    }

    // Process tool calls sequentially with approval for each.
    let rejected = false;
    for (const tc of toolCalls) {
      // After a rejection, stop prompting but still record a result for every
      // remaining call — the API requires each tool call to have a paired
      // tool result.
      const approved = rejected
        ? false
        : await callbacks.onToolApproval(tc.toolName, tc.args);

      if (!approved) {
        rejected = true;
        const declined = "The user declined to run this tool.";
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              output: { type: "text", value: declined },
            },
          ],
        });
        callbacks.onToolCallEnd(tc.toolCallId, declined);
        continue;
      }

      const toolResult = await executeTool(
        tc.toolName,
        tc.args,
        executableTools,
      );
      callbacks.onToolCallEnd(tc.toolCallId, toolResult);

      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            output: { type: "text", value: toolResult },
          },
        ],
      });
      reportTokenUsage();
    }

    if (rejected) {
      break;
    }
  }

  callbacks.onComplete(fullResponse);

  // Return history without the system prompt; runAgent re-adds it next turn.
  return messages.filter((m) => m.role !== "system");
}
