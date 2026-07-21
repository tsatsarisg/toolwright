# Project Overview

**Name:** Toolwright - Terminal AI Agent
**Description:** A general-purpose, terminal-based AI agent built from first principles using TypeScript and the Vercel AI SDK. No agent frameworks, no magic — just a custom tool-calling loop with conversation history.

See [README.md](../README.md) for tech stack, setup, and project structure. This file covers conventions and architecture context relevant to writing spec-driven changes — not repeated there.

## Conventions

### Code Style
- ES modules only (`"type": "module"`)
- TypeScript strict mode
- Biome for linting and formatting — run `pnpm lint` / `pnpm typecheck` before pushing; CI enforces both
- Vercel AI SDK with manual agent loop (no auto-execution)

### File Naming
- camelCase for TypeScript files: `executeTool.ts`
- kebab-case for directories when needed

### TypeScript
- Target: ES2021
- Module: ES2022
- Strict type checking enabled

## Architecture

### Agent Loop Pattern
The core is a manual streamText loop with sequential, approval-gated tool execution (`src/agent/run.ts`):

```
1. User sends message via Ink input
2. Filter/compact conversation history if it's over the context-window threshold
3. Call streamText with history + tools
4. Stream tokens to the UI via fullStream iteration
5. If finishReason === 'tool-calls':
   a. For each call: read-only tools (readFile, listFiles, globFiles, searchCode,
      webSearch) run without a prompt; everything else waits on human approval
   b. Execute approved tools SEQUENTIALLY, in order — not in parallel — so a
      rejection can short-circuit the rest of the batch
   c. Append tool results to history, go to step 3
6. If finishReason !== 'tool-calls':
   a. Display final response
   b. Wait for next user input
```

### Conversation History
- Array of AI SDK `ModelMessage` objects, owned by `src/ui/App.tsx` and passed back into `runAgent` each turn
- Roles: `system` (owned by `runAgent`, never persisted in history), `user`, `assistant`, `tool`
- Tool results use structured output: `{ type: 'text', value: string }`

### Tool Design
- Tools defined using the AI SDK `tool()` helper with Zod schemas, in `src/agent/tools/`
- `inputSchema` defines parameters, validated again in `executeTool.ts` before execution
- The model only ever sees an execute-less view of each tool (`toModelTools`) — actual execution happens after approval
- Current tools: `readFile`, `writeFile`, `editFile` (targeted string replacement), `listFiles`, `deleteFile`, `globFiles`, `searchCode`, `runCommand`, `webSearch`

## Key Concepts

1. **Core Primitives**: Models, tools, state, memory, orchestration
2. **Custom Tool Loop**: Conversation history-based, no framework abstraction
3. **Context Management**: Token-estimate-driven compaction that pins the original task message and summarizes the rest
4. **Evals**: Single-turn and multi-turn evaluation patterns via Laminar (`evals/`)
5. **Guardrails**: Human-in-the-loop approval for every tool with side effects (writes, deletes, shell execution)

## Environment

- Node.js 20+
- OpenAI API key (`OPENAI_API_KEY`)
- Local terminal execution
