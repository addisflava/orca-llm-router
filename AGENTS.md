# AGENTS.md

Instructions and context for agents working in the Orca LLM Router repository.

## Project

Orca LLM Router is a native Orca plugin that exposes one local OpenAI/Anthropic/Gemini-compatible endpoint and routes agent traffic across providers, credentials, protocols, and fallback chains. It is intentionally lightweight: the gateway uses Node built-ins (`node:http`, native `fetch`) with no external runtime dependencies.

Core goals:

- Let every agent in Orca use any configured provider or subscription.
- Keep credentials in Orca's encrypted secret store.
- Translate protocols and reasoning modes without changing agent code.
- Preserve upstream prompt caches and handle provider failures predictably.
- Stay Orca-native instead of wrapping or cloning another router.

## Repository Map

- `src/panel.tsx` — Orca panel UI: overview, providers, keys, routing rules, agents, logs, import/export.
- `src/panel.check.ts` — render scenarios used by `orca plugin check`.
- `src/protocol.ts` — shared panel/worker protocol and config types.
- `worker/main.mjs` — plugin entry point, panel request handlers, config persistence, sidecar lifecycle, and Orca agent launch hooks.
- `worker/sidecar.mjs` — HTTP gateway, protocol translation, routing, key pools, usage tracking, and legacy config conversion.
- `worker/transforms.mjs` — pure prompt-compression and failover context-relay helpers.
- `worker/cache.mjs` — canonical cache keys, cosine similarity, and the in-memory response cache.
- `worker/scheduler.mjs` — pure credential scheduler, circuit-breaker normalization, and `Retry-After` parsing.
- `worker/proxy.mjs` — dependency-free HTTP CONNECT / SOCKS5 tunneling used by routes with a VPN server attached.
- `worker/orca-agents.mjs` — Orca agent registry and launch integration.
- `worker/webchat/` — native web-chat transports for free DeepSeek/Qwen web subscriptions. `index.mjs` composes a transport with recovery; `auth.mjs` drives Chrome via CDP and captures credentials; `deepseek.mjs` / `qwen.mjs` implement the two upstream protocols; `pow.mjs`, `models.mjs`, `prompt.mjs`, `tools.mjs`, `session.mjs`, `recovery.mjs` hold pure helpers; `sidecar.mjs` builds synthetic OpenAI responses; `errors.mjs` defines typed upstream errors.
- `tests/sidecar.test.mjs` — Node test suite for sidecar, scheduler, imports, routing, and protocol translation.
- `tests/webchat*.test.mjs` — web-chat transport, auth, session, recovery, and gateway integration tests.
- `tests/panel.test.tsx` — Orca panel tests using `orca/testing`.
- `tools/import-legacy-config.mjs` — standalone CCR/OmniRoute converter.

## Commands

```bash
# Sidecar and scheduler tests
npm test

# Full plugin tests, including panel rendering tests
orca plugin test .

# Manifest and component validation
npm run validate
orca plugin check .

# Type-check when a TypeScript compiler is available
tsc -p tsconfig.json --noEmit
```

`npm test` does not run the panel tests. Use `orca plugin test .` for UI coverage.

If this checkout is installed as the local plugin:

```bash
orca plugin update local.llm-router
orca plugin restart local.llm-router
```

## Engineering Rules

- Keep the gateway dependency-free. Use Node built-ins and native `fetch`.
- Prefer small native implementations over porting a framework or adding infrastructure.
- Never write provider secrets to config, logs, tests, fixtures, or screenshots. Config stores secret names; values come from Orca's secret store.
- The panel may read a secret only for an explicit user action such as copying or editing a key.
- Keep routing and scheduler logic deterministic and testable without a live HTTP server.
- Preserve existing user config when changing defaults. Normalize missing fields instead of requiring migration.
- Add tests for behavior changes. Use pure functions or injected `fetch` mocks; tests must not require network access.
- Keep panel state compatible with Orca components. Do not introduce custom HTML controls when an Orca component exists.

## Routing Invariants

