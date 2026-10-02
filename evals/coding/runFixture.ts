import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionPolicy } from "../../src/agent/execution/policy.ts";
import { runAgent } from "../../src/agent/run.ts";
import type { RunOutcome } from "../../src/agent/types.ts";
import type { ResolvedProvider } from "../../src/providers/resolve.ts";
import { sessionSnapshot } from "../../src/sessions/snapshot.ts";
import { SessionStore } from "../../src/sessions/store.ts";
import { Workspace } from "../../src/workspace/workspace.ts";
import { scriptedModel } from "../../tests/helpers/scriptedModel.ts";
import type { CodingFixture } from "./fixtures.ts";
import {
	checkObjective,
	expectedFilesMatch,
	unauthorizedChangeCount,
} from "./verify.ts";

interface CodingEvaluationOptions {
	provider: ResolvedProvider;
	live?: boolean;
	serverVersion?: string;
	quantization?: string;
	hardware?: string;
}

export async function runCodingFixture(
	fixture: CodingFixture,
	options: CodingEvaluationOptions,
) {
	const { provider } = options;
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-eval-"));
	try {
		for (const [file, contents] of Object.entries(fixture.files)) {
			await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
			await fs.writeFile(path.join(root, file), contents);
		}
		const workspace = await Workspace.open(root);
		let outcome: RunOutcome | undefined;
		let invalidCalls = 0;
		let deniedCalls = 0;
		const history = await runAgent(
			fixture.prompt,
			[],
			{
				onToken: () => {},
				onToolCallStart: () => {},
				onToolCallEnd: (_id, result) => {
					if (result.startsWith("Invalid arguments")) invalidCalls++;
					if (/Policy denied|Tool unavailable|user declined/.test(result))
						deniedCalls++;
				},
				onComplete: () => {},
				onToolApproval: async () => !fixture.deny,
				onOutcome: (result) => {
					outcome = result;
				},
			},
			{
				resolvedProvider: provider,
				workspace,
				telemetry: false,
				policy: new ExecutionPolicy(fixture.mode),
				...(!options.live && { languageModel: scriptedModel(fixture.steps) }),
			},
		);
		if (fixture.resume) {
			const store = new SessionStore(root, path.join(root, ".state"));
			await store.save(
				sessionSnapshot(
					"fixture",
					history,
					workspace,
					provider.settings,
					outcome,
				),
			);
			const saved = await store.load("fixture");
			assert.ok(saved);
			const before = await fs.stat(path.join(root, "saved.txt"));
			await runAgent(
				"Report the saved result without editing any file.",
				saved.history,
				{
					onToken: () => {},
					onToolCallStart: () => {},
					onToolCallEnd: () => {},
					onComplete: () => {},
					onToolApproval: async () => false,
					onOutcome: (result) => {
						outcome = result;
					},
				},
				{
					resolvedProvider: provider,
					workspace,
					telemetry: false,
					...(!options.live && {
						languageModel: scriptedModel([{ text: "Saved result restored." }]),
					}),
				},
			);
			assert.equal(
				(await fs.stat(path.join(root, "saved.txt"))).mtimeMs,
				before.mtimeMs,
			);
		}
		let complete =
			outcome?.status === (fixture.status ?? "success") ||
			((fixture.mode === "plan" || fixture.deny) &&
				outcome?.status === "success");
		const objectiveCheck = await checkObjective(root, fixture.check);
		if (objectiveCheck && !objectiveCheck.passed) complete = false;
		if (!(await expectedFilesMatch(root, fixture.expected))) complete = false;
		const violations = await unauthorizedChangeCount(root, fixture, workspace);
		return {
			task: fixture.name,
			mode: options.live ? "live" : "scripted",
			profile: provider.settings.profile,
			model: provider.settings.model,
			endpoint: provider.settings.baseURL,
			protocol: provider.settings.api,
			contextWindow: provider.limits.contextWindow,
			serverVersion: options.serverVersion ?? "unrecorded",
			quantization: options.quantization ?? "unrecorded",
			hardware:
				options.hardware ??
				`${os.platform()} ${os.arch()} ${os.cpus()[0]?.model ?? "unknown CPU"}`,
			memoryBytes: os.totalmem(),
			completion: complete,
			objectiveCheck,
			verification: workspace.commands.map((c) => ({
				command: c.command,
				exitCode: c.exitCode,
			})),
			invalidCalls,
			deniedCalls,
			unauthorizedActions: violations,
			contextFailure: outcome?.reason.includes("Context limit") ?? false,
			latencyMs: outcome?.durationMs,
			tokens: outcome?.totalTokens,
		};
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}
