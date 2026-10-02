import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { AgentCallbacks, RunOutcome } from "../types.ts";
import { resolveProvider } from "./model.ts";
import { runAgent } from "./run.ts";
import { restoreWorkspace, SessionStore, sessionSnapshot } from "./session.ts";
import { filterCompatibleMessages } from "./system/filterMessages.ts";
import { scriptedModel } from "./testing.ts";
import { runShellCommand } from "./tools/shell.ts";
import { Workspace } from "./workspace.ts";

function callbacks(onOutcome: (outcome: RunOutcome) => void): AgentCallbacks {
	return {
		onToken: () => {},
		onToolCallStart: () => {},
		onToolCallEnd: () => {},
		onComplete: () => {},
		onToolApproval: async () => true,
		onOutcome,
	};
}
test("objective bug fix preserves user edits, follows scoped guidance, verifies and checkpoints", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-coding-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await fs.writeFile(
		path.join(root, "AGENTS.md"),
		"Use the Node check script to verify changes.",
	);
	await fs.writeFile(
		path.join(root, "calc.cjs"),
		"exports.add = (a, b) => a - b;\n",
	);
	await fs.writeFile(path.join(root, "user.txt"), "pre-existing work");
	await fs.writeFile(
		path.join(root, "check.cjs"),
		"if (require('./calc.cjs').add(2, 3) !== 5) process.exit(1);\n",
	);
	const git = (args: string[]) =>
		promisify(execFile)("git", ["-C", root, ...args]);
	await git(["init", "-q"]);
	await git(["add", "."]);
	await git([
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
	await fs.writeFile(
		path.join(root, "user.txt"),
		"pre-existing work, edited by user",
	);
	await fs.writeFile(path.join(root, "untracked.txt"), "untracked user work");
	const workspace = await Workspace.open(root);
	const store = new SessionStore(root, path.join(root, "state"));
	const provider = resolveProvider(
		{},
		{ configPath: path.join(root, "missing"), env: {} },
	);
	let outcome: RunOutcome | undefined;
	const history = await runAgent(
		"Fix addition and verify it",
		[],
		{
			...callbacks((result) => {
				outcome = result;
			}),
			onCheckpoint: async (history) =>
				store.save(
					sessionSnapshot(
						"fixture",
						history,
						workspace,
						provider.settings,
						outcome,
					),
				),
		},
		{
			workspace,
			resolvedProvider: provider,
			telemetry: false,
			languageModel: scriptedModel(
				[
					{ calls: [{ name: "readFile", args: { path: "calc.cjs" } }] },
					{
						calls: [
							{
								name: "editFile",
								args: {
									path: "calc.cjs",
									old_string: "a - b",
									new_string: "a + b",
								},
							},
						],
					},
					{
						calls: [
							{ name: "runCommand", args: { command: "node check.cjs" } },
						],
					},
					{ text: "Fixed addition; verification passed." },
				],
				(options) =>
					assert.match(JSON.stringify(options), /Use the Node check/),
			),
		},
	);
	assert.equal(outcome?.status, "success");
	assert.equal(
		await fs.readFile(path.join(root, "user.txt"), "utf-8"),
		"pre-existing work, edited by user",
	);
	assert.equal(
		await fs.readFile(path.join(root, "untracked.txt"), "utf-8"),
		"untracked user work",
	);
	assert.match(workspace.initialGitStatus, /user.txt/);
	assert.equal(workspace.commands[0].exitCode, 0);
	assert.deepEqual([...workspace.changes.keys()], ["calc.cjs"]);
	assert.equal((await store.load("fixture"))?.history.length, history.length);
	assert.equal((await store.load("fixture"))?.outcome?.status, "success");
});
test("plan mode and unavailable/invalid calls never execute", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-plan-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const workspace = await Workspace.open(root);
	let outcome: RunOutcome | undefined;
	await runAgent(
		"create file",
		[],
		callbacks((result) => {
			outcome = result;
		}),
		{
			workspace,
			mode: "plan",
			telemetry: false,
			languageModel: scriptedModel([
				{
					calls: [
						{ name: "writeFile", args: { path: "bad.txt", content: "bad" } },
					],
				},
			]),
		},
	);
	assert.equal(outcome?.status, "approval-blocked");
	await assert.rejects(fs.stat(path.join(root, "bad.txt")), /ENOENT/);
	await runAgent(
		"invalid",
		[],
		callbacks((result) => {
			outcome = result;
		}),
		{
			workspace,
			telemetry: false,
			languageModel: scriptedModel([
				{ calls: [{ name: "writeFile", args: "{broken" }] },
				{ text: "unable" },
			]),
		},
	);
	assert.equal(workspace.changes.size, 0);
	assert.equal(outcome?.status, "failed");
});
test("step/repeated-failure/token/context limits stop clearly", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-limit-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const workspace = await Workspace.open(root);
	let outcome: RunOutcome | undefined;
	await runAgent(
		"read",
		[],
		callbacks((result) => {
			outcome = result;
		}),
		{
			workspace,
			maxSteps: 1,
			telemetry: false,
			languageModel: scriptedModel([
				{ calls: [{ name: "listFiles", args: {} }] },
			]),
		},
	);
	assert.equal(outcome?.status, "limited");
	const failure = { calls: [{ name: "readFile", args: { path: "missing" } }] };
	await runAgent(
		"read",
		[],
		callbacks((result) => {
			outcome = result;
		}),
		{
			workspace,
			telemetry: false,
			languageModel: scriptedModel([failure, failure, failure]),
		},
	);
	assert.match(outcome?.reason ?? "", /Repeated identical/);
	await runAgent(
		"budget",
		[],
		callbacks((result) => {
			outcome = result;
		}),
		{
			workspace,
			maxTokens: 1,
			telemetry: false,
			languageModel: scriptedModel([
				{ calls: [{ name: "listFiles", args: {} }] },
			]),
		},
	);
	assert.equal(outcome?.status, "limited");
	const provider = resolveProvider(
		{ profile: "lmstudio", model: "fixture", contextWindow: 8192 },
		{ configPath: path.join(root, "missing"), env: {} },
	);
	await runAgent(
		"x".repeat(50000),
		[],
		callbacks((result) => {
			outcome = result;
		}),
		{ workspace, resolvedProvider: provider, languageModel: scriptedModel([]) },
	);
	assert.match(outcome?.reason ?? "", /Context limit/);
});
test("cancellation stops approval and terminates command process groups", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-cancel-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const controller = new AbortController();
	let outcome: RunOutcome | undefined;
	const workspace = await Workspace.open(root);
	await runAgent(
		"write",
		[],
		{
			...callbacks((result) => {
				outcome = result;
			}),
			onToolApproval: async () => {
				controller.abort();
				return true;
			},
		},
		{
			workspace,
			signal: controller.signal,
			telemetry: false,
			languageModel: scriptedModel([
				{
					calls: [{ name: "writeFile", args: { path: "bad", content: "bad" } }],
				},
			]),
		},
	);
	assert.equal(outcome?.status, "cancelled");
	assert.equal(workspace.changes.size, 0);
	const commandController = new AbortController();
	const timer = setTimeout(() => commandController.abort(), 50);
	const result = await runShellCommand(
		'node -e "setTimeout(() => {}, 10000)"',
		{ cwd: root, signal: commandController.signal },
	);
	clearTimeout(timer);
	assert.equal(result.cancelled, true);
	assert.ok(result.durationMs < 3000);
});

