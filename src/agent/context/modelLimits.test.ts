import assert from "node:assert/strict";
import { test } from "node:test";
import {
	calculateUsagePercentage,
	DEFAULT_THRESHOLD,
	getModelLimits,
	isOverThreshold,
} from "./modelLimits.ts";

test("getModelLimits matches a known model exactly", () => {
	const limits = getModelLimits("gpt-5-mini");
	assert.equal(limits.contextWindow, 400000);
});

test("getModelLimits maps unknown gpt-5 variants to gpt-5 limits", () => {
	const limits = getModelLimits("gpt-5-nano-2025");
	assert.equal(limits.contextWindow, 400000);
});

test("getModelLimits falls back to defaults for unknown models", () => {
	const limits = getModelLimits("some-other-model");
	assert.equal(limits.contextWindow, 128000);
});

test("isOverThreshold respects the default threshold", () => {
	const window = 1000;
	const at = window * DEFAULT_THRESHOLD;
	assert.equal(isOverThreshold(at - 1, window), false);
	assert.equal(isOverThreshold(at + 1, window), true);
});

test("calculateUsagePercentage returns a percentage", () => {
	assert.equal(calculateUsagePercentage(250, 1000), 25);
});