- Scheduler default: `priority-weighted` with priority tiers, utilization-aware spillover, and smooth weighted round-robin.
- Credential identity is scoped per provider key. Changing or replacing a key must not silently discard unrelated pool entries or metadata.
- All enabled keys cooling or over quota returns HTTP `420` with `type: "router_exhausted"` and `code: "all_keys_exhausted"`. Include `Retry-After` when the cooldown is known. `scheduler.exhaustedStatus` may be set to `429`; `scheduler.allKeysExhausted: "overflow"` restores the legacy use-a-blocked-key behavior.
- Routes are the **only** cross-provider failover unit: a model name agents send mapped to one or more `provider/model` targets. `routes[].strategy` is `fastest` (rank by health/speed) or `ordered` (listed order); new routes default to `fastest`, and routes converted from legacy aliases default to `ordered`. `routes[].retries` controls extra attempts per target (default 2). Config `version` 3 stores the routes in `routes` and the global request matchers in `policies`; a legacy config (`version < 3`) used `routes` for the matchers and `resolvers`/`modelGroups` for the routes, and is migrated at normalize time.
- A request whose model matches a route builds its chain from the route targets, even when a matched policy has `fallback.mode: "off"`. A route name in `fallback.models` expands after the primary; a raw `provider/model` entry resolves directly and is appended after the primary. A non-route request resolves to exactly one target and retries it `config.retries` times (default 2). It never fails over to another provider.
- An unknown chat model returns `404` with `code: "model_not_found"`. There is no silent fallback to a default provider; non-chat passthrough endpoints (embeddings, audio, unknown paths) go to the first enabled provider.
- Legacy custom chains are migrated into routes at normalize time. A policy chain becomes an ordered `<policy>-backups` route and the policy fallback is repointed at it. A global `defaultFallback` chain becomes a `default-failover` route and stops applying; report it in `config.migration` and in the panel. Migration is idempotent and deduplicated by `kind:from:to`.
- Legacy `aliases` are merged into `routes` at normalize time as ordered one-target routes, so an upgraded config keeps resolving. Editing an alias in the panel moves it into `routes` and removes the alias.
- Cache affinity is keyed by provider + model + credential and resolves in this order: `x-orca-session-id`, known agent session headers, body identifiers, stable prompt hash. Default TTL is 10 minutes.
- Provider circuit breakers are provider-level, not model-level. Default: 3 failures, 60-second cooldown, one half-open probe.
- Parse `Retry-After` for both delta-seconds and HTTP dates. Do not invent budget enforcement or broader rate-limit header parsing unless the task explicitly asks for it.
- Provider health ranking is opt-in **per route**: a `fastest` route passes `enabled: true` to `rankProviderTargets`, an `ordered` route passes `false`. There is no global `providerHealth.enabled` toggle. Ranking tries fastest healthy first, with repeated failures and open circuits last. It is HA, not load balancing: one provider serves a session, pinned for the cache-affinity TTL, and the next healthy target takes over on failure. Time-to-first-byte samples come from live traffic and the panel speed test; a provider with no sample uses the mean known latency. A route also pins the target that last served it (scoped by route name + session affinity, expiring with the cache-affinity TTL), so repeat requests stay on the same model until that target fails; after a failover the pin moves to the target that succeeded. A response that needed a retry/failover is logged with `failedOver: true` (shown as a warning on an otherwise successful status), counted per route in `stats.routeFailovers` / `status().routeFailovers`, with total per-route requests in `stats.routeRequests` / `status().routeRequests` shown beside it on the route card; both reset by clearing the log. One HTTP request is always one log entry: the full trial chain lives in `attempts` (`provider/model#status` per failed hop, `provider/model` for the hop that served) and `failures[]` (including the tried `model`), never in separate entries.
- Default new key names are `key-1`, `key-2`, and so on. Typed names win. Existing keys are not renamed automatically.
- Key usage bars combine local rolling counters, configured key limits, and provider-reported meters when a scraper exists. A provider without a usage source shows an empty muted bar, not a fabricated quota.
- Local rolling counters are per credential and count every successful upstream chat request, including streams that carry no usage block; tokens stay at zero when the provider reports none. They are kept in sidecar memory but snapshotted to Orca storage under `router.runtime` (throttled ~5s, flushed every 10s and on deactivate), so the 24-hour windows, key cooldowns, aggregate stats, and provider health/circuit state survive a plugin restart. Only secret *names* are stored, never secret values. Request logs stay in memory by default; the opt-in `persistLogs` setting saves sanitized entries (no bodies or headers) under `router.logs`, capped at 300 and cleared by **Clear**. Stale window entries, expired cooldowns, and expired open circuits are dropped on restore.
- The provider **Fetch usage** button fetches provider-reported meters on demand (`router.keyUsage` with `refresh: true`) and shows the result inline in the provider card, not only in the global banner. When nothing comes back it names the reason: no usage source, no key, or an unreadable endpoint.
- Providers without a preset scraper can still report usage. The **Fetch usage** click probes a short list of well-known balance endpoints (`router.usageProbe`, 15-second budget, exact response-shape matches only) and offers to save the detected connector. The provider's **Edit** form carries the same `usageFetch` connector by hand (endpoint, auth, meters JSON) through `router.provider.usage`, and a failed fetch offers a **Set up** shortcut into that form; saving or removing it clears the cached per-key readings. Probing never fabricates a quota from an unrecognized body.