test("new nested files wait for scoped instructions before approval", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-guidance-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await fs.mkdir(path.join(root, "nested"));
	await fs.writeFile(
		path.join(root, "nested", "AGENTS.md"),
		"All new files here must contain the word scoped.",
	);
	const workspace = await Workspace.open(root);
	let approvals = 0;
	let outcome: RunOutcome | undefined;
	let step = 0;
	const call = {
		name: "writeFile",
		args: { path: "nested/new.txt", content: "scoped" },
	};
	await runAgent(
		"Create a nested file",
		[],
		{
			...callbacks((result) => {
				outcome = result;
			}),
			onToolApproval: async () => {
				approvals++;
				return true;
			},
		},
		{
			workspace,
			telemetry: false,
			languageModel: scriptedModel(
				[{ calls: [call] }, { calls: [call] }, { text: "created" }],
				(options) => {
					if (++step === 2)
						assert.match(JSON.stringify(options), /All new files here/);
				},
			),
		},
	);
	assert.equal(outcome?.status, "success");
	assert.equal(approvals, 1);
	assert.equal(
		await fs.readFile(path.join(root, "nested/new.txt"), "utf-8"),
		"scoped",
	);
});

test("provider failure after an edit preserves its checkpoint and never replays it", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-failure-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const workspace = await Workspace.open(root);
	let requests = 0;
	let approvals = 0;
	let saved: unknown;
	let outcome: RunOutcome | undefined;
	await assert.rejects(
		runAgent(
			"Create a file",
			[],
			{
				...callbacks((value) => {
					outcome = value;
				}),
				onToolApproval: async () => {
					approvals++;
					return true;
				},
				onCheckpoint: async (history) => {
					saved = history;
				},
			},
			{
				workspace,
				telemetry: false,
				languageModel: scriptedModel(
					[
						{
							calls: [
								{
									name: "writeFile",
									args: { path: "created", content: "created once" },
								},
							],
						},
						{ error: "Provider became unavailable" },
					],
					() => {
						requests++;
					},
				),
			},
		),
		/Provider became unavailable/,
	);
	assert.equal(requests, 2);
	assert.equal(approvals, 1);
	assert.equal(outcome?.status, "failed");
	assert.equal(
		await fs.readFile(path.join(root, "created"), "utf8"),
		"created once",
	);
	assert.match(JSON.stringify(saved), /tool-result/);
});

