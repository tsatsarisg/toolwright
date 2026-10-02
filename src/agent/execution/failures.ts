import type { CommandResult } from "../../workspace/types.ts";
import type { ToolCallInfo } from "../types.ts";

export class ToolFailureTracker {
	private readonly counts = new Map<string, number>();
	private readonly unresolved = new Set<string>();

	record(calls: ToolCallInfo[], failedTools: string[]): void {
		for (const call of calls) {
			const key = JSON.stringify([call.toolName, call.args]);
			if (failedTools.includes(call.toolName)) {
				this.unresolved.add(call.toolName);
				this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
			} else {
				this.unresolved.delete(call.toolName);
				this.counts.delete(key);
			}
		}
	}

	hasRepeatedFailures(limit: number): boolean {
		return [...this.counts.values()].some((count) => count >= limit);
	}

	get unresolvedTools(): string[] {
		return [...this.unresolved];
	}
}

export function hasFailedCommands(commands: CommandResult[]): boolean {
	const latest = new Map(commands.map((command) => [command.command, command]));
	return [...latest.values()].some(
		(command) =>
			command.exitCode !== 0 || command.timedOut || command.overflowed,
	);
}
