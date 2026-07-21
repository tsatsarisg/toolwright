#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { render } from "ink";
import React from "react";
import { runAgent } from "./agent/run.ts";
import { latestSessionId, loadSession, newSessionId } from "./agent/session.ts";
import { initTelemetry } from "./agent/telemetry.ts";
import type { AgentCallbacks } from "./types.ts";
import { App } from "./ui/App.tsx";

const HELP = `friday — a terminal AI agent

Usage:
  friday                        Start the interactive session
  friday -p "prompt"            Run one prompt non-interactively and exit
  friday --resume               Continue the most recent session in this directory

Options:
  -m, --model <id>   Model id to use (default: gpt-5-mini)
  -p, --print <text> Run one prompt non-interactively, print the response, and exit
      --resume       Resume the most recent session for the current directory
  -y, --yes          Auto-approve every tool call (only applies to -p; use with care)
  -v, --version      Print the version number
  -h, --help         Show this help
`;

function printVersion(): void {
	const dir = path.dirname(fileURLToPath(import.meta.url));
	const pkg = JSON.parse(
		readFileSync(path.join(dir, "../package.json"), "utf-8"),
	);
	console.log(pkg.version);
}

/**
 * Non-interactive one-shot mode: run a single prompt and exit, for scripting
 * and CI use. Read-only tools still run automatically (see READ_ONLY_TOOLS in
 * agent/tools/index.ts); anything else is declined unless --yes was passed —
 * there's no human here to ask, so the safe default is to fail closed.
 */
async function runOnce(
	prompt: string,
	options: { model?: string; autoApprove: boolean },
): Promise<void> {
	const callbacks: AgentCallbacks = {
		onToken: (token) => process.stdout.write(token),
		onToolCallStart: () => {},
		onToolCallEnd: () => {},
		onComplete: () => process.stdout.write("\n"),
		onToolApproval: async () => options.autoApprove,
	};

	// Telemetry is off here: a scripted one-shot call doesn't need a trace, and
	// it sidesteps a span-lifecycle issue in the AI SDK/Laminar integration
	// that surfaces as an unhandled rejection when a streamText call errors.
	await runAgent(prompt, [], callbacks, {
		model: options.model,
		telemetry: false,
	});
}

async function main(): Promise<void> {
	initTelemetry();

	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			model: { type: "string", short: "m" },
			print: { type: "string", short: "p" },
			resume: { type: "boolean" },
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
		printVersion();
		return;
	}

	if (values.print !== undefined) {
		await runOnce(values.print, {
			model: values.model,
			autoApprove: !!values.yes,
		});
		return;
	}

	let sessionId = newSessionId();
	let initialHistory: Awaited<ReturnType<typeof loadSession>> = null;
	if (values.resume) {
		const previousId = await latestSessionId();
		if (previousId) {
			initialHistory = await loadSession(previousId);
			sessionId = previousId;
		}
	}

	render(
		React.createElement(App, {
			sessionId,
			model: values.model,
			initialHistory: initialHistory ?? undefined,
		}),
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
