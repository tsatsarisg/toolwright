import assert from "node:assert/strict";
import { test } from "node:test";
import { generateText, type ToolSet, tool } from "ai";
import { z } from "zod";
import { compactConversation } from "../agent/context/compaction.ts";
import { markTool } from "../agent/execution/policy.ts";
import { runAgent } from "../agent/run.ts";
import { selectProviderTools, tools } from "../agent/tools/index.ts";
import type { AgentCallbacks } from "../agent/types.ts";
import type { ModelApi } from "../config/types.ts";
import { listModels, probeToolCalling } from "./diagnostics.ts";
import { resolveProvider } from "./resolve.ts";

const configPath = "/private/tmp/toolwright-missing-test-config.json";
const sse = (events: unknown[]) =>
	new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);

function streamResponse(
	api: ModelApi,
	name?: string,
	args = '{"path":"fixture.ts"}',
) {
	if (api === "chat-completions") {
		const chunk = (delta: unknown, finish_reason: string | null = null) => ({
			id: "chat-test",
			object: "chat.completion.chunk",
			created: 1,
			model: "fixture-model",
			choices: [{ index: 0, delta, finish_reason }],
		});
		return name
			? sse([
					chunk({
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "call-test",
								type: "function",
								function: { name, arguments: args.slice(0, 8) },
							},
						],
					}),
					chunk({
						tool_calls: [{ index: 0, function: { arguments: args.slice(8) } }],
					}),
					chunk({}, "tool_calls"),
				])
			: sse([chunk({ role: "assistant", content: "done" }), chunk({}, "stop")]);
	}
	const item = {
		type: "function_call",
		id: "fc-test",
		call_id: "call-test",
		name,
		arguments: args,
		status: "completed",
	};
	return sse([
		{
			type: "response.created",
			response: { id: "resp-test", created_at: 1, model: "fixture-model" },
		},
		...(name
			? [
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { ...item, arguments: "" },
					},
					{
						type: "response.function_call_arguments.delta",
						output_index: 0,
						item_id: "fc-test",
						delta: args.slice(0, 8),
					},
					{
						type: "response.function_call_arguments.delta",
						output_index: 0,
						item_id: "fc-test",
						delta: args.slice(8),
					},
					{ type: "response.output_item.done", output_index: 0, item },
				]
			: [
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "message", id: "msg-test" },
					},
					{
						type: "response.output_text.delta",
						item_id: "msg-test",
						delta: "done",
					},
					{
						type: "response.output_item.done",
						output_index: 0,
						item: { type: "message", id: "msg-test" },
					},
				]),
		{
			type: "response.completed",
			response: { usage: { input_tokens: 20, output_tokens: 5 } },
		},
	]);
}

