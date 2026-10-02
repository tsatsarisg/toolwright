import type { ToolSet } from "ai";
import type { ZodType } from "zod";
import { tools as defaultTools } from "./tools/index.ts";

/**
 * Execute a tool by name after approval.
 *
 * The toolset is injected (defaults to the app's real tools) so tests and
 * evals can dispatch against mocks. Args are validated against the tool's
 * schema first; a validation failure is returned to the model as text so it
 * can retry with corrected arguments rather than crashing the loop.
 */
export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	toolSet: ToolSet = defaultTools,
	abortSignal?: AbortSignal,
): Promise<string> {
	const tool = toolSet[name];

	if (!tool) {
		return `Unknown tool: ${name}`;
	}

	const execute = tool.execute;
	if (!execute) {
		// Provider tools (like webSearch) are executed by the provider, not us
		return `Provider tool ${name} - executed by model provider`;
	}

	// Validate against the tool's input schema before executing. Every tool in
	// this app defines its schema with zod, so this is a real ZodType, not a
	// hand-rolled structural guess at the SDK's schema shape.
	const schema = tool.inputSchema as ZodType | undefined;
	let validatedArgs: unknown = args;
	if (schema) {
		const parsed = schema.safeParse(args);
		if (!parsed.success) {
			return `Invalid arguments for ${name}: ${parsed.error.message}`;
		}
		validatedArgs = parsed.data;
	}

	abortSignal?.throwIfAborted();
	try {
		const result = await execute(validatedArgs as never, {
			toolCallId: "",
			messages: [],
			abortSignal,
			context: {},
		});

		return String(result);
	} catch (error) {
		abortSignal?.throwIfAborted();
		return `Error: ${error instanceof Error ? error.message : String(error)}`;
	}
}
