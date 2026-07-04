import { exec } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "ai";
import { z } from "zod";
import { truncateOutput } from "./truncate.ts";

const execAsync = promisify(exec);

/** Kill a command that runs longer than this so it can't hang the agent. */
const COMMAND_TIMEOUT_MS = 60_000;
/** Cap on captured bytes; the model-facing output is truncated separately. */
const MAX_BUFFER = 10 * 1024 * 1024;

interface ExecError {
  code?: number;
  killed?: boolean;
  signal?: string;
  stdout?: string;
  stderr?: string;
  message?: string;
}

/**
 * Run a shell command asynchronously.
 *
 * Uses child_process.exec (not the synchronous shelljs) so a long-running
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
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      const output = truncateOutput(`${stdout ?? ""}${stderr ?? ""}`);
      return output || "Command completed successfully (no output)";
    } catch (error) {
      const err = error as ExecError;
      const output = truncateOutput(`${err.stdout ?? ""}${err.stderr ?? ""}`);

      if (err.killed && err.signal === "SIGTERM") {
        return `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s${
          output ? `:\n${output}` : ""
        }`;
      }

      const code = typeof err.code === "number" ? err.code : "unknown";
      return `Command failed (exit code ${code}):\n${
        output || err.message || ""
      }`;
    }
  },
});
