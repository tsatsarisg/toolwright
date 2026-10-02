import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { findWorkspaceFiles, globToRegExp } from "../../workspace/search.ts";
import { Workspace } from "../../workspace/workspace.ts";
import { markTool } from "../execution/policy.ts";
import { truncateOutput } from "./truncate.ts";

export function createSearchTools(workspace?: Workspace) {
	const current = () =>
		workspace ? Promise.resolve(workspace) : Workspace.open();
	return {
		globFiles: markTool(
			tool({
				description:
					"Find workspace files using *, **, ? globs. Honors Git ignore rules and .toolwrightignore. Maximum 200 matches.",
				inputSchema: z.object({
					pattern: z.string(),
					directory: z.string().default("."),
				}),
				execute: async ({ pattern, directory }, options) => {
					const currentWorkspace = await current();
					const root = await currentWorkspace.resolve(directory);
					const regex = globToRegExp(pattern);
					const matches = (
						await findWorkspaceFiles(
							currentWorkspace,
							root,
							options.abortSignal,
						)
					)
						.map((file) => path.relative(root, file))
						.filter((file) => regex.test(file))
						.sort()
						.slice(0, 200);
					return truncateOutput(matches.join("\n") || "No matching files.");
				},
			}),
			"read",
		),
		searchCode: markTool(
			tool({
				description:
					"Search text with a JavaScript regex, returning path:line:text. Honors ignore rules, size and binary limits. Maximum 200 results.",
				inputSchema: z.object({
					pattern: z.string(),
					directory: z.string().default("."),
					filePattern: z.string().optional(),
				}),
				execute: async ({ pattern, directory, filePattern }, options) => {
					const currentWorkspace = await current();
					const root = await currentWorkspace.resolve(directory);
					const regex = new RegExp(pattern);
					const fileRegex = filePattern ? globToRegExp(filePattern) : undefined;
					const matches: string[] = [];
					for (const file of await findWorkspaceFiles(
						currentWorkspace,
						root,
						options.abortSignal,
					)) {
						options.abortSignal?.throwIfAborted();
						const relative = path.relative(root, file);
						if (fileRegex && !fileRegex.test(relative)) continue;
						let text: string;
						try {
							text = await currentWorkspace.read(file, options.abortSignal);
						} catch {
							options.abortSignal?.throwIfAborted();
							continue;
						}
						for (const [index, line] of text.split("\n").entries()) {
							if (regex.test(line))
								matches.push(`${relative}:${index + 1}: ${line.trim()}`);
							if (matches.length >= 200)
								return truncateOutput(matches.join("\n"));
						}
					}
					return truncateOutput(matches.join("\n") || "No matches.");
				},
			}),
			"read",
		),
	};
}
export const { globFiles, searchCode } = createSearchTools();
