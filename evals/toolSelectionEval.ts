import type { ToolSet } from "ai";
import {
	toolSelectionScore,
	toolsAvoided,
	toolsSelected,
} from "./evaluators.ts";
import { singleTurnExecutor } from "./executors.ts";
import { runEvaluation } from "./runEvaluation.ts";
import type { EvalData, EvalTarget } from "./types.ts";

/**
 * Shared wiring for single-turn tool-selection evals: golden prompts must
 * select the expected tools, negative prompts must avoid them, secondary
 * prompts are scored on precision/recall. Used by file-tools.eval.ts and
 * shell-tools.eval.ts, which differ only in tool set, dataset, and group name.
 */
export function runToolSelectionEval(
	toolSet: ToolSet,
	dataset: Array<{ data: EvalData; target: EvalTarget }>,
	groupName: string,
) {
	const executor = async (data: EvalData) => singleTurnExecutor(data, toolSet);

	return runEvaluation({
		data: dataset,
		executor,
		evaluators: {
			// For golden prompts: did it select all expected tools?
			toolsSelected: (output, target) => {
				if (target?.category !== "golden") return 1; // Skip for non-golden
				return toolsSelected(output, target);
			},
			// For negative prompts: did it avoid forbidden tools?
			toolsAvoided: (output, target) => {
				if (target?.category !== "negative") return 1; // Skip for non-negative
				return toolsAvoided(output, target);
			},
			// For secondary prompts: precision/recall score
			selectionScore: (output, target) => {
				if (target?.category !== "secondary") return 1; // Skip for non-secondary
				return toolSelectionScore(output, target);
			},
		},
		groupName,
	});
}
