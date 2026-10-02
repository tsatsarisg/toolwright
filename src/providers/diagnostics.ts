import { generateText, tool } from "ai";
import { z } from "zod";
import type { ResolvedProvider } from "./resolve.ts";
import { inferenceTelemetry } from "./telemetry.ts";

const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

export async function listModels(
	provider: ResolvedProvider,
): Promise<string[]> {
	let response: Response;
	try {
		response = await provider.request("models");
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith("Missing provider credential:")
		)
			throw error;
		throw new Error(
			`Cannot connect to ${provider.settings.baseURL}. Check that the API server is running and the endpoint is correct.`,
			{ cause: error },
		);
	}
	if (!response.ok)
		throw new Error(
			`Provider model listing failed (HTTP ${response.status}). Check endpoint and credentials.`,
		);
	const models = modelsSchema.safeParse(await response.json());
	if (!models.success)
		throw new Error("Provider returned an invalid model list.");
	return models.data.data.map((model) => model.id);
}

/** Explicit inference probe; it requests a harmless function but never executes model-selected code. */
export async function probeToolCalling(
	provider: ResolvedProvider,
): Promise<void> {
	if (!provider.settings.model)
		throw new Error("Select --model before probing tool calling.");
	if (!provider.settings.capabilities.tools)
		throw new Error("Tool calling is disabled in this profile.");
	const result = await generateText({
		model: provider.languageModel,
		telemetry: inferenceTelemetry(provider.settings),
		maxOutputTokens: Math.min(provider.limits.outputLimit, 512),
		abortSignal: AbortSignal.timeout(30000),
		maxRetries: 0,
		prompt: 'Call toolwright_probe with value "toolwright-ok".',
		toolChoice: "required",
		tools: {
			toolwright_probe: tool({
				description: "Return the requested diagnostic value.",
				inputSchema: z.object({ value: z.literal("toolwright-ok") }),
			}),
		},
	});
	if (
		!result.toolCalls.some(
			(call) =>
				call.toolName === "toolwright_probe" &&
				z.object({ value: z.literal("toolwright-ok") }).safeParse(call.input)
					.success,
		)
	) {
		throw new Error(
			"The model did not produce a valid diagnostic tool call. Check model/template tool support.",
		);
	}
}
