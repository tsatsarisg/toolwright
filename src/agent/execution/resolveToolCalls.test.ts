import assert from "node:assert/strict";
import { test } from "node:test";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { recordCallbacks } from "../../../tests/helpers/callbacks.ts";
import type { ToolCallInfo } from "../types.ts";
import { markTool } from "./policy.ts";
import { resolveToolCalls } from "./resolveToolCalls.ts";

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
	const { callbacks, toolEnds } = recordCallbacks(async () => {
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
	const { callbacks, toolEnds } = recordCallbacks(async () => {
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
	const { callbacks, toolEnds } = recordCallbacks(async () => {
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

test("invalid calls permit recovery, but unavailable tools stop the remaining batch", async () => {
	const calls: ToolCallInfo[] = [
		{ toolCallId: "invalid", toolName: "writeFile", args: {} },
		{ toolCallId: "valid", toolName: "writeFile", args: { path: "a.txt" } },
		{ toolCallId: "unavailable", toolName: "__proto__", args: {} },
		{ toolCallId: "skipped", toolName: "writeFile", args: { path: "b.txt" } },
	];
	const written: string[] = [];
	const approved: unknown[] = [];
	const tools: ToolSet = {
		writeFile: markTool(
			tool({
				inputSchema: z.object({
					path: z.string(),
					content: z.string().default("hi"),
				}),
				execute: async ({ path }) => {
					written.push(path);
					return "wrote";
				},
			}),
			"write",
		),
	};
	const { callbacks, toolEnds } = recordCallbacks(async (_name, args) => {
		approved.push(args);
		return true;
	});
	const resolved = await resolveToolCalls(
		calls,
		tools,
		[],
		callbacks,
		() => {},
	);

	assert.deepEqual(written, ["a.txt"]);
	assert.deepEqual(approved, [{ path: "a.txt", content: "hi" }]);
	assert.deepEqual(resolved.failures, ["writeFile"]);
	assert.equal(resolved.rejected, true);
	assert.equal(resolved.toolMessages.length, calls.length);
	assert.match(toolEnds[0].result, /^Invalid arguments/);
	assert.equal(toolEnds[1].result, "wrote");
	assert.match(toolEnds[2].result, /^Tool unavailable/);
	assert.equal(toolEnds[3].result, "The user declined to run this tool.");
});
