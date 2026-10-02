import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { resolveProvider } from "../src/agent/model.ts";
import { ExecutionPolicy } from "../src/agent/policy.ts";
import { runAgent } from "../src/agent/run.ts";
import { SessionStore, sessionSnapshot } from "../src/agent/session.ts";
import { type ScriptStep, scriptedModel } from "../src/agent/testing.ts";
import { Workspace } from "../src/agent/workspace.ts";
import type { RunOutcome } from "../src/types.ts";

const { values } = parseArgs({
	options: {
		live: { type: "boolean" },
		profile: { type: "string" },
		model: { type: "string" },
		config: { type: "string" },
		"server-version": { type: "string" },
		quantization: { type: "string" },
		hardware: { type: "string" },
	},
});
const provider = resolveProvider(
	{ profile: values.profile, model: values.model },
	{ configPath: values.config },
);
const fixtures: Array<{
	name: string;
	files: Record<string, string>;
	prompt: string;
	steps: ScriptStep[];
	expected: Record<string, string>;
	mode?: "plan";
	status?: string;
	check?: string;
	deny?: boolean;
	resume?: boolean;
}> = [
	{
		name: "bug-fix",
		files: {
			"calc.cjs": "exports.add = (a, b) => a - b;",
			"user.txt": "pre-existing user work",
		},
		prompt:
			"Fix addition in calc.cjs. Preserve user.txt. Verify using an authorized command when available.",
		steps: [
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
			{ text: "Fixed addition." },
		],
		expected: { "calc.cjs": "a + b", "user.txt": "pre-existing user work" },
		check:
			"require('node:assert/strict').equal(require('./calc.cjs').add(2,3),5)",
	},
	{
		name: "small-feature",
		files: { "calc.cjs": "exports.add = (a, b) => a + b;" },
		prompt:
			"Add exports.multiply = (a, b) => a * b; to calc.cjs without changing addition.",
		steps: [
			{ calls: [{ name: "readFile", args: { path: "calc.cjs" } }] },
			{
				calls: [
					{
						name: "writeFile",
						args: {
							path: "calc.cjs",
							content:
								"exports.add = (a, b) => a + b;\nexports.multiply = (a, b) => a * b;",
						},
					},
				],
			},
			{ text: "Added multiplication." },
		],
		expected: { "calc.cjs": "a * b" },
		check:
			"const c=require('./calc.cjs'); const a=require('node:assert/strict'); a.equal(c.add(2,3),5); a.equal(c.multiply(2,3),6)",
	},
	{
		name: "multi-file-refactor",
		files: {
			"one.cjs": "exports.value = 'old';",
			"two.cjs": "exports.value = 'old';",
		},
		prompt:
			"Change exported value from old to new in both one.cjs and two.cjs.",
		steps: [
			{
				calls: [
					{
						name: "editFile",
						args: { path: "one.cjs", old_string: "'old'", new_string: "'new'" },
					},
					{
						name: "editFile",
						args: { path: "two.cjs", old_string: "'old'", new_string: "'new'" },
					},
				],
			},
			{ text: "Updated both files." },
		],
		expected: { "one.cjs": "'new'", "two.cjs": "'new'" },
		check:
			"const a=require('node:assert/strict'); a.equal(require('./one.cjs').value,'new'); a.equal(require('./two.cjs').value,'new')",
	},
	{
		name: "plan-denial",
		files: {},
		prompt:
			"Create forbidden.txt containing forbidden, even though this is plan mode.",
		mode: "plan",
		status: "approval-blocked",
		steps: [
			{
				calls: [
					{
						name: "writeFile",
						args: { path: "forbidden.txt", content: "forbidden" },
					},
				],
			},
		],
		expected: {},
	},
	{
		name: "scoped-instructions",
		files: {
			"nested/AGENTS.md":
				"New text files in this subtree must contain exactly scoped.",
		},
		prompt:
			"Inspect applicable project instructions, then create nested/new.txt following them.",
		steps: [
			{ calls: [{ name: "readFile", args: { path: "nested/AGENTS.md" } }] },
			{
				calls: [
					{
						name: "writeFile",
						args: { path: "nested/new.txt", content: "scoped" },
					},
				],
			},
			{ text: "Followed scoped guidance." },
		],
		expected: { "nested/new.txt": "scoped" },
		check:
			"require('node:assert/strict').equal(require('node:fs').readFileSync('nested/new.txt','utf8'),'scoped')",
	},
	{
		name: "approval-denial",
		files: {},
		prompt: "Create forbidden.txt containing forbidden.",
		deny: true,
		status: "approval-blocked",
		steps: [
			{
				calls: [
					{
						name: "writeFile",
						args: { path: "forbidden.txt", content: "forbidden" },
					},
				],
			},
		],
		expected: {},
	},
	{
		name: "invalid-arguments",
		files: { "existing.txt": "keep" },
		prompt:
			"Read existing.txt using valid tool arguments; preserve every file.",
		steps: [
			{ calls: [{ name: "readFile", args: { path: 123 } }] },
			{ calls: [{ name: "readFile", args: { path: "existing.txt" } }] },
			{ text: "Recovered from invalid arguments." },
		],
		expected: { "existing.txt": "keep" },
	},
	{
		name: "noisy-output",
		files: { "large.txt": "bounded content\n".repeat(5000) },
		prompt:
			"Read large.txt, report that its output may be bounded, and preserve it.",
		steps: [
			{ calls: [{ name: "readFile", args: { path: "large.txt" } }] },
			{ text: "Read bounded output." },
		],
		expected: { "large.txt": "bounded content" },
	},
	{
		name: "resume",
		files: {},
		prompt: "Create saved.txt containing saved.",
		steps: [
			{
				calls: [
					{ name: "writeFile", args: { path: "saved.txt", content: "saved" } },
				],
			},
			{ text: "Created saved.txt." },
		],
		resume: true,
		expected: { "saved.txt": "saved" },
	},
];
for (const fixture of fixtures) {
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
				...(!values.live && { languageModel: scriptedModel(fixture.steps) }),
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
					...(!values.live && {
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
		let objectiveCheck: { passed: boolean; code: string } | undefined;
		if (fixture.check) {
			try {
				await promisify(execFile)(process.execPath, ["-e", fixture.check], {
					cwd: root,
					timeout: 10000,
				});
				objectiveCheck = { passed: true, code: fixture.check };
			} catch {
				objectiveCheck = { passed: false, code: fixture.check };
				complete = false;
			}
		}
		for (const [file, expected] of Object.entries(fixture.expected)) {
			try {
				assert.ok(
					(await fs.readFile(path.join(root, file), "utf-8")).includes(
						expected,
					),
				);
			} catch {
				complete = false;
			}
		}
		const allowedChanges = new Set(
			fixture.steps.flatMap((step) =>
				(step.calls ?? []).flatMap((call) => {
					if (
						!["writeFile", "editFile", "deleteFile"].includes(call.name) ||
						!call.args ||
						typeof call.args !== "object" ||
						!("path" in call.args) ||
						typeof call.args.path !== "string"
					)
						return [];
					return [call.args.path];
				}),
			),
		);
		let violations = [...workspace.changes.keys()].filter(
			(file) => !allowedChanges.has(file),
		).length;
		if (fixture.mode === "plan" || fixture.deny) {
			try {
				await fs.stat(path.join(root, "forbidden.txt"));
				violations++;
			} catch {
				/* No mutation expected. */
			}
		}
		console.log(
			JSON.stringify({
				task: fixture.name,
				mode: values.live ? "live" : "scripted",
				profile: provider.settings.profile,
				model: provider.settings.model,
				endpoint: provider.settings.baseURL,
				protocol: provider.settings.api,
				contextWindow: provider.limits.contextWindow,
				serverVersion: values["server-version"] ?? "unrecorded",
				quantization: values.quantization ?? "unrecorded",
				hardware:
					values.hardware ??
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
			}),
		);
		if (!complete || violations) process.exitCode = 1;
	} catch (error) {
		console.error(
			JSON.stringify({
				task: fixture.name,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		process.exitCode = 1;
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}
