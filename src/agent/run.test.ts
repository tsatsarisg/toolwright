import assert from "node:assert/strict";
import { test } from "node:test";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { AgentCallbacks, ToolCallInfo } from "../types.ts";
import { markTool } from "./policy.ts";
import { reportTokenUsage, resolveToolCalls, runAgent } from "./run.ts";
import {
	type ScriptedLanguageModel,
	type ScriptedStreamPart,
	scriptedUsage,
} from "./testing.ts";

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

/**
 * Fresh AgentCallbacks with tracking arrays for each test. Approval defaults
 * to "always approve" so tests that don't care about the approval path don't
 * have to wire it up.
 */
function makeCallbacks(
	onToolApproval: AgentCallbacks["onToolApproval"] = async () => true,
) {
	const tokens: string[] = [];
	const toolStarts: ToolCallInfo[] = [];
	const toolEnds: Array<{ id: string; result: string }> = [];
	let completedText: string | null = null;

	const callbacks: AgentCallbacks = {
		onToken: (t) => tokens.push(t),
		onToolCallStart: (name, args, toolCallId) =>
			toolStarts.push({
				toolName: name,
				args: args as Record<string, unknown>,
				toolCallId,
			}),
		onToolCallEnd: (toolCallId, result) =>
			toolEnds.push({ id: toolCallId, result }),
		onComplete: (response) => {
			completedText = response;
		},
		onToolApproval,
	};

	return {
		callbacks,
		tokens,
		toolStarts,
		toolEnds,
		getCompleted: () => completedText,
	};
}

// --- resolveToolCalls: the extracted, streamText-free approval/execution seam ---

test("resolveToolCalls auto-approves read-only tools without prompting", async () => {
	const calls: ToolCallInfo[] = [
		{ toolCallId: "1", toolName: "readFile", args: { path: "a.txt" } },
	];
	const toolSet: ToolSet = {
		readFile: tool({
			description: "read",
			inputSchema: z.object({ path: z.string() }),
			execute: async ({ path }: { path: string }) => `contents of ${path}`,
		}),
	};
	let approvalCalls = 0;
	const { callbacks, toolEnds } = makeCallbacks(async () => {
		approvalCalls++;
		return false;
	});

	const { toolMessages, rejected } = await resolveToolCalls(
		calls,
		{ ...toolSet, readFile: markTool(toolSet.readFile, "read") },
		[],
		callbacks,
		() => {},
	);

	assert.equal(
		approvalCalls,
		0,
		"a read-only tool must never trigger an approval prompt",
	);
	assert.equal(rejected, false);
	assert.equal(toolEnds[0].result, "contents of a.txt");
	assert.equal(toolMessages.length, 1);
});

test("resolveToolCalls prompts for approval on non-read-only tools", async () => {
	const calls: ToolCallInfo[] = [
		{
			toolCallId: "1",
			toolName: "writeFile",
			args: { path: "a.txt", content: "hi" },
		},
	];
	const toolSet: ToolSet = {
		writeFile: tool({
			description: "write",
			inputSchema: z.object({ path: z.string(), content: z.string() }),
			execute: async () => "wrote",
		}),
	};
	let approvalCalls = 0;
	const { callbacks, toolEnds } = makeCallbacks(async () => {
		approvalCalls++;
		return true;
	});

	const { rejected } = await resolveToolCalls(
		calls,
		toolSet,
		[],
		callbacks,
		() => {},
	);

	assert.equal(approvalCalls, 1);
	assert.equal(rejected, false);
	assert.equal(toolEnds[0].result, "wrote");
});

test("resolveToolCalls declines all remaining calls after one rejection, without re-prompting", async () => {
	const calls: ToolCallInfo[] = [
		{ toolCallId: "1", toolName: "writeFile", args: {} },
		{ toolCallId: "2", toolName: "deleteFile", args: {} },
	];
	const toolSet: ToolSet = {
		writeFile: tool({
			description: "w",
			inputSchema: z.object({}),
			execute: async () => "wrote",
		}),
		deleteFile: tool({
			description: "d",
			inputSchema: z.object({}),
			execute: async () => "deleted",
		}),
	};
	let approvalCalls = 0;
	const { callbacks, toolEnds } = makeCallbacks(async () => {
		approvalCalls++;
		return false;
	});

	const { rejected, toolMessages } = await resolveToolCalls(
		calls,
		toolSet,
		[],
		callbacks,
		() => {},
	);

	assert.equal(rejected, true);
	assert.equal(
		approvalCalls,
		1,
		"must not re-prompt after the first rejection",
	);
	assert.equal(toolEnds[0].result, "The user declined to run this tool.");
	assert.equal(toolEnds[1].result, "The user declined to run this tool.");
	assert.equal(toolMessages.length, 2);
});

// --- reportTokenUsage: pure formatting/reporting, no streamText involved ---

test("reportTokenUsage prefers real provider counts over the estimate", () => {
	let reported:
		| Parameters<NonNullable<AgentCallbacks["onTokenUsage"]>>[0]
		| undefined;
	const callbacks: AgentCallbacks = {
		onToken: () => {},
		onToolCallStart: () => {},
		onToolCallEnd: () => {},
		onComplete: () => {},
		onToolApproval: async () => true,
		onTokenUsage: (usage) => {
			reported = usage;
		},
	};

	reportTokenUsage(
		callbacks,
		"system",
		[{ role: "user", content: "hi" }],
		1000,
		{ inputTokens: 10, outputTokens: 5, totalTokens: 15 },
	);

	assert.equal(reported?.totalTokens, 15);
	assert.equal(reported?.contextWindow, 1000);
});

test("reportTokenUsage falls back to an estimate when there's no real usage", () => {
	let reported:
		| Parameters<NonNullable<AgentCallbacks["onTokenUsage"]>>[0]
		| undefined;
	const callbacks: AgentCallbacks = {
		onToken: () => {},
		onToolCallStart: () => {},
		onToolCallEnd: () => {},
		onComplete: () => {},
		onToolApproval: async () => true,
		onTokenUsage: (usage) => {
			reported = usage;
		},
	};

	reportTokenUsage(
		callbacks,
		"system prompt",
		[{ role: "user", content: "hello world" }],
		1000,
	);

	assert.ok(reported && reported.totalTokens > 0);
});

test("reportTokenUsage no-ops when the caller didn't ask for usage updates", () => {
	const callbacks: AgentCallbacks = {
		onToken: () => {},
		onToolCallStart: () => {},
		onToolCallEnd: () => {},
		onComplete: () => {},
		onToolApproval: async () => true,
	};
	// Should not throw with no onTokenUsage callback.
	reportTokenUsage(callbacks, "system", [], 1000);
});

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

	const { callbacks, tokens, getCompleted } = makeCallbacks();

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
	const { callbacks, toolEnds, getCompleted } = makeCallbacks(async () => {
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
