import { test } from "node:test";
import assert from "node:assert/strict";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { executeTool } from "./executeTool.ts";

const toolSet: ToolSet = {
  echo: tool({
    description: "echo",
    inputSchema: z.object({ value: z.string() }),
    execute: async ({ value }: { value: string }) => `echo:${value}`,
  }),
  providerThing: tool({
    description: "no execute",
    inputSchema: z.object({ q: z.string() }),
  }),
};

test("executes a known tool with valid args", async () => {
  const result = await executeTool("echo", { value: "hi" }, toolSet);
  assert.equal(result, "echo:hi");
});

test("returns an error string for unknown tools", async () => {
  const result = await executeTool("nope", {}, toolSet);
  assert.match(result, /Unknown tool: nope/);
});

test("returns a provider-tool notice when there is no execute", async () => {
  const result = await executeTool("providerThing", { q: "x" }, toolSet);
  assert.match(result, /executed by model provider/);
});

test("returns a validation error instead of throwing on bad args", async () => {
  // `value` should be a string; pass a number to fail schema validation.
  const result = await executeTool(
    "echo",
    { value: 123 } as unknown as Record<string, unknown>,
    toolSet,
  );
  assert.match(result, /Invalid arguments for echo/);
});
