# Configuration

Toolwright reads `~/.toolwright/config.json`, or the file supplied by `--config`. Missing configuration is allowed. Store credentials in environment variables, not in this JSON file.

```json
{
  "defaultProfile": "local",
  "profiles": {
    "cloud": {
      "provider": "openai",
      "api": "responses",
      "model": "gpt-6-luna",
      "apiKeyEnv": "OPENAI_API_KEY",
      "telemetry": false
    },
    "local": {
      "provider": "openai-compatible",
      "api": "chat-completions",
      "baseURL": "http://127.0.0.1:1234/v1",
      "model": "replace-with-loaded-model-id",
      "contextWindow": 8192,
      "maxOutputTokens": 2048,
      "telemetry": false,
      "capabilities": {
        "tools": true,
        "streaming": true,
        "hostedWebSearch": false
      }
    },
    "offline": {
      "provider": "openai-compatible",
      "baseURL": "http://127.0.0.1:1234/v1",
      "model": "replace-with-loaded-model-id",
      "contextWindow": 8192,
      "localOnly": true
    }
  }
}
```

Built-in `openai` and `lmstudio` profiles are available without a file. `openai` defaults to Responses and `gpt-6-luna`, the lowest-cost model in OpenAI's current GPT-6 family. Its documented context window is 1,050,000 tokens with up to 128,000 output tokens; Toolwright caps input at 272,000 to stay below the higher long-context pricing threshold. See [official model specifications and pricing](https://developers.openai.com/api/docs/models/gpt-6-luna). `lmstudio` defaults to Chat Completions and requires an explicit model. User profiles with these names replace the built-ins. Responses must be selected explicitly for a compatible server that implements that protocol.

Selection precedence is CLI flags, `TOOLWRIGHT_PROFILE`/`TOOLWRIGHT_MODEL`, trusted project selection, user profile, built-in defaults. The CLI exposes `--profile`, `--provider`, `--api`, `--base-url`, `--api-key-env`, `--model`, `--context-window`, `--max-output-tokens`, and `--local-only`. A provider-family change discards inherited defaults from the previous family.

Endpoint URLs must use HTTP(S) without embedded credentials, query strings, or fragments. Toolwright sends credentials only to the selected origin and API path and rejects redirects. The OpenAI API key is not inherited by local or alternate remote endpoints. Configure a separate `apiKeyEnv` for an authenticated compatible server. Missing credentials fail before a request; no fallback provider is used.

Only `--trust-project-config` enables workspace `.toolwright/config.json`:

```json
{
  "profile": "local",
  "model": "replace-with-loaded-model-id",
  "contextWindow": 8192,
  "maxOutputTokens": 2048
}
```

Project configuration can select existing user profiles and model limits. It cannot introduce endpoints, select credentials, enable telemetry, or relax a profile's local-only policy. Root and scoped `AGENTS.md` files supply coding guidance; explicit user instructions take precedence.

Compatible profiles have hosted search disabled. `tools: false` removes tools; `streaming: false` causes a clear startup failure because the coding runner requires streaming. Tool calling depends on the loaded model and server template, so verify it using `doctor --probe-tools`. Toolwright does not silently swap models or enable cloud tools when a local model fails.

Unknown compatible models use conservative 8192/2048 context/output defaults. Set the context window to your server's loaded value, not an advertised maximum. `maxOutputTokens` must be smaller than the context window. The runner reserves output capacity, estimates instructions/history/schema cost before each request, compacts old tool exchanges with the same provider, and stops when retained state cannot fit. Estimates are conservative approximations rather than a server tokenizer.
