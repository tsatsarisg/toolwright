# Toolwright

A terminal coding agent with streaming responses, repository tools, approval-controlled editing and shell execution, and durable sessions. Supports OpenAI Responses and OpenAI-compatible Chat Completions servers, including LM Studio. Built in TypeScript with the AI SDK and an Ink terminal interface.

## Start

Requires Node.js 22.13 or newer and pnpm 12.8.1 (pinned in `package.json`). An optional workspace `.env` can supply environment variables. The first coding release targets macOS and Linux.

Install the pinned package manager with `corepack enable` and `corepack install`, or use an existing pnpm 12 installation.

The built-in OpenAI profile starts with `gpt-6-luna`, the lowest-cost model in the current GPT-6 family, using the Responses API. Select another model with `--model` or a saved profile. See [official model specifications and pricing](https://developers.openai.com/api/docs/models/gpt-6-luna).

```sh
pnpm install
pnpm build
export OPENAI_API_KEY=your-key
node dist/cli.js --cwd /path/to/project
```

Use `npm install -g .` after building to install the `toolwright` command. Help and version work from any directory without credentials or a `.env` file.

```sh
toolwright --help
toolwright -p "Inspect the failing tests and propose a fix" --mode plan
toolwright -p "Fix the failing test and verify the change" --yes
toolwright -p "Explain this repository" --json
```

`--yes` approves requested operations in headless mode; plan mode and other hard policy denials still apply. Shell commands execute on the host with its normal permissions. File-tool confinement does not sandbox an approved shell command.

## Local models

Start LM Studio's API server, load a model that supports tool calling, then select its exact model ID:

```sh
toolwright models --profile lmstudio
toolwright doctor --profile lmstudio --model <loaded-model-id> --probe-tools
toolwright --profile lmstudio --model <loaded-model-id> --context-window 8192
```

The built-in LM Studio profile uses `http://127.0.0.1:1234/v1` and Chat Completions. `--base-url` selects another endpoint. Set `--context-window` to the model's actual loaded context size; unknown compatible models default to 8192 tokens with a 2048-token output reserve. Diagnostics test connectivity, and the explicit tool probe makes an inference request without executing any tool.

For strict local inference:

```sh
toolwright --profile lmstudio --model <loaded-model-id> --local-only
```

`--local-only` requires a loopback inference endpoint and disables hosted search, tracing, shell execution, and external media inputs. This mode relies on your local inference server remaining local. A normal LM Studio profile allows separately approved host commands for testing and builds. Compatible profiles disable telemetry by default.

See [configuration](docs/configuration.md) for saved profiles, endpoint credentials, protocol selection, limits, and project trust.

## Coding and permissions

The agent inspects the workspace, reads applicable root and nested `AGENTS.md` guidance, proposes focused edits with diffs, executes approved checks, and reports actual file changes and command results. Git status/diff tools are read only; initial dirty and untracked work is recorded and preserved. Binary reads, search results, command output, and per-turn inference are bounded.

File tools default to the selected workspace (`--cwd`), resolve symlinks, and reject escapes. Add an explicit `--allow-path /other/directory` for additional file access. The old `TOOLWRIGHT_ALLOW_UNSAFE_PATHS` bypass no longer applies. Read tools run automatically; writes, deletes, and shell commands require approval in edit mode. Session grants apply to a particular canonical path or exact command. Deletes and mutations outside the workspace require individual approval. Plan mode permits only reads.

Interactive commands: `/help`, `/model [profile] <id>`, `/plan`, `/diff`, `/compact`, `/exit`. Shift+Enter or Alt+Enter adds a line when supported by the terminal; pasted multiline input is retained. Escape or Ctrl+C cancels an active turn; Ctrl+C exits when idle. Switching a local-only session to a non-local-only profile requires explicit consent before sending its history.

Budgets: `--max-steps`, `--max-tokens`, `--timeout-ms`, `--max-output-tokens`. Context is checked before each request, including tool schemas and instructions, with compaction during long tool loops. Limits and repeated failures produce explicit stop reasons.

## Sessions and automation

```sh
toolwright sessions
toolwright --resume
toolwright --session <id>
toolwright --session <id> --profile openai --allow-cloud-transition
```

Sessions live under `~/.toolwright/sessions/<workspace-hash>/`. Versioned metadata includes history, provider identity, outcome/usage, original file contents, changes, and executed commands. Writes are atomic and checkpoint completed tool results. Resume restores history without automatically replaying completed operations. Legacy history-only sessions remain readable and their original files are retained. Permission grants and credentials are not saved. Session contents can contain source code and tool output.

`--state-dir` selects another storage root. Headless `--json` emits newline-delimited session, token, tool, approval, command-output, usage, outcome, completion, and error events. Outcomes include tracked changes and actual verification commands.

| Exit code | Outcome |
| --- | --- |
| 0 | Completed |
| 1 | Failed, including session-save failure |
| 2 | Context, step, token, time, or repeated-failure limit |
| 3 | Approval or policy blocked |
| 130 | Cancelled |

## Validation

Dependencies use exact versions and a lockfile. Following [pnpm's supply-chain guidance](https://pnpm.io/supply-chain-security), installs enforce a seven-day release delay, reject missing publication dates and trust downgrades, block exotic transitive sources, and require explicit decisions for new dependency build scripts. The existing reviewed `slow-redact@0.3.2` trust exception is limited to that version and automatically pruned when unused. Use `pnpm install --frozen-lockfile` in CI.

TypeScript 7 provides the native compiler through the existing `tsc` commands. Both TypeScript configurations resolve symlinks normally, as recommended by [pnpm's TypeScript recipe](https://pnpm.io/typescript). Provider and tool-type packages are direct dependencies so exported declarations remain portable with pnpm's isolated layout; the current tree needs no type-fixer plugin or peer overrides.

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm eval:coding
pnpm eval:coding --profile lmstudio --model fixture
```

The default coding evaluations use scripted inference and isolated temporary workspaces, requiring no credentials or network. Deterministic tests exercise both API protocols, fragmented tool arguments, permissions, symlink confinement, dirty repositories, failed checks, cancellation/resume, and compaction with an 8k context window.

`pnpm eval` aliases the scripted coding suite. The `eval:file-tools`, `eval:shell-tools`, and `eval:agent` scripts explicitly run live evaluations through the project's provider-aware runner using the installed `tsx`.

Live coding evaluations use the same objective fixtures with your selected model:

```sh
pnpm eval:coding --live --profile openai --model gpt-6-luna
pnpm eval:coding --live --profile lmstudio --model <loaded-model-id> \
  --server-version <version> --quantization <format> --hardware <description>
```

Each result records completion, actual checks, invalid/denied calls, unauthorized actions, context failure, latency, tokens, and model/server/context/hardware details. Live runs cost inference tokens and are opt in. The implementation has deterministic regression coverage; live OpenAI/LM Studio model quality has not been established. A model is a supported live baseline only after this suite passes with zero unauthorized actions on the recorded configuration.

Existing tool-selection and multiturn evals also select profiles through dataset configuration or `TOOLWRIGHT_PROFILE`/`TOOLWRIGHT_MODEL`. Cloud tracing requires `LMNR_API_KEY` and an eligible telemetry-enabled profile. `TOOLWRIGHT_TELEMETRY_RECORD_IO=1` explicitly opts into recording prompt/tool content.

## Source

`src/cli.ts` wires CLI/headless operation; `src/ui/` contains the terminal interface. `src/agent/` contains configuration, adapters, execution policy, workspace operations, sessions, and context management. `evals/` contains objective coding and tool-selection evaluations.

## License

This project is for viewing and educational reference only. See [LICENSE](LICENSE).
