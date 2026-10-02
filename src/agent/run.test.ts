import assert from "node:assert/strict";
import { test } from "node:test";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { recordCallbacks } from "../../tests/helpers/callbacks.ts";
import {
	type ScriptedLanguageModel,
	type ScriptedStreamPart,
	scriptedUsage,
} from "../../tests/helpers/scriptedModel.ts";
import { markTool } from "./execution/policy.ts";
import { runAgent } from "./run.ts";

/** Typed provider double streams fixtures without network or extra dependencies. */
function fakeStreamingModel(
	streamsFn: () => ScriptedStreamPart[],
): ScriptedLanguageModel {
	return {
		specificationVersion: "v4",
		provider: "fake",
		modelId: "fake-model",
		supportedUrls: {},
		doGenerate: () => {
			throw new Error("not implemented — this fake only supports doStream");
		},
		doStream: async () => ({
			stream: new ReadableStream<ScriptedStreamPart>({
				start(controller) {
					for (const part of streamsFn()) controller.enqueue(part);
					controller.close();
				},
			}),
			warnings: [],
		}),
	};
}

// --- runAgent: end-to-end through an injected mock model (no real API calls) ---

test("runAgent streams text through the injected mock model", async () => {
	const model = fakeStreamingModel(() => [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "1" },
		{ type: "text-delta", id: "1", delta: "Hello" },
		{ type: "text-delta", id: "1", delta: " there" },
		{ type: "text-end", id: "1" },
		{
			type: "finish",
			finishReason: { unified: "stop", raw: undefined },
			usage: scriptedUsage(3, 2),
		},
	]);

	const { callbacks, tokens, getCompleted } = recordCallbacks();

	const history = await runAgent("hi", [], callbacks, {
		tools: {},
		languageModel: model,
		telemetry: false,
	});

	assert.equal(tokens.join(""), "Hello there");
	assert.equal(getCompleted(), "Hello there");
	assert.ok(history.some((m) => m.role === "assistant"));
});

test("runAgent auto-approves a read-only tool call end to end, then finishes", async () => {
	let callCount = 0;
	const model = fakeStreamingModel(() => {
		callCount++;
		if (callCount === 1) {
			return [
				{ type: "stream-start", warnings: [] },
				{
					type: "tool-call",
					toolCallId: "call-1",
					toolName: "readFile",
					input: JSON.stringify({ path: "a.txt" }),
				},
				{
					type: "finish",
					finishReason: { unified: "tool-calls", raw: undefined },
					usage: scriptedUsage(5, 1),
				},
			];
		}
		return [
			{ type: "stream-start", warnings: [] },
			{ type: "text-start", id: "2" },
			{ type: "text-delta", id: "2", delta: "done" },
			{ type: "text-end", id: "2" },
			{
				type: "finish",
				finishReason: { unified: "stop", raw: undefined },
				usage: scriptedUsage(8, 1),
			},
		];
	});

	const toolSet: ToolSet = {
		readFile: tool({
			description: "read",
			inputSchema: z.object({ path: z.string() }),
			execute: async ({ path }: { path: string }) => `contents:${path}`,
		}),
	};

	let approvalCalls = 0;
	const { callbacks, toolEnds, getCompleted } = recordCallbacks(async () => {
		approvalCalls++;
		return true;
	});

	await runAgent("read a.txt", [], callbacks, {
		languageModel: model,
		tools: { ...toolSet, readFile: markTool(toolSet.readFile, "read") },
		telemetry: false,
	});

	assert.equal(approvalCalls, 0, "readFile is read-only and must not prompt");
	assert.equal(toolEnds[0].result, "contents:a.txt");
	assert.equal(getCompleted(), "done");
});
