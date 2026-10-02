import { endpointURL } from "../config/endpoint.ts";
import type { ProviderSettings } from "../config/types.ts";

export function createProviderTransport(
	settings: ProviderSettings,
	context: { apiKey?: string; fetch?: typeof globalThis.fetch } = {},
): typeof globalThis.fetch {
	const apiKey = context.apiKey;
	const endpoint = endpointURL(settings.baseURL);
	const transport = context.fetch ?? globalThis.fetch;
	return async (input, init) => {
		const target = new URL(
			input instanceof Request ? input.url : String(input),
		);
		if (
			target.origin !== endpoint.origin ||
			!target.pathname.startsWith(`${endpoint.pathname.replace(/\/$/, "")}/`)
		) {
			throw new Error(
				"Refusing a request outside the configured provider endpoint.",
			);
		}
		if (settings.apiKeyEnv && !apiKey)
			throw new Error(`Missing provider credential: ${settings.apiKeyEnv}`);
		const headers = new Headers(init?.headers);
		// Suppress the SDK's OPENAI_API_KEY fallback and placeholder Authorization.
		if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
		else headers.delete("authorization");
		return transport(input, { ...init, headers, redirect: "error" });
	};
}
