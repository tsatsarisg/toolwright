import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { type TestContext, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { render } from "ink";
import { createElement } from "react";
import { ExecutionPolicy } from "../../src/agent/execution/policy.ts";
import { resolveProvider } from "../../src/providers/resolve.ts";
import { SessionStore } from "../../src/sessions/store.ts";
import { useCodingSession } from "../../src/ui/useCodingSession.ts";
import { Workspace } from "../../src/workspace/workspace.ts";
import { type ScriptStep, scriptedModel } from "../helpers/scriptedModel.ts";

async function openSession(t: TestContext, steps: ScriptStep[] = []) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "toolwright-ui-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const configPath = path.join(root, "profiles.json");
	await fs.writeFile(
		configPath,
		JSON.stringify({
			profiles: {
				cloud: {
					provider: "openai-compatible",
					baseURL: "https://example.invalid/v1",
					model: "fixture",
				},
			},
		}),
	);
	const provider = resolveProvider(
		{ profile: "lmstudio", model: "fixture", localOnly: true },
		{ configPath, env: {} },
	);
	provider.languageModel = scriptedModel(steps);
	const workspace = await Workspace.open(root);
	const store = new SessionStore(root, path.join(root, "state"));
	const policy = new ExecutionPolicy();
	const stdin = Object.assign(new PassThrough(), {
		isTTY: true,
		setRawMode: () => stdin,
		ref: () => stdin,
		unref: () => stdin,
	});
	const stdout = Object.assign(
		new Writable({ write: (_chunk, _encoding, callback) => callback() }),
		{ isTTY: true, columns: 80, rows: 24 },
	);
	let session: ReturnType<typeof useCodingSession> | undefined;
	function SessionHarness() {
		session = useCodingSession({
			sessionId: "ui-fixture",
			provider,
			workspace,
			store,
			policy,
			configPath,
		});
		return null;
	}
	const terminal = render(createElement(SessionHarness), {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: stdout as unknown as NodeJS.WriteStream,
		exitOnCtrlC: false,
		patchConsole: false,
		kittyKeyboard: { mode: "disabled" },
	});
	t.after(async () => {
		terminal.unmount();
		await terminal.waitUntilExit();
		terminal.cleanup();
		stdin.destroy();
		stdout.destroy();
	});
	const current = () => {
		assert.ok(session);
		return session;
	};
	const waitFor = async (condition: () => boolean) => {
		for (let attempt = 0; attempt < 200; attempt++) {
			await setTimeout(10);
			await terminal.waitUntilRenderFlush();
			if (condition()) return;
		}
		assert.fail("Terminal session did not reach the expected state.");
	};
	await waitFor(() => session !== undefined);
	return { root, store, policy, current, waitFor, stdin };
}

test("terminal commands stay local and approved edits persist their outcome", async (t) => {
	const { root, store, policy, current, waitFor } = await openSession(t, [
		{
			calls: [
				{ name: "writeFile", args: { path: "note.txt", content: "saved" } },
			],
		},
		{ text: "Created note.txt." },
	]);
	await current().submit("/plan");
	await waitFor(() => current().mode === "plan");
	assert.equal(policy.mode, "plan");
	await current().submit("/diff");
	await current().submit("/help");
	await current().submit("/plan");
	await waitFor(() => current().mode === "edit");
	assert.equal(await store.latest(), null);

	const turn = current().submit("Create note.txt.");
	await waitFor(() => current().approval !== null);
	assert.match(current().approval?.details?.preview ?? "", /\+saved/);
	await assert.rejects(fs.stat(path.join(root, "note.txt")), /ENOENT/);
	current().resolveApproval("once");
	await turn;
	await waitFor(() => !current().working);
	assert.equal(
		await fs.readFile(path.join(root, "note.txt"), "utf-8"),
		"saved",
	);
	const saved = await store.load("ui-fixture");
	assert.equal(saved?.outcome?.status, "success");
	assert.deepEqual(
		saved?.changes.map((change) => change.path),
		["note.txt"],
	);
	assert.ok(
		current().messages.some((message) =>
			message.content.includes("Created note.txt."),
		),
	);
});

test("terminal provider changes require consent before saving local-only history", async (t) => {
	const fetch = t.mock.method(globalThis, "fetch", async () => {
		throw new Error("Provider selection must not send inference.");
	});
	const { store, current, waitFor } = await openSession(t);
	const declined = current().submit("/model cloud fixture");
	await waitFor(() => current().approval !== null);
	assert.equal(current().approval?.toolName, "sendSessionToProvider");
	assert.equal(current().approval?.details?.destructive, true);
	current().resolveApproval("no");
	await declined;
	await waitFor(() => !current().working);
	assert.equal(current().provider.settings.localOnly, true);
	assert.equal(await store.latest(), null);

	const accepted = current().submit("/model cloud fixture");
	await waitFor(() => current().approval !== null);
	current().resolveApproval("once");
	await accepted;
	await waitFor(() => !current().working);
	assert.equal(current().provider.settings.profile, "cloud");
	assert.equal((await store.load("ui-fixture"))?.provider?.localOnly, false);
	assert.equal(fetch.mock.callCount(), 0);
});

test("cancelling terminal approval leaves files untouched and checkpoints cancellation", async (t) => {
	const { root, store, current, waitFor, stdin } = await openSession(t, [
		{
			calls: [
				{ name: "writeFile", args: { path: "cancelled.txt", content: "no" } },
			],
		},
	]);
	const turn = current().submit("Create cancelled.txt.");
	await waitFor(() => current().approval !== null);
	stdin.write("\u001b");
	await turn;
	await waitFor(() => !current().working);
	await assert.rejects(fs.stat(path.join(root, "cancelled.txt")), /ENOENT/);
	assert.equal((await store.load("ui-fixture"))?.outcome?.status, "cancelled");
});
