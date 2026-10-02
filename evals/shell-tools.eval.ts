import { shellTools } from "../src/agent/tools/index.ts";
import dataset from "./data/shell-tools.json" with { type: "json" };
import { runToolSelectionEval } from "./toolSelectionEval.ts";
import type { EvalData, EvalTarget } from "./types.ts";

/**
 * Shell Tools Selection Evaluation
 *
 * Tests whether the LLM correctly selects the shell command tool
 * (runCommand) based on user prompts.
 *
 * Categories:
 * - golden: Must select runCommand for explicit shell requests
 * - secondary: Likely selects runCommand, scored on precision/recall
 * - negative: Must NOT use shell for non-shell tasks
 */
await runToolSelectionEval(
	shellTools,
	dataset as Array<{ data: EvalData; target: EvalTarget }>,
	"shell-tools-selection",
);
