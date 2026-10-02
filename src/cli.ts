#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	DEFAULT_MODEL,
	type ModelApi,
	type ProviderKind,
} from "./agent/config.ts";
import { listModels, probeToolCalling } from "./agent/diagnostics.ts";
import { resolveProvider } from "./agent/model.ts";
import { ExecutionPolicy, type PermissionMode } from "./agent/policy.ts";
import { runAgent } from "./agent/run.ts";
import {
	newSessionId,
	restoreWorkspace,
	SessionStore,
	sessionSnapshot,
} from "./agent/session.ts";
import { portableHistory } from "./agent/system/filterMessages.ts";
import { initTelemetry } from "./agent/telemetry.ts";
import { Workspace } from "./agent/workspace.ts";
import type { RunOutcome } from "./types.ts";

const HELP = `toolwright — a coding CLI agent

Usage:
  toolwright                              Interactive coding session
  toolwright -p "prompt"                   Run one task and exit
  toolwright --resume                      Resume latest workspace session
  toolwright --session <id>                Resume a particular session
  toolwright sessions                     List workspace sessions
  toolwright models --profile lmstudio     List available model IDs
  toolwright doctor --profile lmstudio     Check provider connectivity

Options:
  -m, --model <id>               Model ID (OpenAI default: ${DEFAULT_MODEL})
      --profile <name>           User profile or built-in openai/lmstudio
      --provider <kind>          openai or openai-compatible
      --base-url <url>           API endpoint including /v1
      --api <protocol>           responses or chat-completions
      --api-key-env <name>       Credential variable for this endpoint
      --config <path>            User configuration file
      --cwd <directory>          Workspace (default: current directory)
      --allow-path <directory>   Additional file access root; repeatable
      --mode <mode>              edit (approval gated) or plan (read only)
      --context-window <n>       Actual loaded context size
      --max-output-tokens <n>    Output reserve/cap
      --max-steps <n>            Model step limit (default: 40)
      --max-tokens <n>           Cumulative turn tokens (default: 200000)
      --timeout-ms <n>           Turn deadline (default: 600000)
      --local-only               Loopback inference; disable hosted tools, telemetry, shell
      --trust-project-config     Load workspace .toolwright/config.json
      --allow-cloud-transition   Consent to send local-only session history to a cloud profile
      --probe-tools              Test tool calling (doctor only; sends inference)
      --state-dir <directory>    Session storage root
  -p, --print <text>             Run one task non-interactively
      --json                     Emit JSON events (requires -p)
  -y, --yes                      Approve requests in -p; does not override policy
  -v, --version                  Version
  -h, --help                     Help

Interactive: /help /model /plan /diff /compact /exit
Shift+Enter adds a line; Escape cancels the active turn.
Exit codes: 0 success, 1 failure, 2 limit, 3 approval blocked, 130 cancelled.
`;

function positive(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number <= 0)
		throw new Error("Budget and context options must be positive integers.");
	return number;
}
async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
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
	const restoring =
		!values.profile && !values.provider ? previous?.provider : undefined;
	const provider = resolveProvider(
		{
			profile: values.profile ?? restoring?.profile,
			provider: (values.provider ?? restoring?.provider) as
				| ProviderKind
				| undefined,
			api: (values.api ?? restoring?.api) as ModelApi | undefined,
			baseURL: values["base-url"] ?? restoring?.baseURL,
			apiKeyEnv: values["api-key-env"],
			model: values.model ?? restoring?.model,
			contextWindow: positive(values["context-window"]),
			maxOutputTokens: positive(values["max-output-tokens"]),
			localOnly: values["local-only"] ?? restoring?.localOnly,
			trustProjectConfig: values["trust-project-config"],
		},
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
		maxSteps: positive(values["max-steps"]),
		maxTokens: positive(values["max-tokens"]),
		maxTurnMs: positive(values["timeout-ms"]),
	};
	if (values.print !== undefined) {
		const controller = new AbortController();
		const interrupt = () => controller.abort(new Error("Interrupted"));
		process.once("SIGINT", interrupt);
		process.once("SIGTERM", interrupt);
		let outcome: RunOutcome | undefined;
		let saveFailed = false;
		const emit = (event: Record<string, unknown>) => {
			if (values.json) process.stdout.write(`${JSON.stringify(event)}\n`);
		};
		emit({
			type: "session",
			id: sessionId,
			workspace: workspace.root,
			profile: provider.settings.profile,
			model: provider.settings.model,
			mode: policy.mode,
		});
		try {
			await runAgent(
				values.print,
				previous?.history ?? [],
				{
					onToken: (text) => {
						if (values.json) emit({ type: "token", text });
						else process.stdout.write(text);
					},
					onToolCallStart: (name, args, id) =>
						emit({ type: "tool-start", name, args, id }),
					onToolCallEnd: (id, result) => emit({ type: "tool-end", id, result }),
					onTokenUsage: (usage) => emit({ type: "usage", ...usage }),
					onToolApproval: async (name, args, details) => {
						emit({
							type: "approval",
							name,
							args,
							preview: details?.preview,
							approved: !!values.yes,
						});
						return !!values.yes;
					},
					onCommandOutput: (text) => {
						if (values.json) emit({ type: "command-output", text });
						else process.stderr.write(text);
					},
					onOutcome: (result) => {
						outcome = result;
						emit({
							type: "outcome",
							...result,
							files: [...workspace.changes.keys()],
							commands: workspace.commands.map((c) => ({
								command: c.command,
								exitCode: c.exitCode,
								timedOut: c.timedOut,
								cancelled: c.cancelled,
							})),
						});
					},
					onCheckpoint: async (history) => {
						try {
							await store.save(
								sessionSnapshot(
									sessionId,
									history,
									workspace,
									provider.settings,
									outcome,
								),
							);
						} catch (error) {
							saveFailed = true;
							process.stderr.write(
								`Session save failed: ${error instanceof Error ? error.message : error}\n`,
							);
							emit({
								type: "session-error",
								message: "Checkpoint could not be persisted",
							});
						}
					},
					onComplete: (text) => {
						if (values.json) emit({ type: "complete", text });
						else {
							process.stdout.write("\n");
							process.stderr.write(`${workspace.report()}\n`);
							if (outcome?.status !== "success")
								process.stderr.write(`Stopped: ${outcome?.reason}\n`);
						}
					},
				},
				{
					resolvedProvider: provider,
					workspace,
					policy,
					...budgets,
					signal: controller.signal,
					telemetry: false,
				},
			);
		} catch (error) {
			emit({
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			});
			if (!values.json)
				process.stderr.write(
					`${error instanceof Error ? error.message : error}\n`,
				);
		} finally {
			process.removeListener("SIGINT", interrupt);
			process.removeListener("SIGTERM", interrupt);
		}
		process.exitCode = saveFailed
			? 1
			: {
					success: 0,
					failed: 1,
					limited: 2,
					"approval-blocked": 3,
					cancelled: 130,
				}[outcome?.status ?? "failed"];
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