## Features Ported From CCR

These are intentionally adapted into native Orca code; CCR is not a runtime dependency.

- One-click and standalone import from `~/.claude-code-router` JSON or SQLite databases.
- CCR providers, capability/endpoint mappings, API keys, extra credentials, model lists, descriptions, and pricing metadata.
- CCR account HTTP-JSON connectors, mapped to the native provider usage scraper shape.
- CCR routing rules converted into native conditions and rewrites, including explicit model overrides and fallback policies.
- Model aliases and first-match routing behavior.
- Agent profiles for Claude Code and Codex, including small/fast model selection, scope, environment, and provider references.
- Client API keys, expiry/limits metadata, timeout settings, and request-log body-capture policy.
- Credential-pool scheduling ideas: priority tiers, weighted rotation, key cooldowns, and model-chain fallback, implemented natively and extended with Orca-specific behavior.
- Migration compatibility that removes stale CCR provider references and repoints agent model ids to the native router.

## Features Ported From OmniRoute

These are reimplemented natively; OmniRoute infrastructure and its UI shell are not copied.

- One-click and standalone import from OmniRoute SQLite storage or JSON exports.
- Provider nodes and provider connections converted into native providers, endpoints, and credential pools.
- OmniRoute combos converted into a model alias plus a native route with a primary model and model-chain fallback.
- Custom models, model aliases, client API keys, connection priorities, active state, and rate-limit overrides.
- AES-256-GCM `enc:v1:...` credential decryption using `STORAGE_ENCRYPTION_KEY` or an explicit key.
- Explicit exhaustion handling: `420`, `router_exhausted`, `all_keys_exhausted`, and `Retry-After`.
- Provider circuit breakers with half-open probes and `provider_circuit_open` responses.
- `Retry-After`-aware credential cooldowns and retry behavior after `429`.
- Utilization-aware spillover so a key close to its limit is skipped while another key has headroom.
- Cache affinity across session headers, body identifiers, and stable prompt hashes to keep prompt caches warm.
- Cross-provider `provider-chain` failover.
- Per-key usage bars and configured provider quota scrapers, with cached provider usage reports.
- Selected provider presets and usage mappings, without copying OmniRoute's full provider catalog.

## Opt-in Request Optimization

Compression, context relay, and the response cache are supported, but only as explicit opt-ins. All three default to `false` and a config without the new blocks must forward byte-identical payloads.

- Compression and relay are pure functions in `worker/transforms.mjs`; cache keys, similarity, and storage are in `worker/cache.mjs`. The sidecar clones the body before transforming it.
- Compression modes: `lite` (ANSI + whitespace), `standard` (+ cap old plain-text tool output), `aggressive` (+ shorten old turns). Never edit fenced code, inline code, URLs, whole JSON payloads, tool-call arguments, images, the system prompt by default, or the most recent `keepRecentMessages` turns.
- Context relay is deterministic. It applies only when the chain moves to another target by default (`trigger: "failover"`), or on request size (`"both"`), or always (`"always"`). It never calls a model. Keep the system prompt and recent turns intact.
- The response cache is scoped by client protocol, stream mode, and resolved provider/model. Exact mode keys a canonical body hash (ignoring only `stream`); semantic mode compares embeddings only within the same scope, and only when generation settings such as temperature, max tokens, stop sequences, response format, and tools also match. Skip tools, images, and requests above `maxTemperature` by default.
- Cache storage is process-local and TTL-bounded. Replaying an exact hit must not call the chat key scheduler or upstream; semantic lookups may call only the configured embedding provider. Log hits with `cache: "hit"` (or `"semantic-hit"`), count avoided cost in `stats.cacheSavedCost`, and do not invent provider cost.
- Per-request overrides: `x-router-compression: off` disables compression; `x-router-cache: off` bypasses the cache. Emit `x-router-compression`, `x-router-context-relay`, and `x-router-cache` response headers when active.
- Semantic embeddings use one operator-selected OpenAI-compatible provider/model through the normal key pool. Any embedding failure must silently degrade to exact matching, never fail the request.

