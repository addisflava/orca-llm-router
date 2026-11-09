# Orca LLM Router

A self-contained local LLM gateway for Orca agents. Agents talk to one
stable local endpoint and the gateway resolves every request directly to the
provider you configured — Anthropic, OpenAI,
OpenRouter, DeepSeek, Kimi, Z.AI, MiniMax, Mistral, SiliconFlow, Moonshot,
Ollama/local, or any OpenAI/Anthropic/Responses-compatible endpoint.


## How it works

```
any agent CLI in Orca (Claude Code, Codex, OpenCode, Pi, …)
        │  agent.launch.before hook rewrites env:
        │  ANTHROPIC_BASE_URL / OPENAI_BASE_URL -> http://127.0.0.1:18080[/v1]
        ▼
Orca LLM Router gateway  127.0.0.1:18080    (this plugin, worker/sidecar.mjs)
        │  aliases → routing rules (conditions + rewrites) → provider/model
        ├─► https://api.anthropic.com      (anthropic messages)
        ├─► https://api.openai.com/v1      (openai chat + responses)
        ├─► https://openrouter.ai/api/v1   (openai chat + responses)
        └─► any provider in the preset catalog or your own endpoint
```

- **Three client protocol surfaces** are served: Anthropic Messages
  (`/v1/messages`), OpenAI Chat Completions (`/v1/chat/completions`) and
  OpenAI Responses (`/v1/responses`). Providers may speak any of those, and
  native Google Gemini `generateContent` is translated too, so a
  `protocols: ["gemini"]` provider (e.g. Google AI Studio) works from every
  client surface. When a client and its chosen provider speak different
  shapes, the gateway translates text, tools, images and usage (and streams in
  the client's shape by buffering the upstream response).
- **Routing**: model aliases (`claude-fast` → `anthropic/claude-…`),
  provider/model selectors (`deepseek/deepseek-chat`), and ordered
  conditional rules (`request.body.model starts-with claude-` → set model to
  `deepseek/deepseek-chat`). The first enabled matching rule wins.
- **Fallback and retries**: per-rule and global failure policies —
  `off`, `retry` (same model N times) or `model-chain` (try backup models in
  order, switching on any 4xx/5xx). Retry-After is honored, otherwise
  exponential backoff. The gateway returns `x-router-fallback-*` headers and
  records every attempt in the log.
- **Credential pools**: several API keys per provider, rotated round-robin
  across all enabled keys in priority order. A key that returns an auth error,
  is rate limited, or reaches a local limit is cooled down and skipped so
  traffic moves to the next key. Local limits can be set per key (`rpm`/`rph`/`rpd`,
  `tpm`/`tph`/`tpd`, `ipm`/`iph`/`ipd`, `maxRequests`+`windowMs`,
  `maxTokens`+`quotaWindowMs`). Keys live in Orca's encrypted `secrets:own`
  store — never in storage or logs.
- **Client API keys**: optional gateway keys with expiration and per-key
  limits, separate from provider credentials. Request (`rpm`/`rph`/`rpd`),
  token (`tpm`/`tph`/`tpd`) and image (`ipm`/`iph`/`ipd`) windows are enforced,
  plus `maxRequests`/`windowMs` and `maxTokens`/`quotaWindowMs` quotas. The
  internal launch token (`orca-router` by default) is always accepted for
  Orca-launched agents.
- **OpenCode model discovery**: OpenCode does not read `OPENAI_BASE_URL`, and
  its v2 CLI reuses a shared background server that ignores the env of later
  launches. The plugin publishes an `orca-router` provider — every enabled
  provider/model plus aliases, matching `/v1/models` — into
  `~/.config/opencode/opencode.jsonc` (the first sync leaves
  `opencode.jsonc.orca-backup`), updates it when providers or keys change, and
  runs Orca-started v2 OpenCode CLIs with `--standalone` so a launch-local
  `OPENCODE_CONFIG` wins. Plain `opencode` terminals reach the same gateway
  through the global config and its live reload.
- **Codex model discovery**: Codex builds its `/model` picker from a catalog
  file, so each Orca-started Codex gets `-c model_catalog_json=…` and
  `-c model_providers.orca-router.*` overrides. The generated catalog contains
  every enabled provider/model plus aliases, matching `/v1/models`, and the
  session's model/provider are pointed at the gateway. The catalog uses
  standard function tools rather than Codex's code-mode custom `exec` wrapper,
  so OpenAI-compatible providers can execute them. A Codex agent profile can
  also set `reasoningEffort` (`low`, `medium`, or `high`), which is passed as
  `model_reasoning_effort` for that launch. The user's `~/.codex/config.toml` is
  never modified; a plain-terminal `codex` keeps its own provider.
- **Dashboard panel**: gateway state, provider health, preset browser,
  routing-rule editor, aliases, agent profiles, client keys, model fetching
  (pulls the endpoint's list per protocol into the provider's models),
  connection checks (which validate the credential against the provider's
  model list), usage fetch, request log (provider, resolved model, tokens,
  cost, latency, attempts) and a usage overview (requests, success rate,
  tokens, cost, per-provider/per-model breakdowns).
- **Import / export**: 1-click import from local Claude Code Router (`~/.claude-code-router`) and OmniRoute (`~/.omniroute`) installations with auto-detection, AES-256-GCM credential decryption, combo migration, model aliases, and smart config merging. Also supports importing custom SQLite/JSON files, pasting configs directly into the panel, or using the CLI converter (`tools/import-legacy-config.mjs`). Snapshots can be exported as JSON at any time.
- **Status bar + commands**: `router:18080` shows gateway state; palette
  commands start/stop/restart/test it.

The hook is synchronous and cached: settings toggles apply after the next
`router.status` / agent activity event. Orca's native Chat UI does **not** go
through `agent.launch.before` (it is not a CLI) and is out of scope.

Do not run Claude Code Router alongside this plugin. CCR rewrites
`~/.claude/settings.json` and the global OpenCode config, so stop it with
`ccr stop` first. The OpenCode sync removes stale `claude-code-router` entries
on the next plugin start or config save; Orca-launched Claude uses its own
per-launch settings file regardless.

## Develop

Requires Orca ≥ 1.4.248 and Node ≥ 22.

```sh
# tests (pure Node, no Orca needed)
npm test

# validate the manifest, then hot-load into Orca
orca plugin validate .
orca plugin dev watch .
# open the panel: orca plugin open <key> --panel router
# handy: orca plugin logs <publisher>.llm-router
```

`orca plugin types .` writes `.orca/types` for editor completion (git-ignored).
TypeScript files are transpiled by Orca with no build step.

## Publish

1. Add the `orca-plugin` topic to your repo: `gh repo edit --add-topic orca-plugin`
2. Commit a version, then tag exactly: `git tag v1.0.0 && git push origin v1.0.0`
3. Check `https://www.onorca.dev/plugins/<owner>/<repo>` — it lists the
   plugin within an hour if the manifest passes.

Before publishing, add a `cover` (16:10, ≥ 800×500) and screenshots in the
manifest — cards without a cover get drawn art. The manifest already carries
`license: MIT` plus a `LICENSE` file.

## Design choices

- `trusted-worker` (full access): the worker must listen on localhost and the
  `agent.launch.before` hook must rewrite every agent's environment. The user
  approves this once at install.
- `engines.orca >=1.4.248`: hooks (`agent.launch.before`) and status-bar items
  need it.
- No dependencies: `worker/sidecar.mjs` uses only `node:http` + global
  `fetch`; `worker/main.mjs` is the Orca glue.
