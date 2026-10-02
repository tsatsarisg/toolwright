import { LOCAL_BASE_URL, OPENAI_BASE_URL } from "./defaults.ts";
import type { ProviderProfile } from "./schema.ts";
import type { ProviderSelection, ProviderSettings } from "./types.ts";

export function endpointURL(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Provider base URL must be an absolute HTTP(S) URL.");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"Provider base URL must use HTTP(S) without embedded credentials, query, or fragment.",
		);
	}
	return url;
}

export function defaultEndpoint(
	provider: ProviderSettings["provider"],
): string {
	return provider === "openai" ? OPENAI_BASE_URL : LOCAL_BASE_URL;
}

/** Credentials belong to the selected origin, rather than to a provider-family name. */
export function credentialVariableFor(
	selection: ProviderSelection,
	profile: ProviderProfile,
	endpoint: Pick<ProviderSettings, "provider" | "baseURL">,
): string | undefined {
	const origin = endpointURL(endpoint.baseURL).origin;
	const originalOrigin = endpointURL(
		profile.baseURL ?? defaultEndpoint(profile.provider),
	).origin;
	const switched =
		selection.provider !== undefined && selection.provider !== profile.provider;
	return (
		selection.apiKeyEnv ??
		(origin === originalOrigin && !switched ? profile.apiKeyEnv : undefined) ??
		(endpoint.provider === "openai" &&
		origin === endpointURL(OPENAI_BASE_URL).origin
			? "OPENAI_API_KEY"
			: undefined)
	);
}
