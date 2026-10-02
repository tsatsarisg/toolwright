import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentCallbacks } from "../types.ts";
import { reportTokenUsage } from "./usage.ts";

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
