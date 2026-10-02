import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
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
test("CLI runs from arbitrary cwd without .env; JSON outcomes and cloud transition are explicit", async (t) => {
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
	assert.equal((await invoke(cwd, ["--help"])).code, 0);
	assert.match((await invoke(cwd, ["--version"])).stdout, /1\.0\.0/);
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
