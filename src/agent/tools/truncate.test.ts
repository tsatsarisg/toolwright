import assert from "node:assert/strict";
import { test } from "node:test";
import { truncate, truncateOutput } from "./truncate.ts";

test("truncateOutput leaves short text untouched", () => {
	assert.equal(truncateOutput("hello", 100), "hello");
});

test("truncateOutput caps long text and appends a marker", () => {
	const result = truncateOutput("x".repeat(50), 10);
	assert.ok(result.startsWith("x".repeat(10)));
	assert.match(result, /output truncated: 40 more characters omitted/);
});

test("truncateOutput keeps exactly-at-limit text whole", () => {
	const text = "a".repeat(10);
	assert.equal(truncateOutput(text, 10), text);
});

test("truncate leaves short text untouched", () => {
	assert.equal(truncate("hello", 10), "hello");
});

test("truncate caps long text with a short marker", () => {
	assert.equal(truncate("hello world", 5), "hello...");
});

test("truncate supports a custom marker", () => {
	assert.equal(truncate("hello world", 5, "…"), "hello…");
});
