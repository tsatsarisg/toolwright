import { evaluate } from "@lmnr-ai/lmnr";
import { resolveProvider } from "../src/agent/model.ts";

/** Local profiles run the same assertions without initializing Laminar or exporting task content. */
export async function runEvaluation<
	T extends { config?: { profile?: string; model?: string } },
	U,
	R,
>(options: {
	data: Array<{ data: T; target: U }>;
	executor: (data: T) => Promise<R>;
	evaluators: Record<
		string,
		(output: R, target?: U) => number | Promise<number>
	>;
	groupName: string;
}): Promise<void> {
	const cloudTracing = options.data.every(({ data }) => {
		const { settings } = resolveProvider(data.config);
		return !settings.localOnly && settings.telemetry;
	});
	if (cloudTracing && process.env.LMNR_API_KEY) {
		await evaluate({
			...options,
			config: { projectApiKey: process.env.LMNR_API_KEY },
		});
		return;
	}
	for (const [index, row] of options.data.entries()) {
		const output = await options.executor(row.data);
		const scores: Record<string, number> = {};
		for (const [name, evaluator] of Object.entries(options.evaluators))
			scores[name] = await evaluator(output, row.target);
		console.log(
			JSON.stringify({ group: options.groupName, case: index + 1, scores }),
		);
	}
}
