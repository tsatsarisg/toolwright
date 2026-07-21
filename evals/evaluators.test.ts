import assert from "node:assert/strict";
import { test } from "node:test";
import {
	toolOrderCorrect,
	toolSelectionScore,
	toolsAvoided,
	toolsSelected,
} from "./evaluators.ts";
import type {
	EvalTarget,
	MultiTurnResult,
	MultiTurnTarget,
	SingleTurnResult,
} from "./types.ts";

function multiResult(order: string[]): MultiTurnResult {
	return {
		text: "",
		steps: [],
		toolsUsed: [...new Set(order)],
		toolCallOrder: order,
	};
}

test("toolOrderCorrect returns 1 when the full order is present", () => {
	const out = multiResult(["a", "b", "c"]);
	const target = { expectedToolOrder: ["a", "b"] } as MultiTurnTarget;
	assert.equal(toolOrderCorrect(out, target), 1);
});

test("toolOrderCorrect scores partial in-order matches", () => {
	const out = multiResult(["a", "x"]);
	const target = { expectedToolOrder: ["a", "b"] } as MultiTurnTarget;
	assert.equal(toolOrderCorrect(out, target), 0.5);
});

test("toolOrderCorrect ignores wrong ordering", () => {
	const out = multiResult(["b", "a"]);
	const target = { expectedToolOrder: ["a", "b"] } as MultiTurnTarget;
	// 'a' matches at index 0; 'b' already passed -> only 1 of 2 in order.
	assert.equal(toolOrderCorrect(out, target), 0.5);
});

test("toolsSelected requires every expected tool to appear", () => {
	const out = multiResult(["readFile"]);
	const hit = { expectedToolOrder: ["readFile"] } as MultiTurnTarget;
	const miss = {
		expectedToolOrder: ["readFile", "writeFile"],
	} as MultiTurnTarget;
	assert.equal(toolsSelected(out, hit), 1);
	assert.equal(toolsSelected(out, miss), 0);
});

test("toolsAvoided fails when a forbidden tool was used", () => {
	const out = multiResult(["deleteFile"]);
	const target = { forbiddenTools: ["deleteFile"] } as MultiTurnTarget;
	assert.equal(toolsAvoided(out, target), 0);
});

test("toolSelectionScore is a perfect F1 for an exact match", () => {
	const out: SingleTurnResult = {
		toolCalls: [],
		toolNames: ["readFile"],
		selectedAny: true,
	};
	const target = {
		expectedTools: ["readFile"],
		category: "golden",
	} as EvalTarget;
	assert.equal(toolSelectionScore(out, target), 1);
});
