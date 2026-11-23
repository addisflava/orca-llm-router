# Agent model-list audit

Question: when an agent is launched by Orca with the router enabled, can the user
pick **any** of the router's models in that agent's own model picker?

## Final coverage

| Coverage | Agents | Count |
|---|---|---|
| **Full** — every router model in the picker | Claude, Claude Agent Teams, CodeBuddy, OpenClaude, Codex, OpenCode, OpenCode2, Pi, OMP, Continue, Kilo, Kimi, Qwen Code, Crush, Droid, Hermes, OpenClaw, Grok | **18/45** |
| **Partial** — gateway + one model (picker stays client-managed) | Gemini CLI, Aider, Goose, Cline CLI, jcode | 5 |
| **Not configurable** — no stable config surface a plugin can write | see table below | 22 |

Three upgrades came out of this recheck (all verified against the real binaries):

- **Kilo** is an OpenCode fork. Its published config schema accepts a `provider`
  block with `options.baseURL` and a `models` map, and it honours `KILO_CONFIG`
  just like OpenCode honours `OPENCODE_CONFIG`. We now generate that file and set
  `KILO_CONFIG` at launch; `kilo models` lists `orca-router/<model>` for every
  router model.
- **CodeBuddy** product config has `CustomModelsJSON: true`. It reads a full
  model map from `~/.codebuddy/models.json` (`models[]` + `availableModels`), the
  same shape CCR writes for WorkBuddy. Verified live: `codebuddy -p --model
  custom-local:<real-model>` returned `OK` through the gateway.
- **Qwen Code** reads `modelProviders` from `~/.qwen/settings.json`. We publish
  every router id there with `baseUrl: <gateway>/v1`, plus
  `security.auth.selectedType: "openai"`. Verified live twice: a bogus model id
  reached our gateway and got its own `404 no provider could resolve model`
  error; a real id returned `OK`.

Earlier coverage came from: generated Codex/OpenCode catalogs; CCR-style
synthetic `anthropic/claude-orca-h<hex>` ids for Claude gateway discovery
(decoded in the sidecar); and OmniRoute's config writers for Continue, Crush,
Droid, OMP, Hermes and OpenClaw plus CCR's `GROK_MODELS_LIST_URL` trick.

## Verification method

- **Installed here (17 agents):** inspected the actual binary's `--help`,
  published config schema, env strings and/or did a headless request against the
  live gateway. This is how CodeBuddy, Qwen Code, Kilo, Muse, Antigravity, Kiro,
  Freebuff and Cursor were decided.
- **Not installed here (28 agents):** checked the closed agent registries and
  config writers of CCR (`dist/main/cli.js`, 10 agent ids) and OmniRoute
  (`src/shared/constants/cliTools.ts`, config manifest, `setup-*.mjs` commands,
  `*-settings` routes). If neither router has a writer and no stable public
  config schema exists, the agent is marked not configurable. No npm packages
  were installed from look-alike names (`crush` is MediaCrush, `omp` is an empty
  package, `droid-cli` is an Android CLI, `grok-cli` is an anthropic proxy) —
  installing those would not verify the real agents.

## What CCR and OmniRoute actually do

1. **Config-file provider injection** — write a provider + model map into the
   agent's own config, then point the launch at it (CCR: OpenCode, Aider, Goose,
   Gemini, Qwen, Kilo, Cline, Pi, WorkBuddy/CodeBuddy, ZCode; OmniRoute: Crush,
   Droid, OMP, OpenClaw, Hermes, jcode, Grok Build).
2. **Synthetic Claude model ids** — Claude Code's discovery only keeps ids
   matching `/claude|anthropic/i`, so every model is advertised as
   `anthropic/claude-orca-h<hex(real-id)>` with `display_name` set to the real id.
