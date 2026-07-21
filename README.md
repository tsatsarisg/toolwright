# Friday — Terminal AI Agent

[![CI](https://github.com/tsatsarisg/friday-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/tsatsarisg/friday-agent/actions/workflows/ci.yml)

A general-purpose, terminal-based AI agent built from first principles in TypeScript. No agent frameworks — just a custom tool-calling loop with conversation history, built on the Vercel AI SDK with an Ink (React) terminal UI.

## Features

- **Custom agent loop** — streaming tool-calling loop with conversation history, no framework magic
- **File tools** — read, write, targeted edit (`editFile`), list, and delete files
- **Code search** — recursive glob (`globFiles`) and content grep (`searchCode`), so the agent doesn't need shell access just to explore a codebase
- **Shell tool** — execute commands with human-in-the-loop approval
- **Tiered approval** — read-only tools run without a prompt; anything with side effects is gated, with a per-session "always allow" option and elevated styling for destructive actions
- **Session persistence** — every turn is saved to disk; resume the latest session with `--resume`
- **Non-interactive mode** — `-p "prompt"` runs one turn and exits, for scripting/CI
- **Context management** — token-budget-driven compaction that pins the original task message and summarizes the rest
- **Evals** — single-turn and multi-turn evaluations via [Laminar](https://www.lmnr.ai/)

## Setup

```bash
pnpm install
```

Create a `.env` file in the project root with your API keys:

```bash
OPENAI_API_KEY=your-key-here
# Optional: enables Laminar tracing/evals. Spans are recorded WITHOUT prompt/tool
# content by default — set FRIDAY_TELEMETRY_RECORD_IO=1 to opt into full tracing.
LMNR_API_KEY=your-key-here
```

## Usage

```bash
# Run in development (watch mode)
pnpm dev

# Run once
pnpm start

# Build, then install the `friday` command globally
pnpm build
npm install -g .
friday
```

### CLI flags

```
friday                        Start the interactive session
friday -p "prompt"            Run one prompt non-interactively and exit
friday --resume               Continue the most recent session in this directory

-m, --model <id>   Model id to use (default: gpt-5-mini)
-p, --print <text> Run one prompt non-interactively, print the response, and exit
    --resume       Resume the most recent session for the current directory
-y, --yes          Auto-approve every tool call (only applies to -p; use with care)
-v, --version      Print the version number
-h, --help         Show this help
```

Sessions are saved per-project under `~/.friday/sessions/`, not in the repo you run `friday` from.

By default, file tools are confined to the current working directory (set `FRIDAY_ALLOW_UNSAFE_PATHS=1` to lift that).

## Tests

```bash
# Fast, deterministic unit tests (no API key required)
pnpm test

# Typecheck and lint (both run in CI)
pnpm typecheck
pnpm lint
```

## Evals

```bash
pnpm eval:file-tools
pnpm eval:shell-tools
pnpm eval:agent
```

Unlike `pnpm test`, these call the real model — they need `OPENAI_API_KEY` and cost tokens. `LMNR_API_KEY` is optional and only adds tracing.

## Project Structure

```
src/
├── cli.ts              # Entry point: arg parsing, one-shot mode, renders the Ink app
├── types.ts             # Shared type definitions
├── agent/
│   ├── run.ts            # Agent runner: streamText loop + tool-call/approval orchestration
│   ├── executeTool.ts     # Tool execution dispatcher
│   ├── model.ts            # Single source of truth for the default model
│   ├── session.ts           # Session save/load/resume
│   ├── context/               # Token estimation, context-window limits, compaction
│   ├── system/                  # System prompt + history filtering
│   └── tools/                     # file, search, shell, webSearch
└── ui/                              # Ink terminal UI components
evals/                                # Laminar eval suites and data
openspec/                             # Spec-driven change proposals (see openspec/AGENTS.md)
```

## License

This project is for viewing and educational reference only — no license is granted to use, copy, modify, or distribute it. See [LICENSE](LICENSE).
