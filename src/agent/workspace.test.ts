import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { executeTool } from "./executeTool.ts";
import { ExecutionPolicy } from "./policy.ts";
import { createTools } from "./tools/index.ts";
import { Workspace } from "./workspace.ts";

test("workspace rejects existing and dangling symlink escapes, supports explicitly allowed roots", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-workspace-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const root = path.join(dir, "repo");
	const outside = path.join(dir, "outside");
	await fs.mkdir(root);
	await fs.mkdir(outside);
	await fs.writeFile(path.join(outside, "secret"), "outside");
	await fs.symlink(outside, path.join(root, "escape"));
	await fs.symlink(path.join(outside, "missing"), path.join(root, "dangling"));
	const workspace = await Workspace.open(root);
	await assert.rejects(workspace.resolve("escape/secret"), /outside/);
	await assert.rejects(workspace.resolve("escape/new/deep.txt"), /outside/);
	await assert.rejects(workspace.resolve("dangling"), /outside/);
	await assert.rejects(workspace.resolve("../outside/secret"), /outside/);
	const allowed = await Workspace.open(root, [outside]);
	assert.equal(await allowed.read("escape/secret"), "outside");
});

test("stale edits are rejected; tracked diffs retain initial contents across multiple changes", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-edit-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const workspace = await Workspace.open(root);
	await fs.writeFile(path.join(root, "user.txt"), "original user work");
	const prepared = await workspace.prepare("writeFile", {
		path: "user.txt",
		content: "agent proposal",
	});
	await fs.writeFile(path.join(root, "user.txt"), "concurrent user work");
	await assert.rejects(workspace.apply(prepared), /stale edit/);
	assert.equal(
		await fs.readFile(path.join(root, "user.txt"), "utf-8"),
		"concurrent user work",
	);
	await workspace.apply(
		await workspace.prepare("writeFile", {
			path: "created.txt",
			content: "first",
		}),
	);
	await workspace.apply(
		await workspace.prepare("writeFile", {
			path: "created.txt",
			content: "second",
		}),
	);
	assert.equal(workspace.changes.get("created.txt")?.before, null);
	assert.match(workspace.diff(), /\/dev\/null/);
	assert.equal(workspace.changes.size, 1);
});

test("scoped guidance, ranged reads, ignore-aware search and command grants", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-guidance-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await fs.mkdir(path.join(root, "src"));
	await fs.writeFile(path.join(root, "AGENTS.md"), "Root guidance");
	await fs.writeFile(path.join(root, "src", "AGENTS.md"), "Subtree guidance");
	await fs.writeFile(path.join(root, "src", "code.ts"), "first\nsecond\nthird");
	await fs.writeFile(path.join(root, "ignored.ts"), "second secret");
	await fs.writeFile(path.join(root, ".gitignore"), "ignored.ts\n");
	await promisify(execFile)("git", ["init", "-q", root]);
	const workspace = await Workspace.open(root);
	const tools = createTools(workspace);
	assert.doesNotMatch(await workspace.instructions(), /Subtree guidance/);
	assert.equal(
		await executeTool(
			"readFile",
			{ path: "src/code.ts", startLine: 2, endLine: 2 },
			tools,
		),
		"2: second",
	);
	assert.match(await workspace.instructions(), /Subtree guidance/);
	assert.match(
		await executeTool("globFiles", { pattern: "src/**/*.ts" }, tools),
		/code.ts/,
	);
	assert.doesNotMatch(
		await executeTool("searchCode", { pattern: "second" }, tools),
		/ignored.ts/,
	);
	const policy = new ExecutionPolicy();
	const approval = await policy.decide(
		"runCommand",
		{ command: "node --version" },
		tools,
		workspace,
	);
	policy.grant(approval.details);
	assert.equal(
		(
			await policy.decide(
				"runCommand",
				{ command: "node --version" },
				tools,
				workspace,
			)
		).decision,
		"allow",
	);
	assert.equal(
		(
			await policy.decide(
				"runCommand",
				{ command: "node other.js" },
				tools,
				workspace,
			)
		).decision,
		"ask",
	);
	policy.mode = "plan";
	assert.equal(
		(
			await policy.decide(
				"runCommand",
				{ command: "node --version" },
				tools,
				workspace,
			)
		).decision,
		"deny",
	);
	assert.equal(
		(await policy.decide("gitStatus", {}, tools, workspace)).decision,
		"allow",
	);
});
