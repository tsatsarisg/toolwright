import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Laminar } from "@lmnr-ai/lmnr";
import { generateText, registerTelemetry } from "ai";
import {
	type ScriptedLanguageModel,
	scriptedModel,
} from "../../tests/helpers/scriptedModel.ts";
import { defaultSummarizer } from "../agent/context/compaction.ts";
import { runAgent } from "../agent/run.ts";
import { probeToolCalling } from "./diagnostics.ts";
import { resolveProvider } from "./resolve.ts";
import { inferenceTelemetry, initTelemetry } from "./telemetry.ts";

test("local and disabled requests suppress globally registered SDK telemetry", async () => {
	let traced = 0;
	registerTelemetry({ onStart: () => void traced++ });
	const model = scriptedModel([{ text: "done" }, { text: "done" }]);
	// Prove the integration observes SDK calls unless explicitly disabled.
	await generateText({ model, prompt: "control" });
	assert.equal(traced, 1);

	for (const localOnly of [true, false]) {
		const provider = resolveProvider(
			{ profile: "lmstudio", model: "fixture", localOnly },
			{
				configPath: "/private/tmp/toolwright-no-telemetry-config.json",
				env: {},
			},
		);
		provider.languageModel = model;
		await runAgent(
			"hello",
			[],
			{
				onToken: () => {},
				onToolCallStart: () => {},
				onToolCallEnd: () => {},
				onComplete: () => {},
				onToolApproval: async () => true,
			},
			{ resolvedProvider: provider, tools: {}, telemetry: true },
		);
		await defaultSummarizer(provider)("summarize local history");
		provider.languageModel = {
			...model,
			doGenerate: async (options) => ({
				...(await model.doGenerate(options)),
				content: [
					{
						type: "tool-call",
						toolCallId: "probe",
						toolName: "toolwright_probe",
						input: '{"value":"toolwright-ok"}',
					},
				],
				finishReason: { unified: "tool-calls", raw: undefined },
			}),
		} satisfies ScriptedLanguageModel;
		await probeToolCalling(provider);
	}
	assert.equal(traced, 1);

	const cloud = resolveProvider({}, { env: {} });
	cloud.languageModel = model;
	await defaultSummarizer(
		cloud,
		undefined,
		undefined,
		undefined,
		false,
	)("explicitly disabled");
	assert.equal(traced, 1);
	assert.deepEqual(inferenceTelemetry(cloud.settings, false), {
		isEnabled: false,
	});
});

test("telemetry initialization respects provider policy and disables automatic instrumentation", () => {
	const initialize = mock.method(Laminar, "initialize", () => {});
	const previousKey = process.env.LMNR_API_KEY;
	process.env.LMNR_API_KEY = "fixture-key";
	try {
		const local = resolveProvider(
			{ profile: "lmstudio", model: "fixture", localOnly: true },
			{ env: {} },
		);
		initTelemetry(local.settings);
		initTelemetry({ ...local.settings, localOnly: false });
		assert.equal(initialize.mock.callCount(), 0);
		// Even inconsistent caller settings cannot enable strict-local tracing.
		assert.deepEqual(
			inferenceTelemetry({ ...local.settings, telemetry: true }),
			{
				isEnabled: false,
			},
		);
		const cloud = resolveProvider({}, { env: {} });
		initTelemetry(cloud.settings);
		assert.equal(initialize.mock.callCount(), 1);
		assert.deepEqual(initialize.mock.calls[0].arguments, [
			{ projectApiKey: "fixture-key", instrumentModules: {} },
		]);
		const telemetry = inferenceTelemetry(cloud.settings);
		assert.equal(telemetry.isEnabled, true);
		assert.equal(telemetry.integrations?.length, 1);
	} finally {
		initialize.mock.restore();
		if (previousKey === undefined) delete process.env.LMNR_API_KEY;
		else process.env.LMNR_API_KEY = previousKey;
	}
});
