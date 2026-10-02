import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const tsx = fileURLToPath(import.meta.resolve("tsx"));
async function invoke(cwd: string, args: string[], preload?: string) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>(
		(resolve) => {
			const child = spawn(
				process.execPath,
				[
					"--import",
					tsx,
					...(preload ? ["--import", preload] : []),
					cli,
					...args,
				],
				{
					cwd,
					env: {
						PATH: process.env.PATH,
						OPENAI_API_KEY: "test-only-key",
						LMNR_API_KEY: "must-not-export",
					},
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (data) => {
				stdout += data;
			});
			child.stderr.on("data", (data) => {
				stderr += data;
			});
			child.on("close", (code) => resolve({ code, stdout, stderr }));
		},
	);
}
async function cliFixture(t: TestContext) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-cli-"));
	t.after(() => fs.rm(cwd, { recursive: true, force: true }));
	const config = path.join(cwd, "config.json");
	await fs.writeFile(config, "{}");
	const preload = path.join(cwd, "preload.mjs");
	await fs.writeFile(
		preload,
		`const originalFetch = globalThis.fetch; globalThis.fetch = async (url, init) => {
 if (!String(url).startsWith("http://127.0.0.1:1234/v1/")) return originalFetch(url, init);
 const body = init?.body ? JSON.parse(init.body) : {};
 const call = body.messages?.some(m => m.content?.includes?.("request edit")) && !body.messages.some(m => m.role === "tool");
 const chunk = (delta, finish_reason) => ({ id: "fixture", model: "fixture", created: 1, choices: [{ index: 0, delta, finish_reason }] });
 const events = call ? [chunk({ tool_calls: [{ index: 0, id: "tool", type: "function", function: { name: "writeFile", arguments: JSON.stringify({ path: "created.txt", content: "created" }) } }] }, null), chunk({}, "tool_calls")] : [chunk({ content: "done" }, null), chunk({}, "stop")];
 return new Response(events.map(e => "data: " + JSON.stringify(e) + "\\n\\n").join(""), { headers: { "content-type": "text/event-stream" } });
};`,
	);
	const base = [
		"--config",
		config,
		"--state-dir",
		path.join(cwd, "state"),
		"--profile",
		"lmstudio",
		"--model",
		"fixture",
		"--json",
		"-p",
	];
	return { cwd, config, preload, base };
}

test("CLI help, version, JSON events and plain output work from an arbitrary cwd", async (t) => {
	const { cwd, preload, base } = await cliFixture(t);
	assert.equal((await invoke(cwd, ["--help"])).code, 0);
	assert.match((await invoke(cwd, ["--version"])).stdout, /1\.0\.0/);
	const run = await invoke(cwd, [...base, "hello", "--local-only"], preload);
	assert.equal(run.code, 0, run.stderr);
	const events = run.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(
		events.find((event) => event.type === "outcome")?.status,
		"success",
	);
	assert.equal(events[0].type, "session");
	assert.equal(events.at(-1).type, "complete");
	const plain = await invoke(
		cwd,
		base.filter((argument) => argument !== "--json").concat("hello"),
		preload,
	);
	assert.equal(plain.code, 0, plain.stderr);
	assert.equal(plain.stdout, "done\n");
	assert.match(plain.stderr, /Files changed by file tools: none/);
});

test("headless session-save failures override an otherwise successful exit", async (t) => {
	const { cwd, preload, base } = await cliFixture(t);
	const invalidState = path.join(cwd, "state-file");
	await fs.writeFile(invalidState, "not a directory");
	const saveFailure = await invoke(
		cwd,
		[...base, "hello", "--state-dir", invalidState],
		preload,
	);
	assert.equal(saveFailure.code, 1);
	assert.match(saveFailure.stderr, /Session save failed/);
	const saveEvents = saveFailure.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.ok(saveEvents.some((event) => event.type === "session-error"));
	assert.equal(
		saveEvents.find((event) => event.type === "outcome")?.status,
		"success",
	);
});

test("headless approval, plan policy and step limits preserve their exit codes", async (t) => {
	const { cwd, preload, base } = await cliFixture(t);
	const blocked = await invoke(cwd, [...base, "request edit"], preload);
	assert.equal(blocked.code, 3, blocked.stderr);
	await assert.rejects(fs.stat(path.join(cwd, "created.txt")), /ENOENT/);
	const plan = await invoke(
		cwd,
		[...base, "request edit", "--yes", "--mode", "plan"],
		preload,
	);
	assert.equal(plan.code, 3, plan.stderr);
	const limit = await invoke(
		cwd,
		[...base, "request edit", "--yes", "--max-steps", "1"],
		preload,
	);
	assert.equal(limit.code, 2, limit.stderr);
	assert.equal(
		await fs.readFile(path.join(cwd, "created.txt"), "utf-8"),
		"created",
	);
});

test("resuming local-only history requires explicit cloud-transition consent", async (t) => {
	const { cwd, config, preload, base } = await cliFixture(t);
	const run = await invoke(cwd, [...base, "hello", "--local-only"], preload);
	assert.equal(run.code, 0, run.stderr);
	const events = run.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const transition = await invoke(cwd, [
		"--config",
		config,
		"--state-dir",
		path.join(cwd, "state"),
		"--session",
		events[0].id,
		"--profile",
		"openai",
		"-p",
		"continue",
	]);
	assert.equal(transition.code, 3);
	assert.match(transition.stderr, /allow-cloud-transition/);
});
