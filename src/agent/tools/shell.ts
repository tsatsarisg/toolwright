import { tool } from "ai";
import { z } from "zod";
import { runShellCommand } from "../../workspace/shell.ts";
import type { Workspace } from "../../workspace/workspace.ts";
import { markTool } from "../execution/policy.ts";
import { truncateOutput } from "./truncate.ts";

export function createShellTools(
	workspace?: Workspace,
	onOutput?: (text: string) => void,
) {
	return {
		runCommand: markTool(
			tool({
				description:
					"Execute an approved host shell command in the workspace. This is not sandboxed. Returns output and structured exit/timeout status.",
				inputSchema: z.object({
					command: z.string(),
					timeoutMs: z.number().int().min(1).max(600000).default(60000),
				}),
				execute: async ({ command, timeoutMs }, options) => {
					const result = await runShellCommand(command, {
						cwd: workspace?.root ?? process.cwd(),
						signal: options.abortSignal,
						timeoutMs,
						onOutput,
					});
					workspace?.commands.push(result);
					return JSON.stringify({
						...result,
						stdout: truncateOutput(result.stdout),
						stderr: truncateOutput(result.stderr),
					});
				},
			}),
			"shell",
		),
	};
}
export const { runCommand } = createShellTools();
