import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveProvider } from "./model.ts";
import { restoreWorkspace, SessionStore, sessionSnapshot } from "./session.ts";
import { Workspace } from "./workspace.ts";

test("atomic sessions restore metadata without credentials or authorization grants", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-session-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const workspace = await Workspace.open(root);
	const store = new SessionStore(root, path.join(root, "state"));
	const provider = resolveProvider(
		{
			profile: "lmstudio",
			model: "fixture",
			localOnly: true,
			apiKeyEnv: "PRIVATE_TOKEN",
		},
		{
			configPath: path.join(root, "missing"),
			env: { PRIVATE_TOKEN: "must-not-persist" },
		},
	);
	await workspace.apply(
		await workspace.prepare("writeFile", { path: "file", content: "created" }),
	);
	await store.save(
		sessionSnapshot(
			"id",
			[{ role: "user", content: "task" }],
			workspace,
			provider.settings,
			{
				status: "cancelled",
				reason: "interrupted",
				steps: 1,
				durationMs: 10,
				totalTokens: 20,
			},
		),
	);
	assert.equal(await store.latest(), "id");
	const loaded = await store.load("id");
	assert.ok(loaded);
	assert.equal(loaded.provider?.localOnly, true);
	assert.doesNotMatch(
		JSON.stringify(loaded),
		/must-not-persist|PRIVATE_TOKEN|grantKey/,
	);
	const restored = await Workspace.open(root);
	restoreWorkspace(restored, loaded);
	assert.equal(restored.changes.get("file")?.before, null);
	assert.equal(loaded.outcome?.status, "cancelled");
	assert.deepEqual(
		(await fs.readdir(store.directory)).filter((file) => file.endsWith(".tmp")),
		[],
	);
	await assert.rejects(store.load("../escape"), /Invalid session ID/);
});

test("legacy histories migrate without replacing original files; corrupt sessions are preserved", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-legacy-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const workspace = await Workspace.open(root);
	const state = path.join(root, "state");
	const store = new SessionStore(workspace.root, state);
	const legacyDir = path.join(
		state,
		workspace.root.replace(/[/\\:]/g, "-").replace(/^-+/, ""),
	);
	await fs.mkdir(legacyDir, { recursive: true });
	const original = JSON.stringify({
		id: "legacy",
		updatedAt: "2026-10-01",
		history: [{ role: "user", content: "original task" }],
	});
	await fs.writeFile(path.join(legacyDir, "legacy.json"), original);
	const loaded = await store.load("legacy");
	assert.ok(loaded);
	await store.save(loaded);
	assert.equal(
		await fs.readFile(path.join(legacyDir, "legacy.json"), "utf-8"),
		original,
	);
	assert.equal(
		(await store.load("legacy"))?.history[0].content,
		"original task",
	);
	await fs.writeFile(path.join(store.directory, "broken.json"), "broken");
	await assert.rejects(store.load("broken"), /preserved/);
	assert.equal(
		await fs.readFile(path.join(store.directory, "broken.json"), "utf-8"),
		"broken",
	);
});
