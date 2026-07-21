import { fileTools } from "../src/agent/tools/index.ts";
import dataset from "./data/file-tools.json" with { type: "json" };
import { runToolSelectionEval } from "./toolSelectionEval.ts";
import type { EvalData, EvalTarget } from "./types.ts";

/**
 * File Tools Selection Evaluation
 *
 * Tests whether the LLM correctly selects file-related tools
 * (readFile, writeFile, listFiles, deleteFile) based on user prompts.
 *
 * Categories:
 * - golden: Must select specific expected tools
 * - secondary: Likely selects certain tools, scored on precision/recall
 * - negative: Must NOT select any file tools
 */
runToolSelectionEval(
	fileTools,
	dataset as Array<{ data: EvalData; target: EvalTarget }>,
	"file-tools-selection",
);
