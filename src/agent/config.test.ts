import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadProviderSettings } from "./config.ts";

test("configuration precedence and explicit project trust", (t) => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "toolwright-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const configPath = path.join(dir, "user.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			defaultProfile: "local",
			profiles: {
				local: {
					provider: "openai-compatible",
					model: "configured",
					contextWindow: 16384,
					maxOutputTokens: 2048,
				},
			},
		}),
	);
	mkdirSync(path.join(dir, ".toolwright"));
	writeFileSync(
		path.join(dir, ".toolwright", "config.json"),
		JSON.stringify({ model: "project" }),
	);
	const context = { configPath, cwd: dir, env: {} };
	assert.equal(loadProviderSettings({}, context).model, "configured");
	assert.equal(
		loadProviderSettings({ trustProjectConfig: true }, context).model,
		"project",
	);
	assert.equal(
		loadProviderSettings({ trustProjectConfig: true, model: "cli" }, context)
			.model,
		"cli",
	);
	assert.equal(
		loadProviderSettings({ trustProjectConfig: true }, context).contextWindow,
		16384,
	);
	writeFileSync(
		path.join(dir, ".toolwright", "config.json"),
		JSON.stringify({ baseURL: "https://example.com/v1" }),
	);
	assert.equal(loadProviderSettings({}, context).model, "configured");
	assert.throws(
		() => loadProviderSettings({ trustProjectConfig: true }, context),
		/Invalid configuration/,
	);
});

test("built-in profiles and invalid configuration fail clearly", (t) => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "toolwright-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const context = { configPath: path.join(dir, "config.json"), env: {} };
	assert.equal(loadProviderSettings({}, context).api, "responses");
	assert.equal(loadProviderSettings({}, context).model, "gpt-6-luna");
	assert.equal(
		loadProviderSettings({ profile: "lmstudio", model: "local" }, context).api,
		"chat-completions",
	);
	assert.throws(
		() => loadProviderSettings({ profile: "lmstudio" }, context),
		/Select a model/,
	);
	assert.equal(
		loadProviderSettings(
			{ profile: "lmstudio" },
			{ ...context, requireModel: false },
		).model,
		"",
	);
	assert.throws(
		() => loadProviderSettings({ profile: "missing" }, context),
		/Unknown provider profile/,
	);
	assert.throws(
		() =>
			loadProviderSettings(
				{ baseURL: "https://user:secret@example.com/v1" },
				context,
			),
		/without embedded credentials/,
	);
	assert.throws(
		() => loadProviderSettings({ localOnly: true }, context),
		/loopback endpoint/,
	);
	assert.throws(() => loadProviderSettings({ contextWindow: -1 }, context));
	writeFileSync(context.configPath, "{invalid}");
	assert.throws(
		() => loadProviderSettings({}, context),
		/Invalid configuration/,
	);
});

test("provider and endpoint overrides do not inherit cloud credentials or protocol", (t) => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "toolwright-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const context = { configPath: path.join(dir, "user.json"), env: {} };
	writeFileSync(
		context.configPath,
		JSON.stringify({
			profiles: {
				openai: {
					provider: "openai",
					api: "responses",
					baseURL: "https://api.openai.com/v1",
					apiKeyEnv: "OPENAI_API_KEY",
					model: "cloud",
				},
			},
		}),
	);
	const local = loadProviderSettings(
		{ provider: "openai-compatible", model: "local" },
		context,
	);
	assert.equal(local.baseURL, "http://127.0.0.1:1234/v1");
	assert.equal(local.api, "chat-completions");
	assert.equal(local.apiKeyEnv, undefined);
	assert.equal(local.telemetry, false);
	assert.equal(
		loadProviderSettings({ baseURL: "https://another.example/v1" }, context)
			.apiKeyEnv,
		undefined,
	);
	assert.equal(
		loadProviderSettings(
			{ baseURL: "https://another.example/v1", apiKeyEnv: "SERVER_KEY" },
			context,
		).apiKeyEnv,
		"SERVER_KEY",
	);
});
