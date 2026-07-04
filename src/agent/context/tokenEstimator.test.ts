import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import {
  estimateTokens,
  extractMessageText,
  estimateMessagesTokens,
} from "./tokenEstimator.ts";

test("estimateTokens divides characters by 3.75 and rounds up", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("a"), 1);
  assert.equal(estimateTokens("a".repeat(75)), 20);
});

test("extractMessageText reads a plain string message", () => {
  const msg: ModelMessage = { role: "user", content: "hello" };
  assert.equal(extractMessageText(msg), "hello");
});

test("extractMessageText reads text parts from an array", () => {
  const msg = {
    role: "assistant",
    content: [
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ],
  } as unknown as ModelMessage;
  assert.equal(extractMessageText(msg), "one two");
});

test("extractMessageText reads tool-result output value", () => {
  const msg = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "t1",
        toolName: "readFile",
        output: { type: "text", value: "file body" },
      },
    ],
  } as unknown as ModelMessage;
  assert.equal(extractMessageText(msg), "file body");
});

test("estimateMessagesTokens splits assistant output from other input", () => {
  const messages: ModelMessage[] = [
    { role: "system", content: "aaaa" }, // 4 chars -> 2 tokens (input)
    { role: "user", content: "bbbb" }, //   4 chars -> 2 tokens (input)
    { role: "assistant", content: "cccc" }, // 4 chars -> 2 tokens (output)
  ];
  const usage = estimateMessagesTokens(messages);
  assert.equal(usage.output, 2);
  assert.equal(usage.input, 4);
  assert.equal(usage.total, usage.input + usage.output);
});