test("long 8k-context tool turns compact and keep valid pairs and original intent", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-context-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await fs.writeFile(
		path.join(root, "large.txt"),
		"bounded content\n".repeat(1000),
	);
	const workspace = await Workspace.open(root);
	const provider = resolveProvider(
		{ profile: "lmstudio", model: "fixture", contextWindow: 8192 },
		{ configPath: path.join(root, "missing"), env: {} },
	);
	let summaries = 0;
	let outcome: RunOutcome | undefined;
	const history = await runAgent(
		"Original task: inspect repeatedly and preserve this goal",
		[],
		callbacks((result) => {
			outcome = result;
		}),
		{
			workspace,
			resolvedProvider: provider,
			maxSteps: 30,
			telemetry: false,
			languageModel: scriptedModel(
				[
					...Array.from({ length: 15 }, () => ({
						calls: [{ name: "readFile", args: { path: "large.txt" } }],
					})),
					{ text: "Inspected" },
				],
				(options) => {
					assert.ok(JSON.stringify(options).length < 8192 * 4);
				},
				() => {
					summaries++;
				},
			),
		},
	);
	assert.equal(outcome?.status, "success");
	assert.ok(summaries > 0);
	assert.match(JSON.stringify(history[0]), /Original task/);
	assert.deepEqual(history, filterCompatibleMessages(history));
});

test("cancelled batches checkpoint completed edits and resume without replay", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-resume-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const workspace = await Workspace.open(root);
	const controller = new AbortController();
	const store = new SessionStore(root, path.join(root, "state"));
	const provider = resolveProvider(
		{},
		{ configPath: path.join(root, "missing"), env: {} },
	);
	let approvals = 0;
	let outcome: RunOutcome | undefined;
	await runAgent(
		"Create two files",
		[],
		{
			...callbacks((result) => {
				outcome = result;
			}),
			onToolApproval: async () => {
				if (++approvals === 2) controller.abort();
				return true;
			},
			onCheckpoint: async (history) =>
				store.save(
					sessionSnapshot(
						"cancelled",
						history,
						workspace,
						provider.settings,
						outcome,
					),
				),
		},
		{
			workspace,
			resolvedProvider: provider,
			signal: controller.signal,
			telemetry: false,
			languageModel: scriptedModel([
				{
					calls: [
						{
							name: "writeFile",
							args: { path: "first", content: "completed" },
						},
						{
							name: "writeFile",
							args: { path: "second", content: "cancelled" },
						},
					],
				},
			]),
		},
	);
	const saved = await store.load("cancelled");
	assert.ok(saved);
	assert.equal(saved.outcome?.status, "cancelled");
	assert.match(
		JSON.stringify(saved.history),
		/Created|Wrote|Written|Successfully|completed/i,
	);
	const before = await fs.stat(path.join(root, "first"));
	const resumed = await Workspace.open(root);
	restoreWorkspace(resumed, saved);
	await runAgent(
		"Report the saved state",
		saved.history,
		callbacks((result) => {
			outcome = result;
		}),
		{
			workspace: resumed,
			resolvedProvider: provider,
			telemetry: false,
			languageModel: scriptedModel([
				{ text: "First file completed; second was cancelled." },
			]),
		},
	);
	assert.equal(
		(await fs.stat(path.join(root, "first"))).mtimeMs,
		before.mtimeMs,
	);
	await assert.rejects(fs.stat(path.join(root, "second")), /ENOENT/);
	assert.equal(outcome?.status, "success");
});

test("noisy command results retain structured exit status and deadlines stop turns", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-noisy-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const workspace = await Workspace.open(root);
	let result = "";
	let outcome: RunOutcome | undefined;
	await runAgent(
		"Check command",
		[],
		{
			...callbacks((value) => {
				outcome = value;
			}),
			onToolCallEnd: (_id, value) => {
				result = value;
			},
		},
		{
			workspace,
			telemetry: false,
			languageModel: scriptedModel([
				{
					calls: [
						{
							name: "runCommand",
							args: { command: "node -e 'console.log(\"x\".repeat(50000))'" },
						},
					],
				},
				{ text: "Output was bounded." },
			]),
		},
	);
	const parsed = JSON.parse(result);
	assert.equal(parsed.overflowed, true);
	assert.ok("exitCode" in parsed);
	assert.ok(parsed.stdout.length < 12000);
	assert.equal(outcome?.status, "failed");
	await runAgent(
		"Time bounded",
		[],
		callbacks((value) => {
			outcome = value;
		}),
		{
			workspace,
			telemetry: false,
			maxTurnMs: 1,
			languageModel: scriptedModel([
				{ calls: [{ name: "listFiles", args: {} }] },
			]),
		},
	);
	assert.equal(outcome?.status, "limited");
	assert.match(outcome?.reason ?? "", /time limit/);
});
