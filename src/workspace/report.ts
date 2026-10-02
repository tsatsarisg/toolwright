import type { CommandResult } from "./types.ts";

function commandSummary(command: CommandResult): string {
	let status = `exit ${command.exitCode ?? "unknown"}`;
	if (command.timedOut) status = "timed out";
	if (command.cancelled) status = "cancelled";
	return `${command.command}: ${status}`;
}

export function workspaceReport(
	changedFiles: Iterable<string>,
	commands: CommandResult[],
): string {
	const files = [...changedFiles].join(", ") || "none";
	const checks = commands.length
		? commands.map(commandSummary).join("; ")
		: "none; verification remains unperformed";
	return `Files changed by file tools: ${files}.\nCommands/checks actually executed: ${checks}.`;
}
