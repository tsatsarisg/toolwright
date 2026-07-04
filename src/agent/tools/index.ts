import type { ToolSet } from "ai";
import { readFile, writeFile, listFiles, deleteFile } from "./file.ts";
import { runCommand } from "./shell.ts";
// import { executeCode } from "./codeExecution.ts";
import { webSearch } from "./webSearch.ts";

// All tools combined for the agent
export const tools = {
  readFile,
  writeFile,
  listFiles,
  deleteFile,
  runCommand,
  // executeCode,
  webSearch,
};

/**
 * Model-facing view of the tools: same schemas, but with `execute` stripped.
 * The AI SDK auto-executes any tool that has an `execute` function as soon as
 * the model emits the call — before the approval prompt runs — so the model
 * must only ever see execute-less definitions. Actual execution happens in
 * executeTool after approval. Provider tools (webSearch) run on OpenAI's
 * servers and pass through unchanged.
 */
export const modelTools: ToolSet = Object.fromEntries(
  Object.entries(tools).map(([name, t]) => [
    name,
    t.type === "provider-defined" ? t : { ...t, execute: undefined },
  ]),
);

// Export individual tools for selective use in evals
export { readFile, writeFile, listFiles, deleteFile } from "./file.ts";
export { runCommand } from "./shell.ts";
// export { executeCode } from "./codeExecution.ts";
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
