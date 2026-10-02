import type { ToolSet } from "@ai-sdk/provider-utils";
import type { ProviderSettings } from "../config.ts";
import type { Workspace } from "../workspace.ts";
import {
	createFileTools,
	deleteFile,
	editFile,
	listFiles,
	readFile,
	writeFile,
} from "./file.ts";
import { createGitTools } from "./git.ts";
import { createSearchTools, globFiles, searchCode } from "./search.ts";
import { createShellTools, runCommand } from "./shell.ts";
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

export function createTools(
	workspace: Workspace,
	onOutput?: (text: string) => void,
): ToolSet {
	return {
		...createFileTools(workspace),
		...createSearchTools(workspace),
		...createShellTools(workspace, onOutput),
		...createGitTools(workspace),
		webSearch,
	};
}

const LOCAL_TOOLS = new Set([
	"gitStatus",
	"gitDiff",
	"readFile",
	"writeFile",
	"editFile",
	"listFiles",
	"deleteFile",
	"globFiles",
	"searchCode",
]);

/** Apply provider capabilities and hard local-only denials before advertising or executing tools. */
export function selectProviderTools(
	settings: ProviderSettings,
	toolSet: ToolSet = tools,
): ToolSet {
	if (!settings.capabilities.tools) return {};
	return Object.fromEntries(
		Object.entries(toolSet).filter(([name, definition]) => {
			if (
				settings.localOnly &&
				(!LOCAL_TOOLS.has(name) || definition.type === "provider")
			)
				return false;
			if (definition.type === "provider")
				return name === "webSearch" && settings.capabilities.hostedWebSearch;
			return name !== "webSearch" || settings.capabilities.hostedWebSearch;
		}),
	);
}

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
			t.type === "provider" ? t : { ...t, execute: undefined },
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
 * Legacy names for consumers; runtime authorization uses registered metadata.
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
