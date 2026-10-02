import { tool } from "ai";
import { z } from "zod";
import type { Workspace } from "../../workspace/workspace.ts";
import { markTool } from "../execution/policy.ts";
import { truncateOutput } from "./truncate.ts";

export function createGitTools(workspace: Workspace) {
	return {
		gitStatus: markTool(
			tool({
				description:
					"Read Git status including pre-existing user changes. Does not stage or modify files.",
				inputSchema: z.object({}),
				execute: async (_args, options) =>
					truncateOutput(
						await workspace.git(
							["status", "--porcelain=v1", "--untracked-files=normal"],
							options.abortSignal,
						),
					),
			}),
			"read",
		),
		gitDiff: markTool(
			tool({
				description:
					"Read the unstaged Git diff. Includes existing user changes; agent-only diff is reviewed separately.",
				inputSchema: z.object({ path: z.string().optional() }),
				execute: async (args, options) => {
					const target = args.path
						? await workspace.resolve(args.path)
						: undefined;
					return truncateOutput(
						await workspace.git(
							[
								"diff",
								"--no-ext-diff",
								"--no-textconv",
								"--",
								...(target ? [target] : []),
							],
							options.abortSignal,
						),
					);
				},
			}),
			"read",
		),
	};
}
