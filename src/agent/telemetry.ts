import { OpenTelemetry } from "@ai-sdk/otel";
import { getTracer, Laminar } from "@lmnr-ai/lmnr";
import type { ProviderSettings } from "./config.ts";

let initialized = false;

/** Per-call integrations avoid globally enabling tracing for local sessions. */
export function inferenceTelemetry(settings: ProviderSettings, enabled = true) {
	if (settings.localOnly || !settings.telemetry || !enabled)
		return { isEnabled: false };
	return {
		isEnabled: true,
		recordInputs: process.env.TOOLWRIGHT_TELEMETRY_RECORD_IO === "1",
		recordOutputs: process.env.TOOLWRIGHT_TELEMETRY_RECORD_IO === "1",
		integrations: [new OpenTelemetry({ tracer: getTracer() })],
	};
}

/**
 * Initialize Laminar telemetry. Call once from the application entry point
 * (the composition root) — not as an import side effect — so that importing
 * the agent for tests or evals doesn't require an API key or open a tracer.
 */
export function initTelemetry(settings: ProviderSettings): void {
	if (settings.localOnly || !settings.telemetry) return;
	if (initialized) return;
	const projectApiKey = process.env.LMNR_API_KEY;
	if (!projectApiKey) return;
	Laminar.initialize({ projectApiKey, instrumentModules: {} });
	initialized = true;
}
