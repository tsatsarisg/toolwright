#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ExecutionPolicy,
	type PermissionMode,
} from "./agent/execution/policy.ts";
import { portableHistory } from "./agent/history/filterMessages.ts";
import { runHeadless } from "./cli/headless.ts";
import { HELP } from "./cli/help.ts";
import {
	parseCliOptions,
	positiveIntegerOption,
	providerSelectionFromFlags,
	validateCliOptions,
} from "./cli/options.ts";
import { listModels, probeToolCalling } from "./providers/diagnostics.ts";
import { resolveProvider } from "./providers/resolve.ts";
import { initTelemetry } from "./providers/telemetry.ts";
import { restoreWorkspace } from "./sessions/snapshot.ts";
import { newSessionId, SessionStore } from "./sessions/store.ts";
import { Workspace } from "./workspace/workspace.ts";

async function main(): Promise<void> {
	const { values, positionals } = parseCliOptions(process.argv.slice(2));
	if (values.help) {
		console.log(HELP);
		return;
	}
	if (values.version) {
		console.log(
			JSON.parse(
				readFileSync(
					path.join(
						path.dirname(fileURLToPath(import.meta.url)),
						"../package.json",
					),
					"utf-8",
				),
			).version,
		);
		return;
	}
	const command = validateCliOptions(values, positionals);
	const workspace = await Workspace.open(values.cwd, values["allow-path"]);
	// Environment files are optional and are loaded only for execution, never help/version.
	if (typeof process.loadEnvFile === "function") {
		try {
			process.loadEnvFile(path.join(workspace.root, ".env"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error("Cannot load workspace .env file.");
		}
	}
	const store = new SessionStore(workspace.root, values["state-dir"]);
	if (command === "sessions") {
		for (const session of await store.list()) console.log(session.id);
		return;
	}
	const previousId =
		values.session ?? (values.resume ? await store.latest() : null);
	const previous = previousId ? await store.load(previousId) : null;
	if (previousId && !previous)
		throw new Error("Requested session was not found.");
	if (previous) restoreWorkspace(workspace, previous);

	const provider = resolveProvider(
		providerSelectionFromFlags(values, previous?.provider),
		{
			configPath: values.config,
			cwd: workspace.root,
			requireModel: !command || !!values["probe-tools"],
		},
	);
	if (
		previous?.provider?.localOnly &&
		!provider.settings.localOnly &&
		!values["allow-cloud-transition"]
	) {
		process.stderr.write(
			"This was a local-only session. Use --allow-cloud-transition to explicitly consent to changing its data policy.\n",
		);
		process.exitCode = 3;
		return;
	}
	if (command) {
		const models = await listModels(provider);
		if (command === "models") console.log(models.join("\n"));
		else {
			console.log(
				`Connected: ${provider.settings.baseURL} (${provider.settings.api}); ${models.length} model(s) available.`,
			);
			if (provider.settings.model && !models.includes(provider.settings.model))
				throw new Error(
					"Configured model is not listed. Select an available ID.",
				);
			if (values["probe-tools"]) {
				await probeToolCalling(provider);
				console.log("Tool-calling probe passed.");
			} else
				console.log(
					"Tool calling is untested. Add --model <id> --probe-tools to test it.",
				);
		}
		return;
	}
	const sessionId = previousId ?? newSessionId();
	if (
		previous?.provider &&
		(previous.provider.api !== provider.settings.api ||
			previous.provider.baseURL !== provider.settings.baseURL ||
			previous.provider.model !== provider.settings.model)
	)
		previous.history = portableHistory(previous.history);
	const policy = new ExecutionPolicy(values.mode as PermissionMode | undefined);
	const budgets = {
		maxSteps: positiveIntegerOption(values["max-steps"]),
		maxTokens: positiveIntegerOption(values["max-tokens"]),
		maxTurnMs: positiveIntegerOption(values["timeout-ms"]),
	};
	if (values.print !== undefined) {
		process.exitCode = await runHeadless({
			prompt: values.print,
			history: previous?.history ?? [],
			sessionId,
			provider,
			workspace,
			store,
			policy,
			budgets,
			json: !!values.json,
			approve: !!values.yes,
		});
		return;
	}
	initTelemetry(provider.settings);
	const [{ render }, { default: React }, { App }] = await Promise.all([
		import("ink"),
		import("react"),
		import("./ui/App.tsx"),
	]);
	render(
		React.createElement(App, {
			sessionId,
			provider,
			workspace,
			store,
			policy,
			budgets,
			configPath: values.config,
			initialHistory: previous?.history,
		}),
		{
			exitOnCtrlC: false,
			kittyKeyboard: { mode: "auto", flags: ["disambiguateEscapeCodes"] },
		},
	);
}
main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
