import { spawn } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";
import { truncateOutput } from "./truncate.ts";

/** Kill a command that runs longer than this so it can't hang the agent. */
const COMMAND_TIMEOUT_MS = 60_000;
/** Cap on captured bytes; the model-facing output is truncated separately. */
const MAX_BUFFER = 10 * 1024 * 1024;

interface RunResult {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
}

/**
 * Kill a command's whole process group, not just the direct child.
 *
 * A plain child.kill() only signals the immediate child; a command that
 * backgrounds work (`nohup ... &`, `disown`, `setsid ...`) detaches its
 * children from that process, so they'd survive a timeout otherwise.
 * Spawning detached makes the child the leader of a new process group (its
 * pid IS the group id), so kill(-pid, signal) reaches the whole tree —
 * verified directly: a plain child.kill() leaves a backgrounded grandchild
 * running, this does not.
 */
function killProcessGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already dead.
		}
	}
}

function runShellCommand(command: string): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, { shell: true, detached: true });

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let overflowed = false;

		const collect = (target: "stdout" | "stderr") => (chunk: Buffer) => {
			if (overflowed) return;
			const next =
				(target === "stdout" ? stdout : stderr) + chunk.toString("utf-8");
			if (next.length > MAX_BUFFER) {
				overflowed = true;
				if (child.pid) killProcessGroup(child.pid);
			}
			if (target === "stdout") stdout = next;
			else stderr = next;
		};

		child.stdout?.on("data", collect("stdout"));
		child.stderr?.on("data", collect("stderr"));

		const timer = setTimeout(() => {
			timedOut = true;
			if (child.pid) killProcessGroup(child.pid);
		}, COMMAND_TIMEOUT_MS);

		const finish = (code: number | null) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code, timedOut });
		};

		child.on("close", finish);
		child.on("error", () => finish(null));
	});
}

/**
 * Run a shell command asynchronously.
 *
 * Uses child_process.spawn (not the synchronous shelljs) so a long-running
 * command never blocks the event loop and freezes the Ink UI. Output is
 * truncated so a noisy command can't overflow the context window.
 */
export const runCommand = tool({
	description:
		"Execute a shell command and return its output. Use this for system operations, running scripts, or interacting with the operating system.",
	inputSchema: z.object({
		command: z.string().describe("The shell command to execute"),
	}),
	execute: async ({ command }: { command: string }) => {
		const { stdout, stderr, code, timedOut } = await runShellCommand(command);
		const output = truncateOutput(`${stdout}${stderr}`);

		if (timedOut) {
			return `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s${
				output ? `:\n${output}` : ""
			}`;
		}

		if (code === 0) {
			return output || "Command completed successfully (no output)";
		}

		return `Command failed (exit code ${code ?? "unknown"}):\n${output}`;
	},
});
