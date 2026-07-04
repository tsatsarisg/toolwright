# Friday — Terminal AI Agent

A general-purpose, terminal-based AI agent built from first principles in TypeScript. No agent frameworks — just a custom tool-calling loop with conversation history, built on the Vercel AI SDK with an Ink (React) terminal UI.

## Features

- **Custom agent loop** — streaming tool-calling loop with conversation history, no framework magic
- **File system tools** — read, write, and list files
- **Web search** — pull in live information from the web
- **Shell tool** — execute commands with human-in-the-loop approval
- **Context management** — summarization to keep long sessions within the token limit
- **Evals** — single-turn and multi-turn evaluations via [Laminar](https://www.lmnr.ai/)

## Setup

```bash
npm install
```

Create a `.env` file in the project root with your API keys:

```bash
OPENAI_API_KEY=your-key-here
```

## Usage

```bash
# Run in development (watch mode)
npm run dev

# Run once
npm start

# Build the CLI
npm run build
```

## Evals

```bash
npm run eval:file-tools
npm run eval:shell-tools
npm run eval:agent
```

## Project Structure

```
src/
├── index.ts           # Development entry point (renders Ink app)
├── cli.ts             # CLI entry point (for global install)
├── types.ts           # Shared type definitions
├── agent/
│   ├── run.ts         # Agent runner with streamText loop
│   ├── executeTool.ts # Tool execution dispatcher
│   ├── system/        # System prompts
│   └── tools/         # Individual tool implementations
└── ui/                # Ink terminal UI components
evals/                 # Laminar eval suites and data
```
