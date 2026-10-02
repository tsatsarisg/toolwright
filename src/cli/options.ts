import { parseArgs } from "node:util";
import type {
	ModelApi,
	ProviderKind,
	ProviderSelection,
} from "../config/types.ts";
import type { SessionFile } from "../sessions/schema.ts";

export function positiveIntegerOption(
	value: string | undefined,
): number | undefined {
	if (value === undefined) return undefined;
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number <= 0)
		throw new Error("Budget and context options must be positive integers.");
	return number;
}
export function parseCliOptions(args: string[]) {
	return parseArgs({
		args,
		allowPositionals: true,
		options: {
			model: { type: "string", short: "m" },
			profile: { type: "string" },
			provider: { type: "string" },
			"base-url": { type: "string" },
			api: { type: "string" },
			"api-key-env": { type: "string" },
			config: { type: "string" },
			cwd: { type: "string" },
			"allow-path": { type: "string", multiple: true },
			mode: { type: "string" },
			"context-window": { type: "string" },
			"max-output-tokens": { type: "string" },
			"max-steps": { type: "string" },
			"max-tokens": { type: "string" },
			"timeout-ms": { type: "string" },
			"local-only": { type: "boolean" },
			"trust-project-config": { type: "boolean" },
			"allow-cloud-transition": { type: "boolean" },
			"probe-tools": { type: "boolean" },
			"state-dir": { type: "string" },
			print: { type: "string", short: "p" },
			json: { type: "boolean" },
			resume: { type: "boolean" },
			session: { type: "string" },
			yes: { type: "boolean", short: "y" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
}

type CliValues = ReturnType<typeof parseCliOptions>["values"];

export function validateCliOptions(values: CliValues, positionals: string[]) {
	const command = positionals[0];
	if (
		positionals.length > 1 ||
		(command && !["models", "doctor", "sessions"].includes(command))
	)
		throw new Error("Unknown command. Use --help.");
	if (values["probe-tools"] && command !== "doctor")
		throw new Error("--probe-tools is only available with doctor.");
	if (command && values.print !== undefined)
		throw new Error("Use subcommands separately from --print.");
	if (values.json && values.print === undefined)
		throw new Error("--json requires --print.");
	if (values.mode && !["plan", "edit"].includes(values.mode))
		throw new Error("--mode must be plan or edit.");
	return command;
}

export function providerSelectionFromFlags(
	values: CliValues,
	previous?: SessionFile["provider"],
): ProviderSelection {
	const restoring = !values.profile && !values.provider ? previous : undefined;
	return {
		profile: values.profile ?? restoring?.profile,
		provider: (values.provider ?? restoring?.provider) as
			| ProviderKind
			| undefined,
		api: (values.api ?? restoring?.api) as ModelApi | undefined,
		baseURL: values["base-url"] ?? restoring?.baseURL,
		apiKeyEnv: values["api-key-env"],
		model: values.model ?? restoring?.model,
		contextWindow: positiveIntegerOption(values["context-window"]),
		maxOutputTokens: positiveIntegerOption(values["max-output-tokens"]),
		localOnly: values["local-only"] ?? restoring?.localOnly,
		trustProjectConfig: values["trust-project-config"],
	};
}
