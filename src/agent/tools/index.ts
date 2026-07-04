import type { ToolSet } from "ai";
import { readFile, writeFile, listFiles, deleteFile } from "./file.ts";
import { runCommand } from "./shell.ts";
import { webSearch } from "./webSearch.ts";

// All tools combined for the agent (with executable `execute` functions).
export const tools = {
  readFile,
  writeFile,
  listFiles,
  deleteFile,
  runCommand,
  webSearch,
};

/**
 * Model-facing view of a toolset: same schemas, but with `execute` stripped.
 *
 * The AI SDK auto-executes any tool that has an `execute` function as soon as
 * the model emits the call — before our approval prompt runs — so the model
 * must only ever see execute-less definitions. Actual execution happens in
 * executeTool after approval. Provider tools (webSearch) run on the provider's
 * servers and are passed through unchanged.
 */
export function toModelTools(toolSet: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(toolSet).map(([name, t]) => [
      name,
      t.type === "provider-defined" ? t : { ...t, execute: undefined },
    ]),
  );
}

/** Default model-facing toolset. */
export const modelTools: ToolSet = toModelTools(tools);

// Export individual tools for selective use in evals
export { readFile, writeFile, listFiles, deleteFile } from "./file.ts";
export { runCommand } from "./shell.ts";
export { webSearch } from "./webSearch.ts";

// Tool sets for evals
export const fileTools = {
  readFile,
  writeFile,
  listFiles,
  deleteFile,
};

export const shellTools = {
  runCommand,
};