## Deliberately Not Ported

Do not add these unless a task explicitly changes the scope:

- MCP/A2A gateway features.
- OmniRoute's full dashboard, PWA, or Electron shell.
- Bandit exploration, speculative hedging, or model-level health/capability fallback.
- SQLite/Redis quota infrastructure.
- Concurrency queues or per-model concurrency limits.
- Budget enforcement beyond visible usage/quota meters.
- Broad upstream rate-limit header intelligence beyond `Retry-After`.

## Panel Behavior Notes

- The **Routing** tab is the routes list: an agents-facing model name backed by one or more `provider/model` targets. **Settings** opens with a **How settings work** explainer banner, then the global behavior and config in five cards, in order: **Global Policies** (match, rewrite or redirect a request, with an optional fallback chain), **Request optimization** (compression, context relay, response cache), **Key scheduling** (key pools plus circuit breaker), **Client access** (bearer keys for tools outside Orca), and **Configuration** (import/export). Each card carries a one-line description and, where it helps, sub-headings. There is no global failover or health sub-tab. **Providers** owns endpoints, models, keys, per-provider health badges, and the **Test all** button.
- The **Routes** section is the simple failover editor: a name agents send, targets picked from one searchable provider/model list, a **Try sequence** selector (fastest available first, or the order you selected), and **Retries per target**. A **Global Policies** entry can match the request, rewrite fields, set a default model, and append a fallback chain of routes and/or raw `provider/model` targets. Imported single-target aliases show as routes and migrate when edited.
- A single provider/model request retries the same target `config.retries` times and never fails over. An unknown chat model returns `404 model_not_found`.
- The panel shows a dismissible **Migrated failover chains** card from `config.migration`; dismissing it clears the entries. The worker logs the same migration summary.
- Provider model discovery is selective: checked fetched models are saved, unchecked fetched models are removed, and models missing from the fetch response are preserved.
- A provider's **Edit** form edits every provider field in place: display name, one or more endpoints (each with its own OpenAI/Anthropic/Responses/Gemini protocols), the model list, and the optional usage source. Endpoints that repeat the same base URL are grouped into one row with the union of their protocols; saving writes one endpoint per URL and sets `provider.baseUrl`/`provider.protocols` from the first endpoint and the protocol union.
- The **Add provider → Custom provider** form uses the same grouped sections and controls as the Edit form (inline provider name, grouped Endpoint(s) with base URLs and protocol chips, Models, Usage source, Keys). It supports multiple endpoints and saves a filled usage connector when the provider is created.
- Re-fetching models preselects the saved models. The picker supports filtering, select/deselect, a count badge, a short preview, and a scrollable full list.
- **Fetch all models** (under **Providers**) and **Fetch all models from all providers** (in a route's target editor) pull every provider's model list in one request (`router.discoverAllModels`). Under **Providers** it opens a provider-grouped, searchable checkbox list whose save writes the picked ids into each provider's model list; a provider that failed to respond is reported and left untouched. In a route's target editor the models that aren't saved yet are merged into the same target list, marked **new**, and picking one writes it into its provider when the route is saved.
- Key copy, remove, and edit actions live under **Options**. The row itself stays compact.
- **Edit key** loads the existing secret into a visible editable field. Saving replaces the stored value without deleting the pool entry.
- Only non-default key priority, weight, and limit metadata is shown in the row.
- Request logs identify the provider credential used for each request.
- Route targets are edited with a searchable multi-select with a resolved-order preview. A provider target with a blank model is a warning and blocks saving instead of being dropped silently. Bare model/alias targets remain valid.
