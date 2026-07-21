import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelMessage } from "ai";
import {
	compactConversation,
	findRecentBoundary,
	findTaskIndex,
	messagesToText,
} from "./compaction.ts";

const user = (content: string): ModelMessage => ({ role: "user", content });
const assistant = (content: string): ModelMessage => ({
	role: "assistant",
	content,
});

test("findTaskIndex finds the first user message", () => {
	const messages = [assistant("ignored"), user("the task"), user("later")];
	assert.equal(findTaskIndex(messages), 1);
});

test("findTaskIndex returns -1 when there is no user message", () => {
	assert.equal(findTaskIndex([assistant("only assistant here")]), -1);
});

test("findRecentBoundary returns the last user message index", () => {
	const messages = [user("first"), assistant("reply"), user("second")];
	assert.equal(findRecentBoundary(messages), 2);
});

test("findRecentBoundary returns messages.length when there's no user message", () => {
	const messages = [assistant("only assistant")];
	assert.equal(findRecentBoundary(messages), messages.length);
});

test("messagesToText renders role-tagged lines", () => {
	const text = messagesToText([user("hi"), assistant("hello")]);
	assert.match(text, /\[USER\]: hi/);
	assert.match(text, /\[ASSISTANT\]: hello/);
});

test("compactConversation pins the first user message and summarizes the middle", async () => {
	const messages = [
		user("the original task"),
		assistant("working on it"),
		user("more detail"),
		assistant("still working"),
		user("final ask"), // recent boundary
	];

	let summarizedPrompt = "";
	const result = await compactConversation(
		messages,
		"fake-model",
		async (prompt) => {
			summarizedPrompt = prompt;
			return "SUMMARY";
		},
	);

	assert.equal(
		result[0].content,
		"the original task",
		"task must survive verbatim",
	);
	assert.match(String(result[1].content), /SUMMARY/);
	assert.equal(result[2].content, "final ask", "recent tail is kept verbatim");
	assert.match(summarizedPrompt, /working on it/);
	assert.match(summarizedPrompt, /more detail/);
	assert.doesNotMatch(
		summarizedPrompt,
		/final ask/,
		"the recent tail must not be folded into what gets summarized",
	);
});

test("compactConversation is a no-op when there's nothing old enough to summarize", async () => {
	const messages = [user("just one message")];
	let called = false;
	const result = await compactConversation(messages, "fake-model", async () => {
		called = true;
		return "SUMMARY";
	});

	assert.equal(called, false);
	assert.deepEqual(result, messages);
});

test("compactConversation drops system messages, which the caller owns separately", async () => {
	const messages: ModelMessage[] = [
		{ role: "system", content: "system prompt" },
		user("the task"),
		assistant("reply"),
		user("later ask"),
	];

	const result = await compactConversation(
		messages,
		"fake-model",
		async () => "SUMMARY",
	);

	assert.ok(result.every((m) => m.role !== "system"));
});
