import type { ToolSet } from "ai";
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

  // Validate against the tool's input schema before executing.
  const schema = tool.inputSchema as
    | { safeParse?: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } } }
    | undefined;
  let validatedArgs: unknown = args;
  if (schema && typeof schema.safeParse === "function") {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      return `Invalid arguments for ${name}: ${parsed.error?.message ?? "schema validation failed"}`;
    }
    validatedArgs = parsed.data;
  }

  const result = await execute(validatedArgs as never, {
    toolCallId: "",
    messages: [],
  });

  return String(result);
}
