import type { ToolSet } from "ai";
import { z } from "zod";
import { estimateTokens } from "./tokenEstimator.ts";

export function estimateToolSchemaTokens(tools: ToolSet): number {
	return estimateTokens(
		JSON.stringify(
			Object.entries(tools).map(([name, definition]) => {
				let schema: unknown;
				try {
					schema = z.toJSONSchema(definition.inputSchema as z.ZodType);
				} catch {
					schema = {};
				}
				return { name, description: definition.description, schema };
			}),
		),
	);
}
