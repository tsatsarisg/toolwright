# Project instructions

Toolwright is a TypeScript coding CLI with an Ink interface and AI SDK model adapters.

- Read README.md and docs/configuration.md for supported behavior and configuration.
- Keep provider routing explicit. Local-only operation must never enable cloud inference, tracing, hosted tools, or host shell execution.
- Route tool execution through the central execution policy. Preserve canonical workspace confinement, diff review, cancellation, and safe session checkpoints.
- Preserve existing user changes. Do not stage, reset, commit, or publish work unless requested.
- Run pnpm test, pnpm typecheck, pnpm lint, and pnpm build after implementation changes.
- Use scripted coding evaluations for deterministic regression checks. Live model evaluations are opt in; record the model, context, server, and hardware and distinguish them from scripted results.
