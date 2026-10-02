import { DEFAULT_MODEL } from "../config/defaults.ts";

export const HELP = `toolwright — a coding CLI agent

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