function jsonResponse(api: ModelApi, name?: string) {
	const args = '{"value":"toolwright-ok"}';
	return Response.json(
		api === "chat-completions"
			? {
					id: "chat-test",
					created: 1,
					model: "fixture-model",
					choices: [
						{
							index: 0,
							finish_reason: name ? "tool_calls" : "stop",
							message: {
								role: "assistant",
								content: name ? null : "SUMMARY",
								...(name && {
									tool_calls: [
										{
											id: "probe-test",
											type: "function",
											function: { name, arguments: args },
										},
									],
								}),
							},
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
				}
			: {
					id: "resp-test",
					created_at: 1,
					model: "fixture-model",
					output: name
						? [
								{
									type: "function_call",
									id: "fc-probe",
									call_id: "probe-test",
									name,
									arguments: args,
								},
							]
						: [
								{
									type: "message",
									id: "msg-summary",
									role: "assistant",
									content: [
										{ type: "output_text", text: "SUMMARY", annotations: [] },
									],
								},
							],
					usage: { input_tokens: 10, output_tokens: 2 },
				},
	);
}

function callbacks(
	approval: () => Promise<boolean> = async () => true,
): AgentCallbacks {
	return {
		onToken: () => {},
		onToolCallStart: () => {},
		onToolCallEnd: () => {},
		onComplete: () => {},
		onToolApproval: approval,
	};
}

for (const api of ["chat-completions", "responses"] as const) {
	test(`${api}: streamed read/edit round trips and compaction use the same endpoint`, async () => {
		const requests: Array<Record<string, unknown>> = [];
		let steps = 0;
		const provider = resolveProvider(
			{ profile: "lmstudio", model: "fixture-model", api, localOnly: true },
			{
				configPath,
				env: {
					OPENAI_API_KEY: "cloud-key-must-not-leak",
					LMNR_API_KEY: "cloud-trace-must-not-initialize",
				},
				fetch: async (url, init) => {
					assert.equal(
						String(url),
						`http://127.0.0.1:1234/v1/${api === "responses" ? "responses" : "chat/completions"}`,
					);
					assert.equal(new Headers(init?.headers).has("authorization"), false);
					assert.equal(init?.redirect, "error");
					const body = JSON.parse(String(init?.body)) as Record<
						string,
						unknown
					>;
					requests.push(body);
					if (!body.stream) return jsonResponse(api);
					steps++;
					return streamResponse(
						api,
						steps === 1 ? "readFile" : steps === 2 ? "editFile" : undefined,
					);
				},
			},
		);
		let reads = 0;
		let edits = 0;
		let approvals = 0;
		const toolSet: ToolSet = {
			readFile: tool({
				inputSchema: z.object({ path: z.string() }),
				execute: async () => {
					reads++;
					return "fixture source";
				},
			}),
			editFile: tool({
				inputSchema: z.object({ path: z.string() }),
				execute: async () => {
					edits++;
					return "fixture updated";
				},
			}),
		};
		const history = await runAgent(
			"fix fixture",
			[],
			callbacks(async () => {
				approvals++;
				return true;
			}),
			{
				resolvedProvider: provider,
				tools: { ...toolSet, readFile: markTool(toolSet.readFile, "read") },
				telemetry: true,
			},
		);
		assert.equal(reads, 1);
		assert.equal(edits, 1);
		assert.equal(approvals, 1);
		assert.equal(
			history.filter((message) => message.role === "tool").length,
			2,
		);
		assert.match(JSON.stringify(requests[1]), /fixture source/);
		assert.match(JSON.stringify(requests[2]), /fixture updated/);
		assert.equal(
			api === "responses"
				? requests[0].max_output_tokens
				: requests[0].max_tokens,
			2048,
		);
		const compacted = await compactConversation(
			[...history, { role: "user", content: "continue" }],
			provider,
		);
		assert.match(JSON.stringify(compacted), /SUMMARY/);
		assert.equal(requests.length, 4);
	});

	test(`${api}: local-only denies shell even with automatic approval`, async () => {
		let executed = false;
		let step = 0;
		const provider = resolveProvider(
			{ profile: "lmstudio", model: "fixture", api, localOnly: true },
			{
				configPath,
				env: {},
				fetch: async () =>
					streamResponse(
						api,
						step++ === 0 ? "runCommand" : undefined,
						'{"command":"curl example.com"}',
					),
			},
		);
		const tools: ToolSet = {
			runCommand: tool({
				inputSchema: z.object({ command: z.string() }),
				execute: async () => {
					executed = true;
					return "bad";
				},
			}),
		};
		let approvals = 0;
		await runAgent(
			"run a command",
			[],
			callbacks(async () => {
				approvals++;
				return true;
			}),
			{ resolvedProvider: provider, tools },
		);
		assert.equal(executed, false);
		assert.equal(approvals, 0);
	});

	test(`${api}: diagnostics list models and validate tool calling`, async () => {
		const provider = resolveProvider(
			{ profile: "lmstudio", model: "fixture", api },
			{
				configPath,
				env: {},
				fetch: async (url) =>
					String(url).endsWith("/models")
						? Response.json({ data: [{ id: "fixture" }] })
						: jsonResponse(api, "toolwright_probe"),
			},
		);
		assert.deepEqual(await listModels(provider), ["fixture"]);
		await probeToolCalling(provider);
	});
}

test("credential isolation, explicit local authentication, and transport guard", async () => {
	let authorization: string | null = null;
	let calls = 0;
	const provider = resolveProvider(
		{ baseURL: "https://custom.example/v1", model: "fixture" },
		{
			configPath,
			env: { OPENAI_API_KEY: "must-not-leak" },
			fetch: async (_url, init) => {
				calls++;
				authorization = new Headers(init?.headers).get("authorization");
				return Response.json({ data: [] });
			},
		},
	);
	await listModels(provider);
	assert.equal(authorization, null);
	await assert.rejects(
		provider.request("../../escape"),
		/outside the configured provider endpoint/,
	);
	assert.equal(calls, 1);
	const authenticated = resolveProvider(
		{ profile: "lmstudio", model: "fixture", apiKeyEnv: "LOCAL_TOKEN" },
		{
			configPath,
			env: { LOCAL_TOKEN: "local-token", OPENAI_API_KEY: "must-not-leak" },
			fetch: async (_url, init) => {
				authorization = new Headers(init?.headers).get("authorization");
				return Response.json({ data: [] });
			},
		},
	);
	await listModels(authenticated);
	assert.equal(authorization, "Bearer local-token");
});

test("OpenAI defaults use Responses with the configured credential", async () => {
	const provider = resolveProvider(
		{},
		{
			configPath,
			env: { OPENAI_API_KEY: "fixture-key" },
			fetch: async (url, init) => {
				assert.equal(String(url), "https://api.openai.com/v1/responses");
				assert.equal(JSON.parse(String(init?.body)).model, "gpt-6-luna");
				assert.equal(
					new Headers(init?.headers).get("authorization"),
					"Bearer fixture-key",
				);
				return jsonResponse("responses");
			},
		},
	);
	assert.equal(
		(await generateText({ model: provider.languageModel, prompt: "hello" }))
			.text,
		"SUMMARY",
	);
});

test("local limits/capabilities and missing credentials fail closed", async () => {
	const provider = resolveProvider(
		{
			profile: "lmstudio",
			model: "gpt-5-custom-local",
			contextWindow: 8192,
			maxOutputTokens: 1024,
			localOnly: true,
		},
		{ configPath, env: {} },
	);
	assert.equal(provider.limits.contextWindow, 8192);
	assert.equal(provider.settings.telemetry, false);
	assert.equal(provider.settings.capabilities.hostedWebSearch, false);
	assert.equal(
		selectProviderTools(provider.settings, tools).runCommand,
		undefined,
	);
	assert.equal(
		selectProviderTools(provider.settings, tools).webSearch,
		undefined,
	);
	assert.throws(
		() =>
			resolveProvider(
				{
					profile: "lmstudio",
					model: "fixture",
					contextWindow: 1024,
					maxOutputTokens: 1024,
				},
				{ configPath, env: {} },
			),
		/smaller than contextWindow/,
	);
	const cloud = resolveProvider(
		{},
		{
			configPath,
			env: {},
			fetch: async () => {
				throw new Error("must not reach transport");
			},
		},
	);
	await assert.rejects(listModels(cloud), /Missing provider credential/);
});

test("provider failures do not invoke a cloud fallback", async () => {
	let calls = 0;
	const provider = resolveProvider(
		{ profile: "lmstudio", model: "fixture", localOnly: true },
		{
			configPath,
			env: {},
			fetch: async (url) => {
				calls++;
				assert.ok(String(url).startsWith("http://127.0.0.1:1234/v1/"));
				return Response.json(
					{ error: { message: "local unavailable" } },
					{ status: 400 },
				);
			},
		},
	);
	await assert.rejects(
		runAgent("hello", [], callbacks(), { resolvedProvider: provider }),
		/local unavailable/,
	);
	assert.equal(calls, 1);
});
