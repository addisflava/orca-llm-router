# Orca LLM Router

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Orca: >=1.4.248](https://img.shields.io/badge/Orca-%3E%3D1.4.248-6366f1.svg)](https://onorca.dev)
[![Node: >=22](https://img.shields.io/badge/Node-%3E%3D22-green.svg)](package.json)
[![Tests: 73 Passing](https://img.shields.io/badge/Tests-73%20passing-brightgreen.svg)](tests/sidecar.test.mjs)

**Use all your subscriptions and API credits from any provider and coding plan on any agent in Orca, in one place, without leaving Orca.** Features multi-key credential pools with auto-rotation, load balancing, and routing different providers behind a single model name by prioritizing the fastest, lowest-latency endpoints with seamless fallback.

Point all your coding agents (**Claude Code, OpenAI Codex, OpenCode, Pi, Aider, Cursor, Cline**) to a single stable local endpoint (`127.0.0.1:18080`). **Orca LLM Router** transparently translates protocols, maps reasoning/thinking modes, load-balances across credential pools, handles automatic fallbacks, and routes traffic directly to your chosen providers.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ Orca Agent Environment (Claude Code, Codex, OpenCode, Pi, Aider...)    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ agent.launch.before hook
                                    │ ANTHROPIC_BASE_URL -> http://127.0.0.1:18080
                                    │ OPENAI_BASE_URL    -> http://127.0.0.1:18080/v1
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Orca LLM Router Gateway (127.0.0.1:18080)                              │
│                                                                        │
│ • Model Aliases & Rewriting Rules (Regex / Exact / Field matching)     │
│ • Cross-Protocol Translation (Anthropic ↔ OpenAI ↔ Gemini ↔ Responses)  │
│ • Extended Thinking Translation (Claude 3.7 ↔ o1/o3-mini ↔ DeepSeek R1) │
│ • Multimodal Vision Mapping (Base64 inline ↔ OpenAI image_url)         │
│ • Credential Pools & Smart Cooldowns (Priority, Weights, Non-destr. RPM)│
│ • Model-Chain Fallbacks (Auto-switch on 4xx/5xx or rate limits)        │
│ • Prompt Cache Header Preservation (anthropic-beta passthrough)        │
└───────┬───────────────────────────┬────────────────────────────┬───────┘
        │                           │                            │
        ▼                           ▼                            ▼
┌──────────────────┐       ┌──────────────────┐         ┌──────────────────┐
│    Anthropic     │       │      OpenAI      │         │   Google Gemini  │
│ api.anthropic.com│       │ api.openai.com/v1│         │generativelanguage│
└──────────────────┘       └──────────────────┘         └──────────────────┘
        │                           │                            │
        ▼                           ▼                            ▼
┌──────────────────┐       ┌──────────────────┐         ┌──────────────────┐
│     DeepSeek     │       │    OpenRouter    │         │  Ollama / Local  │
│ api.deepseek.com │       │ openrouter.ai/v1 │         │  127.0.0.1:11434 │
└──────────────────┘       └──────────────────┘         └──────────────────┘
        │
        └─► Any OpenAI, Anthropic, or Gemini-compatible endpoint
```

---

## Key Features

### 1. Universal Cross-Protocol Translation
- **Four Protocol Surfaces**: Serves Anthropic Messages (`/v1/messages`), OpenAI Chat Completions (`/v1/chat/completions`), OpenAI Responses (`/v1/responses`), and Google Gemini Native (`/v1beta/models/...:generateContent`).
- **Bidirectional Conversion**: Translate requests and responses on the fly. Point Claude Code at DeepSeek-V3, Codex at Claude 3.7 Sonnet, or OpenCode at Google Gemini with zero code changes.
- **Cross-Protocol Streaming**: Real-time SSE streaming translation preserves chunks and usage metadata across disparate provider APIs.

### 2. Extended Thinking & Reasoning Parity
- **Claude 3.7 Sonnet ↔ OpenAI o1/o3-mini ↔ DeepSeek-R1**:
  - Automatically translates Anthropic's `thinking: { type: 'enabled', budget_tokens }` into OpenAI's `reasoning_effort` (`low`, `medium`, `high`).
  - Incompatible parameters are stripped for standard models to prevent `400 Bad Request` schema errors.
  - Maps DeepSeek `reasoning_content` and OpenAI thinking blocks back into native Anthropic `thinking` blocks for Claude Code.

### 3. Multimodal Vision Translation
- Seamlessly converts Anthropic base64 images (`source: { type: 'base64', media_type, data }`) into OpenAI `image_url` data URIs and Google Gemini `inlineData` parts.

### 4. Smart Credential Pools & Non-Destructive Rate Limiting
- **Multiple Keys per Provider**: Rotate across API keys using prioritized round-robin or weighted distribution.
- **Automatic Cooldowns**: Keys encountering 401/403 (auth error) or 429 (rate limits) are cooled down and bypassed automatically until their timeout expires.
- **Accurate Rate Window Tracking**: Non-destructive rolling window tracking accurately enforces `rpm`, `rph`, `rpd`, `tpm`, `tph`, and `tpd` without discarding historical window counts.
- **Zero-Leakage Security**: Provider credentials live exclusively in Orca's encrypted `secrets:own` vault. Client gateway tokens are never leaked to upstream providers.

### 5. Prompt Caching & Header Transparency
- Passes `anthropic-beta` headers (`prompt-caching-2024-07-31`, `thinking-2024-11-25`, `max-tokens-3-5-sonnet-2024-07-15`) directly through to Anthropic upstreams, preserving 90% cost savings on repetitive prompts.
- Honors upstream `Retry-After` headers (both integer seconds and RFC 1123 HTTP-date formats).

### 6. Seamless Agent Integration (Orca-Native)
- **Zero Config Corruption**: Unlike external routers that overwrite `~/.claude/settings.json` or global dotfiles, Orca LLM Router uses Orca's `agent.launch.before` hook to inject isolated per-session environments.
- **OpenCode & Codex Discovery**: Automatically publishes enabled models to OpenCode's standalone config and injects dynamic Codex `-c model_catalog_json` catalogs.

### 7. 1-Click Migration from Legacy Routers
- **Claude Code Router (CCR)**: Imports models, profiles, aliases, and rules from `~/.claude-code-router`.
- **OmniRoute**: Imports connections, nodes, combos, and decrypts AES-256-GCM credentials (`enc:v1:...`) automatically.

---

## Supported Providers

Built-in presets with model catalogs, pricing data, and usage scrapers:

| Provider | Protocols | Default Base URL |
|---|---|---|
| **Anthropic** | `anthropic` | `https://api.anthropic.com` |
| **OpenAI** | `openai`, `responses` | `https://api.openai.com/v1` |
| **Google Gemini (AI Studio)** | `gemini` | `https://generativelanguage.googleapis.com` |
| **OpenRouter** | `openai` | `https://openrouter.ai/api/v1` |
| **DeepSeek** | `openai` | `https://api.deepseek.com` |
| **Ollama (Local)** | `openai` | `http://127.0.0.1:11434/v1` |
| **Groq** | `openai` | `https://api.groq.com/openai/v1` |
| **Mistral AI** | `openai` | `https://api.mistral.ai/v1` |
| **Moonshot (Kimi)** | `openai` | `https://api.moonshot.cn/v1` |
| **SiliconFlow** | `openai` | `https://api.siliconflow.cn/v1` |
| **Z.AI (GLM / Zhipu)** | `openai` | `https://open.bigmodel.cn/api/paas/v4` |
| **MiniMax** | `openai` | `https://api.minimax.chat/v1` |
| **Custom Endpoint** | `openai`, `anthropic`, `responses`, `gemini` | Any compatible URL |

---

## Quick Start

### 1. Installation in Orca
Install or load directly inside Orca ADE:
```bash
# Validate the manifest
orca plugin validate .

# Load into Orca as a live development plugin
orca plugin dev watch .
```

### 2. Configure Providers
1. Open the Orca right sidebar and select the **Orca LLM Router** panel (or run command `Orca LLM Router: gateway status`).
2. Navigate to **Providers** and choose any preset (e.g., Anthropic, DeepSeek, OpenAI).
3. Add your API key. Keys are encrypted and stored in Orca's secure secret store.
4. Set your default provider or configure routing rules.

### 3. Launch Any Agent
Launch any coding agent in Orca—it will automatically route through `http://127.0.0.1:18080`:
```bash
# Claude Code routes through your configured Anthropic/OpenAI upstream
claude

# Codex routes through the gateway catalog
codex

# OpenCode routes through standalone gateway config
opencode
```

---

## Configuration & Routing Rules

Routing rules are evaluated top-to-bottom. The first matching rule wins:

```json
{
  "routes": [
    {
      "id": "route-claude-fast",
      "name": "Route fast requests to DeepSeek",
      "enabled": true,
      "condition": {
        "source": "request.body",
        "field": "model",
        "operator": "starts-with",
        "value": "claude-3-5-haiku"
      },
      "rewrites": [
        { "key": "request.body.model", "operation": "set", "value": "deepseek/deepseek-chat" }
      ],
      "fallback": {
        "mode": "model-chain",
        "models": ["openrouter/deepseek/deepseek-chat", "openai/gpt-4o-mini"],
        "retryCount": 1
      }
    }
  ]
}
```

### Fallback Modes
- **`retry`**: Retries the same model $N$ times with exponential backoff before failing.
- **`model-chain`**: If upstream returns 4xx/5xx or rate limits, the gateway sequentially tries backup models in the configured chain.

---

## Testing & Validation

The gateway core has zero external runtime dependencies (`node:http` + native `fetch`) and includes a pure Node.js test suite:

```bash
# Run unit tests (71 passing tests)
npm test

# Check Orca plugin manifest and component rendering
npm run validate
orca plugin check .
```

---

## Contributing & Publishing

To publish to the public Orca directory (`onorca.dev/plugins`):
1. Tag your repository with the `orca-plugin` topic:
   ```bash
   gh repo edit --add-topic orca-plugin
   ```
2. Create and push a version tag:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
3. Your plugin will be indexed on `https://www.onorca.dev/plugins/addisflava/orca-llm-router` within an hour.

---

## License

MIT © [Orca Community](LICENSE)
