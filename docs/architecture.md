# Architecture

Toolwright groups code by the responsibility that changes. The CLI and terminal UI construct collaborators and call the same agent runner. Provider-specific details, filesystem rules, and persisted session formats have explicit owners.

```text
src/
  cli.ts                Startup and dependency wiring
  cli/                  Flags, help, headless events and exit codes
  config/               Profile precedence, schemas, defaults, endpoint policy
  providers/            SDK adapters, guarded transport, limits, diagnostics, telemetry
  agent/
    run.ts              Turn orchestration and final outcome
    types.ts            Runner inputs, callbacks and outcomes
    stream.ts           Model stream interpretation
    context/            Token estimates, budgets, compaction and usage reporting
    execution/          Policy, approval, dispatch and failure tracking
    history/            Valid tool exchanges and portable provider history
    tools/              Model tool schemas and workspace adapters
  workspace/            Confined paths, edits, diffs, guidance, search, host processes
  sessions/             Format validation, atomic storage, snapshots and restore
  ui/                   Rendering, session state, commands and approval presentation
tests/
  integration/          CLI, full coding turns and terminal session contracts
  helpers/              Scripted inference and callback recording
evals/
  coding/               Objective fixtures, fixture execution and verification
scripts/
  build.mjs             Clean runtime-only compilation
```

## Provider configuration and construction

`config/provider.ts` combines supported configuration sources in their documented order. `config/schema.ts` limits trusted project configuration to model selection and limits. `config/endpoint.ts` validates endpoints and associates credentials with the selected origin. Switching provider families discards inherited defaults.

`providers/resolve.ts` constructs the selected adapter and its limits. `providers/transport.ts` guards both inference and diagnostics against requests outside the configured endpoint and rejects redirects. No failure path chooses another provider. Local-only restrictions suppress hosted tools, telemetry, host shell execution, and external media inputs.

## A coding turn

`agent/run.ts` prepares the current instructions, obtains a request context, collects a model response, resolves requested tools, and reports the outcome. Context preparation accounts for tool schemas, compacts through the selected provider when necessary, and respects the same cumulative token budget as normal requests. A context stop retains the compacted history for checkpointing.

`agent/execution/resolveToolCalls.ts` validates arguments before checking the central policy. File mutations prepare a diff and discover scoped instructions before requesting approval. Newly discovered guidance postpones the edit until the model has seen it. Approval is followed by another cancellation check and the actual operation. Batch processing records completed results and cancellation markers in checkpoints so resume does not automatically replay operations.

`agent/tools/index.ts` assembles workspace-bound tools and filters provider capabilities. Model-facing tools have their local execution functions removed; the SDK cannot run them before approval. The tool definitions adapt application inputs to workspace operations.

## Workspace and session boundaries

`workspace/workspace.ts` owns inspected paths, original file contents, tracked changes, and executed commands. Canonical path resolution remains in `workspace/paths.ts`; preparing and applying edits remain separate so stale previews can be rejected. Scoped guidance, diff formatting, ignore-aware discovery, process cancellation, and result presentation have focused modules.

`sessions/schema.ts` validates current session files and translates legacy histories. `sessions/store.ts` handles workspace identity, atomic writes, lookup, and listing. `sessions/snapshot.ts` records only supported provider metadata and restores tracked state. Credentials and permission grants are never persisted.

## Presentation and verification

`ui/App.tsx` renders the state supplied by `ui/useCodingSession.ts`. The session controller owns command handling, active-turn cancellation, approval, history, and checkpoints. Command parsing is independent of rendering. Approval preview metadata does not import executable tools or initialize provider clients.

Unit tests stay beside the behavior they check. Integration tests use isolated workspaces and scripted inference to verify observable effects, approvals, provider consent, checkpoints, and output contracts. Coding evaluation fixtures and verification use the same runner. Live evaluations remain explicitly opt in and report their model, context, server, and hardware.

`pnpm build` removes obsolete generated output and compiles runtime source only. Tests and scripted model helpers are excluded from the distribution. CLI flags, configuration fields, JSON events, session formats, and exit codes remain the supported interfaces; source imports follow the module that owns the contract.
