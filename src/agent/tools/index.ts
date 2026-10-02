import type { ToolSet } from "@ai-sdk/provider-utils";
import type { ProviderSettings } from "../../config/types.ts";
import type { Workspace } from "../../workspace/workspace.ts";
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
