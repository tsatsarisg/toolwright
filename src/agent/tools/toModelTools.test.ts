import { test } from "node:test";
import assert from "node:assert/strict";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { toModelTools } from "./index.ts";

test("toModelTools strips execute so the SDK cannot auto-run tools", () => {
  const source: ToolSet = {
    echo: tool({
      description: "echo",
      inputSchema: z.object({ value: z.string() }),
      execute: async ({ value }: { value: string }) => value,
    }),
  };

  const model = toModelTools(source);

  // The original stays executable; the model-facing view does not.
  assert.equal(typeof source.echo.execute, "function");
  assert.equal(model.echo.execute, undefined);
  // Schema is preserved so the model still knows how to call it.
  assert.ok(model.echo.inputSchema);
});
