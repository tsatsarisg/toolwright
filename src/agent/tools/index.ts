import type { ToolSet } from "ai";
import {
	deleteFile,
	editFile,
	listFiles,
	readFile,
	writeFile,
} from "./file.ts";
import { globFiles, searchCode } from "./search.ts";
import { runCommand } from "./shell.ts";
import { webSearch } from "./webSearch.ts";

// All tools combined for the agent (with executable `execute` functions).
export const tools = {
	readFile,
	writeFile,
	editFile,
	listFiles,
	deleteFile,
	globFiles,
	searchCode,
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

// Tool sets for evals
export const fileTools = {
	readFile,
	writeFile,
	editFile,
	listFiles,
	deleteFile,
};

export const shellTools = {
	runCommand,
};

/**
 * Tools with no side effects — safe to run without interactive approval.
 * Checked by name in run.ts's tool-call loop.
 */
export const READ_ONLY_TOOLS = new Set<string>([
	"readFile",
	"listFiles",
	"globFiles",
	"searchCode",
	"webSearch",
]);

/**
 * Tools that can destroy or overwrite data. The approval UI styles these
 * distinctly from a routine confirmation so approval fatigue on the safe
 * majority of prompts doesn't bleed into the ones that matter.
 */
export const DESTRUCTIVE_TOOLS = new Set<string>([
	"writeFile",
	"editFile",
	"deleteFile",
	"runCommand",
]);

/**
 * Argument key(s) worth showing inline in the approval preview, per tool.
 * Lives here (next to the tool definitions) rather than in the UI layer,
 * since it's knowledge about what each tool's arguments mean.
 */
export const PREVIEW_ARG_KEYS: Record<string, string[]> = {
	readFile: ["path"],
	writeFile: ["path"],
	editFile: ["path"],
	listFiles: ["directory"],
	deleteFile: ["path"],
	globFiles: ["pattern"],
	searchCode: ["pattern"],
	runCommand: ["command"],
};