3. **Model-list URL env** — Grok CLI builds its picker from
   `GROK_MODELS_LIST_URL=<gateway>/v1/models` (CCR's `Grok` wrapper).
4. **Self-discovery provider** — OMP's `discovery.type: openai-models-list`
   enumerates `/v1/models` itself, so it never goes stale.
5. **UI-only / MITM** — Cursor and Cline's VS Code extension use opaque
   `state.vscdb`; Kiro and Antigravity are only reachable through OmniRoute's
   root-level MITM proxy (DNS + CA cert + sudo), which a plugin cannot safely
   replicate.

## Per-agent audit

| # | Agent | Status | Mechanism / blocker |
|---|---|---|---|
| 1 | claude | Full | gateway discovery + synthetic ids + `--settings` pin |
| 2 | claude-agent-teams | Full | launches `claude`, same env |
| 3 | codebuddy | Full | `~/.codebuddy/models.json` (CustomModelsJSON) + own base-url keys |
| 4 | openclaude | Full | Claude-family env + gateway discovery |
| 5 | codex | Full | generated model catalog + per-launch `-c` overrides |
| 6 | devin | None | no config writer in either router; own cloud service |
| 7 | ante | None | no config writer in either router |
| 8 | trae | None | OmniRoute only has an unwired MITM stub |
| 9 | muse | None | verified: providers are `echo`/`meta` only; `--base-url` is Meta's proprietary API |
| 10 | dsh (DeepSeek Harness) | None | no config writer in either router |
| 11 | zcode | None | CCR target is the desktop app data dir (`ccr-workbuddy-model-catalog.json` style), no stable CLI schema here |
| 12 | autohand | None | no config writer in either router |
| 13 | opencode | Full | generated `OPENCODE_CONFIG` + user config |
| 14 | opencode2 | Full | same as opencode |
| 15 | mimo-code | None | no config writer in either router |
| 16 | pi | Full | `PI_CODING_AGENT_DIR` + generated `models.json` |
| 17 | omp | Full | `~/.omp/agent/models.yml` with `openai-models-list` discovery |
| 18 | prime-agent | None | OmniRoute detect-only; auth chosen at first `/login` |
| 19 | qoder | None | OmniRoute detect/upstream-only; own account auth |
| 20 | qoder-cn | None | no config writer in either router |
| 21 | gemini | Partial | gateway + `GEMINI_MODEL`; Gemini CLI has no multi-model config |
| 22 | antigravity | None | verified: ignores `GOOGLE_GEMINI_BASE_URL`, own model catalog/service |
| 23 | aider | Partial | `~/.aider.conf.yml` `openai-api-base` (root) + one `--model` |
| 24 | goose | Partial | `OPENAI_HOST` + `GOOSE_DEFAULT_MODEL`, one model |
| 25 | amp | None | OmniRoute detect-only, no config paths |
| 26 | kilo | Full | generated `KILO_CONFIG` provider block + user config merge |
| 27 | kiro | None | verified: AWS auth, no base-url override; `--list-models` is AWS's list |
| 28 | crush | Full | `~/.config/crush/crush.json` `providers.orca-router.models[]` |
| 29 | aug (Auggie) | None | OmniRoute upstream-provider alias only, not a gateway client |
| 30 | cline | Partial | CLI config/secrets writable; VS Code extension is UI/DB only |
| 31 | codebuff | None | Codebuff cloud protocol + own auth |
| 32 | freebuff | None | verified: Codebuff-family cloud agent; BYOK is OpenRouter, no base URL |
| 33 | command-code | None | OmniRoute upstream-provider alias only |
| 34 | continue | Full | `~/.continue/config.yaml` full `models[]` |
| 35 | cursor | None | verified: `--endpoint` speaks Cursor's own protocol and needs a Cursor account |
| 36 | droid | Full | `~/.factory/settings.json` `customModels[]` |
| 37 | kimi | Full | `~/.kimi/config.toml` full `[models.*]` map |
| 38 | mistral-vibe | None | no config writer in either router |
| 39 | qwen-code | Full | `~/.qwen/settings.json` `modelProviders.openai[]` (verified live) |
| 40 | rovo (Rovo Dev) | None | no config writer (OmniRoute's writer is for Roo Code, a different agent) |
| 41 | hermes | Full | `custom_providers[].models` + role pins in `~/.hermes/config.yaml` |
| 42 | openclaw | Full | `~/.openclaw/openclaw.json` provider model map |
| 43 | copilot | None | own GitHub auth; no config writer |
| 44 | grok | Full | `GROK_MODELS_LIST_URL` + `GROK_MODELS_BASE_URL` env (CCR) |
| 45 | jcode | Partial | `~/.jcode/config.toml` single pinned provider profile |

## Sync behaviour

`writeAgentConfigs()` runs on every config save and on router activation, so
adding or removing a model in the Providers tab refreshes every config-file
picker without a relaunch. `KILO_CONFIG` is written at launch if missing.
All writes are atomic and backed up; disabling the relevant agent or
deactivating the plugin restores the original files. `syncGlobalAgentConfig()`
now opts in any enabled agent profile, not only Codex/OpenCode, so Agents-tab
toggles cover the whole file-based set.

### OpenCode gotchas (all fixed)

Four things made router models disappear intermittently in OpenCode:

- **v2 config key:** OpenCode v2.0.26 moved custom providers from the deprecated
  `provider` key to `providers`, and from `options` to `settings`. Our generator
  only wrote the old shape, which v2 silently ignored (`opencode debug config`
  showed `"providers": {}` even with hundreds of models in the file). The
  generator now emits both shapes.
- **v2 background service:** it loads config once at startup. Rewriting the
  file was not picked up until `opencode reload` ran, so the picker stayed
  stale. The plugin now calls `opencode reload` automatically after every
  successful config write or restore (only when the document actually
  changed).
- **v1 requires complete model limits:** OpenCode v1 prints
  `Missing key provider.orca-router.models.<id>.limit.output` and drops every
  model whose `limit` object lacks `output`. We only wrote `context` when the
  upstream window was known. Every generated model now carries both
  `context` and `output` (defaults `128000` / `8192`).
- **v2 renamed `npm` to `package`:** the `providers` block must carry
  `package: "@ai-sdk/openai-compatible"`. With only `npm`, OpenCode loaded the
  provider with an empty package and every session failed with
  `Unsupported package for orca-router/<model>: `. Both keys are now emitted
  (v1 needs `npm`, v2 needs `package`), and Kilo's provider block carries both.
- **Stale installed plugin snapshot:** a local plugin's running code comes from
  `~/.config/orca/plugins/local.llm-router/<hash>`, not the working tree.
  `orca plugin restart` alone does **not** copy source changes there — run
  `orca plugin update local.llm-router` first, then restart.

Live checks after the fixes: `opencode models | grep -c orca-router` returns
377, and OpenCode v1.18.18 with the generated config lists the same 377 models
with no `Missing key` warnings.

Note: stopping the router deliberately restores the pre-router OpenCode config
(and reloads), by design. If a terminal OpenCode session still looks stale,
`opencode reload` refreshes it immediately.

### Startup failure caused by the reload fix

The first version of the reload call used `execFileSync('opencode', ['reload'], {
timeout: 10000 })`. OpenCode's background service can take longer than that (or
never answer), so activation blocked and Orca reported
`worker did not become ready within 10000ms`, restarting the worker in a loop.
`reloadOpenCodeConfig()` now uses a detached `spawn` and returns immediately, so
a slow `opencode reload` can never delay plugin startup. Verified after update +
restart: plugin `running`, gateway `200`, no new worker failures.

All new behavior is covered by `tests/agent-config.test.mjs`,
`tests/agents.test.mjs` and `tests/main-global-config.test.mjs`. `npm test`
(264), `orca plugin test .` (290) and `npm run validate` pass.
