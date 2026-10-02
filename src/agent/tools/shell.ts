import { spawn } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";
import type { CommandResult } from "../../types.ts";
import { markTool } from "../policy.ts";
import type { Workspace } from "../workspace.ts";
import { truncateOutput } from "./truncate.ts";

function signalProcess(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(process.platform === "win32" ? pid : -pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			/* Already exited. */
		}
	}
}
export async function runShellCommand(
	command: string,
	options: {
		cwd: string;
		signal?: AbortSignal;
		timeoutMs?: number;
		maxOutputChars?: number;
		onOutput?: (text: string) => void;
	},
): Promise<CommandResult> {
	options.signal?.throwIfAborted();
	return new Promise((resolve) => {
		const started = Date.now();
		const child = spawn(command, {
			cwd: options.cwd,
			shell: true,
			detached: process.platform !== "win32",
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let cancelled = false;
		let overflowed = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = () => {
			if (!child.pid) return;
			signalProcess(child.pid, "SIGTERM");
			killTimer ??= setTimeout(() => {
				if (child.pid) signalProcess(child.pid, "SIGKILL");
			}, 250);
		};
		const abort = () => {
			cancelled = true;
			kill();
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, options.timeoutMs ?? 60000);
		const collect = (kind: "stdout" | "stderr") => (data: Buffer) => {
			const remaining =
				(options.maxOutputChars ?? 16000) - stdout.length - stderr.length;
			if (remaining <= 0) {
				overflowed = true;
				kill();
				return;
			}
			const text = data.toString("utf-8").slice(0, remaining);
			if (kind === "stdout") stdout += text;
			else stderr += text;
			options.onOutput?.(text);
			if (data.length > remaining) {
				overflowed = true;
				kill();
			}
		};
		child.stdout?.on("data", collect("stdout"));
		child.stderr?.on("data", collect("stderr"));
		let finished = false;
		const finish = (exitCode: number | null) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (killTimer) {
				clearTimeout(killTimer);
				// The shell can exit while a detached descendant ignores SIGTERM.
				if (child.pid) signalProcess(child.pid, "SIGKILL");
			}
			options.signal?.removeEventListener("abort", abort);
			resolve({
				command,
				cwd: options.cwd,
				stdout,
				stderr,
				exitCode,
				timedOut,
				cancelled,
				overflowed,
				durationMs: Date.now() - started,
			});
		};
		child.on("close", finish);
		child.on("error", (error) => {
			stderr += error.message;
			finish(null);
		});
	});
}
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
