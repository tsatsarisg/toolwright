import type { ModelMessage } from "ai";
import type { ExecutionPolicy } from "../agent/execution/policy.ts";
import { runAgent } from "../agent/run.ts";
import type { RunAgentOptions, RunOutcome } from "../agent/types.ts";
import type { ResolvedProvider } from "../providers/resolve.ts";
import { sessionSnapshot } from "../sessions/snapshot.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { Workspace } from "../workspace/workspace.ts";

interface HeadlessOptions {
	prompt: string;
	history: ModelMessage[];
	sessionId: string;
	provider: ResolvedProvider;
	workspace: Workspace;
	store: SessionStore;
	policy: ExecutionPolicy;
	budgets: Pick<RunAgentOptions, "maxSteps" | "maxTokens" | "maxTurnMs">;
	json: boolean;
	approve: boolean;
}

export async function runHeadless({
	prompt,
	history,
	sessionId,
	provider,
	workspace,
	store,
	policy,
	budgets,
	json,
	approve,
}: HeadlessOptions): Promise<number> {
	const controller = new AbortController();
	const interrupt = () => controller.abort(new Error("Interrupted"));
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	let outcome: RunOutcome | undefined;
	let saveFailed = false;
	const emit = (event: Record<string, unknown>) => {
		if (json) process.stdout.write(`${JSON.stringify(event)}\n`);
	};
	emit({
		type: "session",
		id: sessionId,
		workspace: workspace.root,
		profile: provider.settings.profile,
		model: provider.settings.model,
		mode: policy.mode,
	});
	try {
		await runAgent(
			prompt,
			history,
			{
				onToken: (text) => {
					if (json) emit({ type: "token", text });
					else process.stdout.write(text);
				},
				onToolCallStart: (name, args, id) =>
					emit({ type: "tool-start", name, args, id }),
				onToolCallEnd: (id, result) => emit({ type: "tool-end", id, result }),
				onTokenUsage: (usage) => emit({ type: "usage", ...usage }),
				onToolApproval: async (name, args, details) => {
					emit({
						type: "approval",
						name,
						args,
						preview: details?.preview,
						approved: approve,
					});
					return approve;
				},
				onCommandOutput: (text) => {
					if (json) emit({ type: "command-output", text });
					else process.stderr.write(text);
				},
				onOutcome: (result) => {
					outcome = result;
					emit({
						type: "outcome",
						...result,
						files: [...workspace.changes.keys()],
						commands: workspace.commands.map((command) => ({
							command: command.command,
							exitCode: command.exitCode,
							timedOut: command.timedOut,
							cancelled: command.cancelled,
						})),
					});
				},
				onCheckpoint: async (history) => {
					try {
						await store.save(
							sessionSnapshot(
								sessionId,
								history,
								workspace,
								provider.settings,
								outcome,
							),
						);
					} catch (error) {
						saveFailed = true;
						process.stderr.write(
							`Session save failed: ${error instanceof Error ? error.message : error}\n`,
						);
						emit({
							type: "session-error",
							message: "Checkpoint could not be persisted",
						});
					}
				},
				onComplete: (text) => {
					if (json) emit({ type: "complete", text });
					else {
						process.stdout.write("\n");
						process.stderr.write(`${workspace.report()}\n`);
						if (outcome?.status !== "success")
							process.stderr.write(`Stopped: ${outcome?.reason}\n`);
					}
				},
			},
			{
				resolvedProvider: provider,
				workspace,
				policy,
				...budgets,
				signal: controller.signal,
				telemetry: false,
			},
		);
	} catch (error) {
		emit({
			type: "error",
			message: error instanceof Error ? error.message : String(error),
		});
		if (!json)
			process.stderr.write(
				`${error instanceof Error ? error.message : error}\n`,
			);
	} finally {
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", interrupt);
	}
	return saveFailed
		? 1
		: {
				success: 0,
				failed: 1,
				limited: 2,
				"approval-blocked": 3,
				cancelled: 130,
			}[outcome?.status ?? "failed"];
}
