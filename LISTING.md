# Orca LLM Router — Official Orca Marketplace Listing & Promotion Pack

[![Orca Plugin](https://img.shields.io/badge/Orca%20Plugin-v1.1.0-6366f1.svg)](https://onorca.dev/plugins)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Zero Telemetry](https://img.shields.io/badge/Privacy-Zero%20Telemetry-green.svg)](#privacy--security)

![Orca LLM Router Cover](assets/cover.jpg)

---

## Part 1: Marketplace Metadata & Fast Copy

### One-Sentence Hook (Elevator Pitch)
> **Use all your subscriptions, API credits, and free web models across any coding agent in Orca — with zero-config auto-wiring, weighted rotation, and resilient cross-provider failover.**

### Short Description (Search / Modal Card — 75 words)
> Stop getting blocked by provider rate limits mid-task. Orca LLM Router runs a lightweight, zero-dependency local gateway (`127.0.0.1:18080`) that bridges 45+ coding agents (Claude Code, Codex, OpenCode, Cursor, Pi, and more) to 34+ model providers. Features multi-key credential pools with smooth weighted rotation, resilient cross-provider failover, native web-chat transports for free DeepSeek and Qwen web subscriptions, and opt-in token compression. Your keys stay encrypted in Orca’s vault.

### Marketplace Tags
`developer-tools` `ai-agents` `llm-gateway` `rate-limiting` `failover` `claude-code` `codex` `opencode` `deepseek` `token-optimization`

---

## Part 2: Marketplace Listing (Long-Form Storefront)

# Orca LLM Router

### Never let an upstream rate limit or API outage kill an agent run again.

When you run autonomous coding agents like **Claude Code**, **OpenAI Codex**, or **OpenCode**, hitting an upstream `429 Too Many Requests`, a `503 Service Unavailable`, or a sudden key exhaustion means your entire coding workflow grinds to a halt. 

**Orca LLM Router** eliminates provider bottlenecks by introducing a resilient, Orca-native local gateway that aggregates all your AI subscriptions, API credits, and local models into one unified endpoint.

---

### The Daily Pain vs. The Orca LLM Router Solution

| The Daily Frustration | What Orca LLM Router Does |
|---|---|
| **Rate limits kill your agent mid-task** | Routes automatically retry and fail over across alternative providers or models. Your agent session continues uninterrupted. |
| **Paid subscriptions sit idle while API keys burn** | One endpoint drains all your subscriptions, token plans, and API credits with smooth, weighted rotation. |
| **API keys scattered across dotfiles & repos** | Every credential is saved in Orca’s encrypted secret vault; configs and logs only ever reference friendly key names. |
| **Every agent requires conflicting configs** | An Orca launch hook injects the gateway configuration per agent session with zero dotfile overwrites. |
| **Multi-key rotation busts prompt caching** | Cache affinity pins sessions to the same credential and preserves upstream prompt caching headers (`anthropic-beta`). |
| **Provider outages stall the entire IDE** | Provider circuit breakers, exponential backoff, and explicit `420 router_exhausted` route around bad upstreams. |

---

## Visual Feature Gallery

### 1. Live Gateway Overview & Telemetry
Monitor real-time token throughput (input/output), average latency, active requests, cost tracking, and endpoint addresses at a single glance.

[![Gateway Overview](assets/screenshot-overview.png)](assets/screenshot-overview.png)

### 2. Smart Cross-Provider Routing
Map friendly, unified model aliases (like `smart`, `fast`, or `deepseek-rout`) to multi-provider fallback chains. Rank by **fastest-healthy-first** or strict custom sequence with configurable retries per hop.

[![Smart Routing](assets/screenshot-routing.png)](assets/screenshot-routing.png)

### 3. Real-World Failover Telemetry & Live Logs
Proof that auto-failover saves your work: search and filter live logs (`provider=openrouter AND status=529`). Watch 10-attempt retry sequences route around upstream 503s to land smoothly on a healthy key with a `200 OK`.

[![Live Request Logs](assets/screenshot-logs.png)](assets/screenshot-logs.png)

### 4. Interactive Route Target Builder
Search across 360+ discovered models from any connected provider. Multi-select backup models and drag-and-drop or use arrow controls to tune your fallback priority.

[![Visual Route Builder](assets/screenshot-targets.png)](assets/screenshot-targets.png)

### 5. Multi-Key Credential Pools & Quota Scrapers
Add multiple API keys per provider with weighted round-robin distribution and priority tiers. Track 24-hour request/token meters with built-in quota scrapers and one-click balance probing.

[![Providers & Keys](assets/screenshot-providers.png)](assets/screenshot-providers.png)

### 6. 45+ Supported Coding Agents Out-of-the-Box
Toggle routing per agent with a single click. Claude Code, Codex, OpenCode, Cursor, Cline, Pi, Kimi, and dozens more connect automatically without manual terminal flags.

[![Coding Agents](assets/screenshot-agents.png)](assets/screenshot-agents.png)

### 7. Opt-In Token Optimization
Cut down context bloat and speed up inference. Opt into whitespace and ANSI prompt compression, deterministic one-line failover context relay, and local exact/semantic response caching.

[![Request Optimization](assets/screenshot-optimization.png)](assets/screenshot-optimization.png)

---

## Breakthrough Feature: Free Web-Chat Transports ⚡

Why pay for API tokens when your existing web subscriptions are unlimited?

Orca LLM Router includes **native web-chat transports** for **DeepSeek Web** (`chat.deepseek.com`) and **Qwen Web** (`chat.qwen.ai`):
- **Direct Web Driving**: The gateway interacts directly with the provider web interfaces—no external servers, no third-party proxies.
- **1-Click Browser Authentication**: Connects to Chrome via Chrome DevTools Protocol (CDP) to capture session tokens and anti-bot cookies directly into Orca's encrypted vault. Manual JSON paste fallback supported.
- **Full Conversation Management**: Supports multi-turn session chaining, automatic context-overflow resets, and empty-response retry logic.
- **Agent Compatible**: Your agents send standard OpenAI API completions; the router translates them to and from web-chat SSE streams transparently.

---

## Comprehensive Provider Matrix

**34 pre-configured presets** plus custom endpoint support:

- **Flagship Providers**: OpenAI, Anthropic, Google Gemini (AI Studio), OpenRouter, DeepSeek, NVIDIA NIM.
- **Free Web Subscriptions**: DeepSeek Web (`chat.deepseek.com`), Qwen Web (`chat.qwen.ai`).
- **Coding & Regional Plans**: OpenCode Go, Xiaomi MiMo (Global, China, Singapore, Europe Token Plans), Kimi Code (Moonshot), Zhipu AI / Z.AI (General & Coding Plans), MiniMax (Global & China), Alibaba Bailian (DashScope), SiliconFlow.
- **Alternative & Aggregator Endpoints**: Mistral AI, Qiniu AI, Fenno.ai, Infistar, RunAPI, TeamoRouter, Unity2.Ai, code0.ai, claudeapi, Y-API.
- **Local & Self-Hosted**: Ollama, vLLM, LM Studio, LocalAI, or any standard OpenAI-, Anthropic-, or Gemini-compatible server.

---

## Zero-Friction Agent Integration

Orca LLM Router intercepts agent launches via Orca’s `agent.launch.before` lifecycle hook:
- **Claude Code**: Injects Anthropic-compatible base URL and model mappings (`/model` selects gateway routes).
- **OpenAI Codex**: Dynamically injects model catalog JSON and publishes managed configuration blocks.
- **OpenCode**: Publishes standalone gateway configuration for instant connection.
- **Cursor, Cline, Aider, Pi, & 40+ others**: Seamlessly route through the local gateway with isolated per-session environments.

---

## Privacy & Security

- **Localhost Bound**: The gateway binds to `127.0.0.1:18080` by default. No inbound network ports opened.
- **Encrypted Secret Storage**: All API keys, bearer tokens, and web session cookies are encrypted using Orca’s native `secrets:own` vault.
- **Zero Secret Leaks**: Config files, runtime logs, error dumps, and upstream request headers never store or print secret keys.
- **Zero Telemetry**: Completely private with no analytics, tracking, or external phone-home requests.

---

## Quick Start Guide

1. **Install Plugin**: Search for **LLM Router** in the Orca Plugin Directory and click **Install**.
2. **Add a Provider**: Open the **Orca LLM Router** panel, select a preset (e.g., Anthropic, DeepSeek, or Gemini), and paste your key.
3. **Configure a Route (Optional)**: In **Routing**, create a unified route name (e.g., `fast` or `coding`) and select your preferred backup providers.
4. **Launch Any Agent**: Launch `claude`, `codex`, or `opencode` directly from Orca. Traffic routes automatically!

---

## Part 3: Ready-to-Post Promotional Copy

### Ad Option A: Orca Discord / Community Forum Announcement

```markdown
🚀 **NEW RELEASE: Orca LLM Router v1.1.0 — Never let rate limits kill your agent workflows!**

Hey everyone! 👋 

If you use AI coding agents like Claude Code, Codex, or OpenCode inside Orca, you know how painful it is when an upstream provider hits a 429 rate limit or goes down mid-task. 

We just released **Orca LLM Router v1.1.0** — a lightweight, zero-dependency local gateway built specifically for Orca.

**What it does:**
⚡ **One local endpoint (`127.0.0.1:18080`)** that automatically wires up 45+ coding agents with zero dotfile edits.
🔄 **Smart Cross-Provider Failover**: Define a model route like `coding` that tries your fastest provider, then automatically falls over to backups if rate-limited.
🔑 **Multi-Key Credential Pools**: Weighted rotation, priority tiers, and 24h usage meters.
🌐 **Native Web-Chat Transports**: Drive free DeepSeek Web and Qwen Web subscriptions directly through standard API endpoints!
🗜️ **Token Optimization**: Opt-in ANSI/whitespace compression, failover context relay, and response caching.
🔒 **100% Private**: All keys stay in Orca's encrypted vault. Zero telemetry.

Check out the live failover proof and grab it from the Orca Plugin Directory:
👉 Install via Orca: Plugins -> Search "LLM Router"
🔗 GitHub: https://github.com/addisflava/orca-llm-router
```

---

### Ad Option B: Twitter / X Launch Thread

```text
🧵 1/5 Tired of coding agents dying mid-refactor because an AI provider rate-limited you?

Introducing Orca LLM Router: a native, zero-dependency gateway that routes 45+ agents across 34+ providers with automatic, resilient failover.

Here’s why it’s a game-changer for Orca devs 👇

2/5 🔄 Seamless Cross-Provider Failover
Map model names like "smart" to a chain of targets. If your primary provider throws a 429 or 503, the router immediately retries on your backup without dropping the agent turn. 21 failovers handled in our real-world tests with 0 interruptions!

3/5 🌐 Free Web Subscriptions as API Endpoints
Got free DeepSeek or Qwen web accounts? Orca LLM Router includes native CDP browser authentication to drive web sessions directly as standard OpenAI-compatible endpoints. Free tokens inside your favorite coding agents.

4/5 🔑 Multi-Key Rotation & Prompt Cache Affinity
Distribute load across multiple keys with weighted round-robin and priority tiers. Session pinning ensures your Anthropic prompt caches stay warm and cost-efficient.

5/5 📦 Ready to install today!
Works out-of-the-box with Claude Code, Codex, OpenCode, Cursor, Pi, and 40+ more. Encrypted secrets, localhost-only, zero telemetry.

Available now in the Orca Plugin Directory or on GitHub:
https://github.com/addisflava/orca-llm-router
```

---

### Ad Option C: Reddit / Hacker News (Show Orca / Show HN)

```markdown
**Title:** Show: Orca LLM Router – Resilient local gateway with cross-provider failover and free web-chat transports for coding agents

**Post Body:**
Hey everyone,

When running autonomous coding agents (Claude Code, OpenAI Codex, OpenCode) inside our dev workflows, we kept running into the same frustrating problems:
1. Mid-task 429 rate limits causing agent crashes.
2. Fragmented API keys and credentials sitting in dotfiles.
3. Paying for monthly web subscriptions that couldn't be used inside terminal coding agents.

To solve this, we built **Orca LLM Router**—a lightweight local gateway plugin for Orca written with zero runtime npm dependencies (using Node built-ins and native fetch).

**Key Architectural Features:**
- **Zero-Config Agent Wiring**: Uses Orca's `agent.launch.before` lifecycle hook to inject gateway endpoints and model catalogs into 45+ agents per session without overwriting global dotfiles.
- **Fastest-Healthy-First Routing**: Measures time-to-first-byte and circuit breaker health to rank targets on the fly, with session affinity to protect prompt cache efficiency.
- **Native Web-Chat Engine**: Connects via Chrome DevTools Protocol to capture web-chat auth from DeepSeek and Qwen, converting web SSE streams into standard OpenAI chat completion objects.
- **Opt-in Deterministic Transforms**: Prompt whitespace and ANSI compression, one-line handoff context digests on failover, and local response caching.
- **Encrypted Storage**: Sensitive tokens never touch logs or config files; all keys reside in Orca's secure secret store.

The code is fully open source (MIT):
https://github.com/addisflava/orca-llm-router

Feedback and PRs are very welcome!
```
