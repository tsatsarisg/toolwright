import { Laminar } from "@lmnr-ai/lmnr";

let initialized = false;

/**
 * Initialize Laminar telemetry. Call once from the application entry point
 * (the composition root) — not as an import side effect — so that importing
 * the agent for tests or evals doesn't require an API key or open a tracer.
 */
export function initTelemetry(): void {
  if (initialized) return;
  const projectApiKey = process.env.LMNR_API_KEY;
  if (!projectApiKey) return;
  Laminar.initialize({ projectApiKey });
  initialized = true;
}
