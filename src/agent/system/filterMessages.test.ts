import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import { filterCompatibleMessages } from "./filterMessages.ts";

function toolCall(id: string) {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: "readFile",
    input: {},
  };
}

function toolResult(id: string) {
  return {
    type: "tool-result",
    toolCallId: id,
    toolName: "readFile",
    output: { type: "text", value: "ok" },
  };
}

test("drops system messages carried in history", () => {
  const out = filterCompatibleMessages([
    { role: "system", content: "old system" },
    { role: "user", content: "hi" },
  ] as ModelMessage[]);
  assert.equal(out.some((m) => m.role === "system"), false);
  assert.equal(out.length, 1);
});

test("keeps a matched tool-call / tool-result pair", () => {
  const out = filterCompatibleMessages([
    { role: "user", content: "read it" },
    { role: "assistant", content: [toolCall("t1")] },
    { role: "tool", content: [toolResult("t1")] },
    { role: "assistant", content: "done" },
  ] as unknown as ModelMessage[]);

  const hasCall = out.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      m.content.some((p) => (p as { toolCallId?: string }).toolCallId === "t1"),
  );
  const hasResult = out.some((m) => m.role === "tool");
  assert.ok(hasCall, "matched tool-call should survive");
  assert.ok(hasResult, "matched tool-result should survive");
});

test("drops an orphaned tool-result whose call is gone", () => {
  const out = filterCompatibleMessages([
    { role: "user", content: "hi" },
    { role: "tool", content: [toolResult("ghost")] },
  ] as unknown as ModelMessage[]);
  assert.equal(out.some((m) => m.role === "tool"), false);
});

test("drops an orphaned tool-call that never got a result", () => {
  const out = filterCompatibleMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: [toolCall("t2")] },
  ] as unknown as ModelMessage[]);
  // Assistant message had only the orphan call -> whole message dropped.
  assert.equal(out.some((m) => m.role === "assistant"), false);
});

test("drops empty assistant messages but keeps text", () => {
  const out = filterCompatibleMessages([
    { role: "assistant", content: "" },
    { role: "assistant", content: "real answer" },
  ] as ModelMessage[]);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, "real answer");
});
