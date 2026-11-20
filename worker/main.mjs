// Orca LLM Router worker: owns the self-contained local gateway and wires it into Orca.
//
//   agent launch -> agent.launch.before hook rewrites env (ANTHROPIC_BASE_URL,
//                   OPENAI_BASE_URL, auth) and, for Claude Code, adds
//                   `--settings` so on-disk settings cannot override the local
//                   gateway at http://127.0.0.1:18080 (or the configured port).
//                   OpenCode gets a generated OPENCODE_CONFIG so its model
//                   picker lists the gateway's providers and models; Codex gets
//                   a generated model catalog plus per-launch `-c` provider
//                   overrides. Those per-launch overrides cover every agent Orca
//                   starts. Editing the user's global Codex/OpenCode config is
//                   opt-in (`routeOutsideOrca`, off by default) and only exists
//                   for a plain terminal `codex` / `opencode` or Orca's native
//                   Codex chat; those writes are removed again when the router
//                   stops, the plugin deactivates, or the setting is turned off.
//   CLI -> sidecar (worker/sidecar.mjs) -> providers in the config, with
//                   conditional routing rules, rewrites, aliases, fallback
//                   chains, retries and per-provider credential pools.
//
// Config lives in storage 'router.config' (seeded from DEFAULT_CONFIG);
// API keys live in secrets:own under the key entries' secretKey names, never
// in storage or logs. Settings (port, host, timeouts, enabled) come from Orca
// Settings via settings:own and are cached so the launch hook never blocks on
// a host round-trip.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  DEFAULT_CONFIG,
  PROVIDER_PRESETS,
  createSidecar,
  convertLegacyConfig,
  convertClaudeCodeRouterConfig,
  convertOmniRouteConfig,
  mergeRouterConfigs,
  detectAndConvertConfig,
  detectLocalRouterConfigs,
  fetchProviderUsage,
  probeProviderUsage,
  resolveUsageFetch,
  normalizeConfig,
  buildAgentLaunchEnv,
  buildOpenCodeConfig,
  buildCodexModelCatalog,
  mergeOpenCodeConfig,
  agentProfileFor,
  providerFromPreset,
  isWebChatTransport,
  webchatCatalog,
  webchatConfigured,
  joinUpstreamUrl
} from './sidecar.mjs'
import { normalizeVpnServer } from './proxy.mjs'
import {
  AUTH_PROVIDERS,
  startAuthBrowser,
  captureAuth,
  connectPageTarget,
  removeProfileSafely,
  CDPClient,
  devtoolsReady,
} from './webchat/auth.mjs'
import { DeepSeekWebTransport, normalizeCredential as normalizeDeepSeekCred } from './webchat/deepseek.mjs'
import { QwenWebTransport, normalizeCredential as normalizeQwenCred } from './webchat/qwen.mjs'
import { ORCA_AGENTS } from './orca-agents.mjs'

const CONFIG_KEY = 'router.config'
// Usage counters and provider health are runtime state, not settings. They are
// snapshotted separately so a plugin restart keeps the 24h windows and badges.
const RUNTIME_KEY = 'router.runtime'
const RUNTIME_FLUSH_INTERVAL_MS = 10_000
// Persisted request logs are opt-in and live under their own key. Only sanitized
// entries (no bodies or headers) are written; see panelLogEntry.
const LOGS_KEY = 'router.logs'
const LOGS_PERSIST_THROTTLE_MS = 5_000
const MAX_PERSISTED_LOGS = 300
const STATUS_BAR_ID = 'router-status'

let sidecar = null
let runtimeFlushTimer = null
let runtimeWrite = Promise.resolve()
let persistedLogs = []
let logsDirty = false
let lastLogPersistAt = 0
let logFlushTimer = null
let logWrite = Promise.resolve()
let config = null
let settings = { enabled: true, routeOutsideOrca: false, port: 18080, bindHost: '127.0.0.1', timeoutMs: 600000, retries: 2, baseDelayMs: 200 }
const secretsCache = new Map()
const keyUsageCache = new Map()
const authSessions = new Map() // webchat transport -> auth session state
const KEY_USAGE_TTL_MS = 60_000
let boundAddress = null
let installedAgentsCache = null

// --- Orca agent list --------------------------------------------------------
// The agent ids Orca launches (and this plugin toggles) live in orca-agents.mjs.
// `installed` mirrors the host's own PATH probe so the panel can lead with the
// agents a person can actually launch.
function commandOnPath(command) {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (existsSync(join(dir, command + ext))) return true
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return false
}

function installedAgentIds() {
  if (installedAgentsCache) return installedAgentsCache
  const found = new Set()
  for (const agent of ORCA_AGENTS) {
    const commands = agent.commands ?? [agent.id]
    if (!commands.some(commandOnPath)) continue
    if ((agent.requires ?? []).some((required) => !commandOnPath(required))) continue
    found.add(agent.id)
  }
  installedAgentsCache = found
  return found
}

function agentRoutes() {
  const normalized = normalizeConfig(config)
  const installed = installedAgentIds()
  return ORCA_AGENTS.map((agent) => {
    const profile = agentProfileFor(normalized, agent.id)
    return { agent: agent.id, name: agent.name, installed: installed.has(agent.id), enabled: profile?.enabled !== false }
  })
}

export function panelLogEntry(entry) {
  if (!entry) return null
  return {
    at: entry.at,
    upstream: entry.upstream ?? null,
    resolvedProvider: entry.resolvedProvider ?? null,
    route: entry.route ?? null,
    // Only the server's display name is shown; URLs and credentials never are.
    vpn: entry.vpn ?? null,
    credential: entry.credential ?? null,
    requestModel: entry.requestModel,
    resolvedModel: entry.resolvedModel,
    model: entry.model ?? entry.resolvedModel ?? '',
    protocol: entry.protocol ?? '',
    stream: entry.stream ?? null,
    failedOver: entry.failedOver === true,
    errorCode: entry.errorCode ?? null,
    policyId: entry.policyId ?? null,
    status: Number(entry.status ?? 0),
    latencyMs: entry.latencyMs ?? null,
    attempts: Array.isArray(entry.attempts) ? entry.attempts.slice(0, 10) : [],
    failures: Array.isArray(entry.failures)
      ? entry.failures.slice(0, 10).map((f) => ({
          provider: f.provider,
          model: f.model,
          status: f.status,
          error: typeof f.error === 'string' ? f.error.slice(0, 200) : undefined
        }))
      : undefined,
    delaysMs: entry.delaysMs,
    bytes: entry.bytes,
    tokens: entry.tokens ? {
      input: Number(entry.tokens.input ?? 0),
      output: Number(entry.tokens.output ?? 0),
      cache: entry.tokens.cache != null ? Number(entry.tokens.cache) : undefined
    } : null,
    cost: entry.cost != null ? Number(entry.cost) : null,
    compression: entry.compression ?? null,
    relay: entry.relay ?? null,
    cache: entry.cache ?? null,
    cacheSavedTokens: entry.cacheSavedTokens != null ? Number(entry.cacheSavedTokens) : undefined,
    cacheSavedCost: entry.cacheSavedCost != null ? Number(entry.cacheSavedCost) : undefined,
    error: typeof entry.error === 'string' ? entry.error.slice(0, 256) : undefined
  }
}

// --- Claude Code settings override -----------------------------------------
// Claude Code applies its on-disk settings over the process env, so an agent
// configured by another router (base URL, apiKeyHelper) would ignore the env
// this hook injects. Passing --settings with our own env wins at CLI
// precedence while leaving the rest of the user's settings intact.
const CLAUDE_SETTINGS_DIR = join(tmpdir(), 'orca-llm-router')
const CLAUDE_SETTINGS_FILE = join(CLAUDE_SETTINGS_DIR, 'claude-settings.json')
const CLAUDE_SETTINGS_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_BASE_URL',
  'CLAUDE_AGENT_API_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'NO_PROXY',
  'no_proxy',
  'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT',
  'ANTHROPIC_MODEL',
  'OPENAI_MODEL',
  'MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL'
]

function writeClaudeSettings(env) {
  const settingsEnv = {}
  for (const key of CLAUDE_SETTINGS_ENV_KEYS) {
    if (typeof env[key] === 'string' && env[key] !== '') settingsEnv[key] = env[key]
  }
  try {
    mkdirSync(CLAUDE_SETTINGS_DIR, { recursive: true })
    // An empty apiKeyHelper removes any helper the user's own settings define
    // (for example another router's), so Claude Code does not warn about or use
    // it alongside the auth token this plugin injects.
    writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify({ apiKeyHelper: '', env: settingsEnv }, null, 2))
    return CLAUDE_SETTINGS_FILE
  } catch {
    return null
  }
}

// Insert `--settings <file>` after the leading claude executable. Only the
// first token is inspected, so a prompt that mentions "claude" is untouched.
function injectClaudeSettings(command, settingsPath) {
  const script = String(command ?? '')
  if (!script || script.includes('--settings')) return script
  const first = script.match(/^(\s*)((?:"[^"]*"|'[^']*'|\S+))/)
  if (!first) return script
  const executable = first[2].replace(/["']/g, '').split(/[/\\]/).pop() ?? ''
  if (!/^claude(\.(cmd|exe|ps1))?$/i.test(executable)) return script
  const quoted = process.platform === 'win32'
    ? `"${settingsPath}"`
    : `'${settingsPath.replace(/'/g, `'\\''`)}'`
  const at = first[1].length + first[2].length
  return `${script.slice(0, at)} --settings ${quoted}${script.slice(at)}`
}

// --- OpenCode provider injection -------------------------------------------
// OpenCode does not read OPENAI_BASE_URL, and its v2 CLI talks to a shared
// background server that ignores env from later launches. A generated config
// file publishes the gateway and its models; `--standalone` makes the v2 CLI
// start a private server that actually inherits it.
const OPENCODE_CONFIG_DIR = join(tmpdir(), 'orca-llm-router')
const OPENCODE_CONFIG_FILE = join(OPENCODE_CONFIG_DIR, 'opencode.json')
const CODEX_CATALOG_FILE = join(OPENCODE_CONFIG_DIR, 'codex-models.json')
let opencodeV2Cache = null

function writeOpenCodeConfig(config, { base, token, agentId }) {
  const { document } = buildOpenCodeConfig(config, { base, token, agentId })
  try {
    mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true })
    // Atomic replace: parallel launches share one file and must never read a
    // partially written document.
    const temporary = `${OPENCODE_CONFIG_FILE}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(document))
    renameSync(temporary, OPENCODE_CONFIG_FILE)
    return OPENCODE_CONFIG_FILE
  } catch {
    return null
  }
}

function opencodeSupportsStandalone() {
  if (opencodeV2Cache !== null) return opencodeV2Cache
  try {
    const version = execFileSync('opencode', ['--version'], { encoding: 'utf8', timeout: 5000 })
    opencodeV2Cache = /(?:^|\s)v?2\./.test(version)
  } catch {
    opencodeV2Cache = false
  }
  return opencodeV2Cache
}

// Insert `--standalone` after the leading opencode/opencode2 executable. Orca
// already passes it for the opencode2 agent; this covers v2 installed as the
// plain `opencode` command without breaking older v1 builds.
function injectOpenCodeStandalone(command) {
  const script = String(command ?? '')
  if (!script || /(^|\s)--standalone(\s|$)/.test(script)) return script
  const first = script.match(/^(\s*)((?:"[^"]*"|'[^']*'|\S+))/)
  if (!first) return script
  const executable = first[2].replace(/["']/g, '').split(/[/\\]/).pop() ?? ''
  if (!/^opencode2?(\.(cmd|exe|ps1))?$/i.test(executable)) return script
  const at = first[1].length + first[2].length
  return `${script.slice(0, at)} --standalone${script.slice(at)}`
}

// Codex reads its provider and model catalog from config. Orca launches get
// per-launch `-c key=value` overrides; only the opt-in `routeOutsideOrca`
// setting also installs a marker-delimited block in ~/.codex/config.toml for
// native chat and a plain terminal `codex`. The block is removed when the
// router stops, the plugin deactivates, or the setting is turned off. The
// user's original values are kept in plugin storage so the restore preserves
// unrelated edits.
const CODEX_CONFIG_MARKER_BEGIN = '# BEGIN Orca LLM Router managed profile'
const CODEX_CONFIG_MARKER_END = '# END Orca LLM Router managed profile'
const CODEX_PROVIDER_MARKER_BEGIN = '# BEGIN Orca LLM Router managed Codex provider'
const CODEX_PROVIDER_MARKER_END = '# END Orca LLM Router managed Codex provider'
// Top-level keys the router captures into the storage backup on first apply:
// the always-owned routing keys, plus the optional `model` pin and reasoning
// effort it wrote for older installs. buildCodexManagedConfig strips only the
// keys it actually writes this time; restoreCodexGlobal strips the
// always-owned keys and re-inserts the backup, never duplicating.
const CODEX_CAPTURE_TOP_LEVEL = ['model', 'model_provider', 'model_catalog_json', 'model_reasoning_effort']
const CODEX_OWNED_TOP_LEVEL = ['model_provider', 'model_catalog_json']
const CODEX_CONFIG_BACKUP_KEY = 'router.codexConfigBackup'
let lastCodexCatalogJson = null
let activeOrca = null
let lastCodexBackup = null

function writeCodexCatalog(config, { agentId }) {
  const { document, model } = buildCodexModelCatalog(config, { agentId })
  const serialized = JSON.stringify(document)
  if (serialized === lastCodexCatalogJson && existsSync(CODEX_CATALOG_FILE)) {
    return { path: CODEX_CATALOG_FILE, model }
  }
  try {
    mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true })
    // Atomic replace: parallel launches share one file and must never read a
    // partially written catalog.
    const temporary = `${CODEX_CATALOG_FILE}.${process.pid}.tmp`
    writeFileSync(temporary, serialized)
    renameSync(temporary, CODEX_CATALOG_FILE)
    lastCodexCatalogJson = serialized
    return { path: CODEX_CATALOG_FILE, model }
  } catch {
    return null
  }
}

function codexConfigPath() {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex')
  return join(home, 'config.toml')
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function tomlQuoted(value) {
  return `"${tomlString(value)}"`
}

// Remove the marker-delimited managed blocks, leaving every other line intact.
// Each block is closed only by its own END marker: matching any END (or the
// wrong one) used to swallow user lines that followed the provider block.
function stripCodexManagedBlocks(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let endMarker = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === CODEX_CONFIG_MARKER_BEGIN) {
      endMarker = CODEX_CONFIG_MARKER_END
      continue
    }
    if (trimmed === CODEX_PROVIDER_MARKER_BEGIN) {
      endMarker = CODEX_PROVIDER_MARKER_END
      continue
    }
    if (endMarker) {
      if (trimmed === endMarker) endMarker = null
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

// Return a top-level TOML table (header plus its key lines), or null.
function extractTomlTable(text, tableName) {
  const lines = String(text ?? '').split('\n')
  const header = new RegExp(`^\\s*\\[${escapeRegExp(tableName)}\\]\\s*(?:#.*)?$`)
  const anyHeader = /^\s*\[/
  let start = -1
  for (let index = 0; index < lines.length; index++) {
    if (header.test(lines[index])) { start = index; break }
  }
  if (start < 0) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) {
    if (anyHeader.test(lines[index])) { end = index; break }
  }
  return lines.slice(start, end).join('\n').replace(/\n+$/, '')
}

function stripTomlTable(text, tableName) {
  const lines = String(text ?? '').split('\n')
  const header = new RegExp(`^\\s*\\[${escapeRegExp(tableName)}\\]\\s*(?:#.*)?$`)
  const anyHeader = /^\s*\[/
  const out = []
  let skipping = false
  for (const line of lines) {
    if (header.test(line)) { skipping = true; continue }
    if (skipping && anyHeader.test(line)) skipping = false
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

// Top-level keys are the bare `key = value` lines before the first table.
function extractTopLevelKeys(text, keys) {
  const lines = String(text ?? '').split('\n')
  const found = {}
  let inTopLevel = true
  for (const line of lines) {
    if (/^\s*\[/.test(line)) inTopLevel = false
    if (!inTopLevel) continue
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)
    if (match && keys.includes(match[1]) && !(match[1] in found)) found[match[1]] = line.trim()
  }
  return found
}

function stripTopLevelKeys(text, keys) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let inTopLevel = true
  for (const line of lines) {
    if (/^\s*\[/.test(line)) inTopLevel = false
    if (inTopLevel) {
      const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)
      if (match && keys.includes(match[1])) continue
    }
    out.push(line)
  }
  return out.join('\n')
}

// Build the managed Codex config. The profile keys must come before any table,
// so the profile block is prepended and the provider table appended. Only the
// keys we claim are stripped from the user's text: routing keys always, plus a
// model pin or reasoning effort only when we were given one. The router never
// picks Codex's model on its own; a profile model is an explicit opt-in.
export function buildCodexManagedConfig(text, { base, token, catalogPath, model, reasoningEffort }) {
  const effort = reasoningEffort
    ? (['low', 'medium', 'high'].includes(String(reasoningEffort)) ? String(reasoningEffort) : 'high')
    : ''
  const owned = [...CODEX_OWNED_TOP_LEVEL, ...(model ? ['model'] : []), ...(effort ? ['model_reasoning_effort'] : [])]
  let clean = stripCodexManagedBlocks(text)
  clean = stripTomlTable(clean, 'model_providers.orca-router')
  clean = stripTopLevelKeys(clean, owned)
  clean = clean.replace(/^\n+/, '').replace(/\n+$/, '')
  const baseUrl = `${String(base).replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`
  const profile = [
    CODEX_CONFIG_MARKER_BEGIN,
    ...(model ? [`model = ${tomlQuoted(model)}`] : []),
    'model_provider = "orca-router"',
    `model_catalog_json = ${tomlQuoted(catalogPath)}`,
    ...(effort ? [`model_reasoning_effort = ${tomlQuoted(effort)}`] : []),
    CODEX_CONFIG_MARKER_END
  ].join('\n')
  const provider = [
    CODEX_PROVIDER_MARKER_BEGIN,
    '[model_providers.orca-router]',
    'name = "Orca LLM Router"',
    `base_url = ${tomlQuoted(baseUrl)}`,
    `experimental_bearer_token = ${tomlQuoted(token)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    CODEX_PROVIDER_MARKER_END
  ].join('\n')
  return `${profile}\n\n${clean ? `${clean}\n\n` : ''}${provider}\n`
}

function readCodexConfigFile() {
  const path = codexConfigPath()
  try {
    return { path, text: readFileSync(path, 'utf8') }
  } catch {
    return { path, text: '' }
  }
}

function writeCodexConfigFile(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text)
  renameSync(temporary, path)
}

export async function applyCodexGlobal(orca, options) {
  if (!orca || !options?.catalogPath) return null
  const { path, text: current } = readCodexConfigFile()
  const managed = current.includes(CODEX_CONFIG_MARKER_BEGIN) || current.includes('[model_providers.orca-router]')
  const stored = await storageGet(orca, CODEX_CONFIG_BACKUP_KEY)
  const backup =
    stored.ok && stored.value?.path === path
      ? stored.value
      : lastCodexBackup?.path === path
        ? lastCodexBackup
        : null
  if (!managed) {
    // First apply (and any later apply after Codex rewrote the file and
    // dropped our block) remembers only the values we replace. Merge instead of
    // overwrite so a rewrite that drops one of the person's keys cannot erase
    // it, while a value changed while the router was stopped still wins.
    const mergedKeys = {
      ...(backup?.keys ?? {}),
      ...extractTopLevelKeys(current, CODEX_CAPTURE_TOP_LEVEL)
    }
    const providerTable =
      backup?.providerTable ?? extractTomlTable(current, 'model_providers.orca-router')
    const changed =
      !backup ||
      backup.path !== path ||
      JSON.stringify(backup.keys ?? {}) !== JSON.stringify(mergedKeys) ||
      (backup.providerTable ?? null) !== (providerTable ?? null)
    const nextBackup = {
      path,
      keys: mergedKeys,
      providerTable,
      appliedAt: changed
        ? new Date().toISOString()
        : backup?.appliedAt ?? new Date().toISOString()
    }
    if (changed) await orca.storage.set(CODEX_CONFIG_BACKUP_KEY, nextBackup).catch(() => {})
    lastCodexBackup = nextBackup
  } else if (!backup || backup.path !== path) {
    // Marker present without a usable backup (for example storage was cleared):
    // restore what we can by stripping our own block.
    const fallback = {
      path,
      keys: {},
      providerTable: null,
      appliedAt: new Date().toISOString(),
      fallback: true
    }
    await orca.storage.set(CODEX_CONFIG_BACKUP_KEY, fallback).catch(() => {})
    lastCodexBackup = fallback
  } else {
    lastCodexBackup = backup
  }
  const next = buildCodexManagedConfig(current, options)
  if (next === current) return path
  writeCodexConfigFile(path, next)
  return path
}

export async function restoreCodexGlobal(orca) {
  if (!orca) return false
  const { path, text: current } = readCodexConfigFile()
  const stored = await storageGet(orca, CODEX_CONFIG_BACKUP_KEY)
  const backup =
    stored.ok && stored.value?.path === path
      ? stored.value
      : lastCodexBackup?.path === path
        ? lastCodexBackup
        : null
  const managed = current.includes(CODEX_CONFIG_MARKER_BEGIN) || current.includes('[model_providers.orca-router]')
  if (!managed && !backup) return false
  let next = stripCodexManagedBlocks(current)
  next = stripTomlTable(next, 'model_providers.orca-router')
  next = stripTopLevelKeys(next, CODEX_OWNED_TOP_LEVEL)
  next = next.replace(/^\n+/, '').replace(/\n+$/, '')
  if (backup) {
    const entries = Object.entries(backup.keys ?? {}).filter(([, value]) => typeof value === 'string' && value)
    const present = extractTopLevelKeys(next, entries.map(([key]) => key))
    const keyLines = entries.filter(([key]) => !(key in present)).map(([, value]) => value)
    if (keyLines.length) next = `${keyLines.join('\n')}\n\n${next}`
    if (backup.providerTable) next = `${next ? `${next}\n\n` : ''}${backup.providerTable}`
  }
  writeCodexConfigFile(path, next ? `${next}\n` : '')
  lastCodexBackup = null
  await storageDelete(orca, CODEX_CONFIG_BACKUP_KEY)
  return true
}

// Writing the user's global Codex/OpenCode config is opt-in. Orca-launched
// agents already get the gateway through per-launch overrides, so these writes
// only serve a plain terminal `codex` / `opencode` and Orca's native Codex
// chat. There is deliberately no periodic re-insert: a block a person deletes
// stays deleted until the next explicit config change or router start.
export async function applyGlobalAgentConfig(orca, current) {
  if (!orca || !current) return false
  const catalog = writeCodexCatalog(current, { agentId: 'codex' })
  if (catalog) {
    const profile = agentProfileFor(normalizeConfig(current), 'codex')
    await applyCodexGlobal(orca, {
      base: gatewayAddress(),
      token: current.token || 'orca-router',
      catalogPath: catalog.path,
      model: catalog.model,
      reasoningEffort: profile?.reasoningEffort
    }).catch(() => {})
  }
  syncOpenCodeUserConfig(current, {
    base: gatewayAddress(),
    token: current.token || 'orca-router'
  })
  return true
}

export async function restoreGlobalAgentConfig(orca) {
  await restoreCodexGlobal(orca).catch(() => {})
  restoreOpenCodeUserConfig()
}

function globalAgentConfigActive() {
  return settings.enabled && settings.routeOutsideOrca && sidecar?.status().running === true
}

async function syncGlobalAgentConfig(orca, current) {
  if (!orca || !globalAgentConfigActive()) {
    await restoreGlobalAgentConfig(orca)
    return false
  }
  return applyGlobalAgentConfig(orca, current)
}

function shellQuote(value) {
  const text = String(value)
  if (process.platform === 'win32') return `"${text.replace(/"/g, '""')}"`
  return `'${text.replace(/'/g, `'\\''`)}'`
}

// Codex parses each `-c key=value` value as TOML. Escape backslashes so a
// Windows catalog path is read literally instead of as an escape sequence.
function tomlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Insert the provider and catalog overrides after the leading codex executable.
// `-c key=value` is Codex's supported per-launch config override, so an Orca
// launch never needs to rewrite the user's config file. The global block is
// only installed when `routeOutsideOrca` is enabled.
export function injectCodexProvider(command, { base, catalogPath, model, reasoningEffort, token = 'orca-router' }) {
  const script = String(command ?? '')
  if (!script || script.includes('model_providers.orca-router')) return script
  const first = script.match(/^(\s*)((?:"[^"]*"|'[^']*'|\S+))/)
  if (!first) return script
  const executable = first[2].replace(/["']/g, '').split(/[/\\]/).pop() ?? ''
  if (!/^codex(\.(cmd|exe|ps1))?$/i.test(executable)) return script
  const overrides = [
    'model_provider="orca-router"',
    ...(model ? [`model="${tomlString(model)}"`] : []),
    ...(reasoningEffort ? [`model_reasoning_effort="${tomlString(reasoningEffort)}"`] : []),
    ...(catalogPath ? [`model_catalog_json="${tomlString(catalogPath)}"`] : []),
    'model_providers.orca-router.name="Orca LLM Router"',
    `model_providers.orca-router.base_url="${tomlString(base)}/v1"`,
    `model_providers.orca-router.experimental_bearer_token="${tomlString(token)}"`,
    'model_providers.orca-router.wire_api="responses"',
    'model_providers.orca-router.requires_openai_auth=false'
  ]
  const args = overrides.map((value) => `-c ${shellQuote(value)}`).join(' ')
  const at = first[1].length + first[2].length
  return `${script.slice(0, at)} ${args}${script.slice(at)}`
}

// A plain terminal `opencode` has no agent hook to rewrite. When the opt-in
// `routeOutsideOrca` setting is on, OpenCode merges the global config and
// watches it live, so publish the same provider there. The modification is
// intentionally narrow: replace the stale CCR provider with ours and repoint
// model ids, leaving MCP servers, agents, plugins and unrelated providers
// untouched. Orca-launched agents use a generated OPENCODE_CONFIG instead.
const OPENCODE_USER_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
const OPENCODE_USER_FILE = join(OPENCODE_USER_DIR, 'opencode.jsonc')
const OPENCODE_USER_BACKUP = `${OPENCODE_USER_FILE}.orca-backup`
const LEGACY_ROUTER_PROVIDERS = ['claude-code-router']

function syncOpenCodeUserConfig(config, { base, token }) {
  if (!existsSync(OPENCODE_USER_DIR)) return null
  let existing = {}
  if (existsSync(OPENCODE_USER_FILE)) {
    try {
      existing = JSON.parse(readFileSync(OPENCODE_USER_FILE, 'utf8'))
    } catch {
      // JSONC with comments (or a broken file): never rewrite what we cannot
      // round-trip. The per-launch config still covers Orca-started agents.
      return null
    }
    if (!existsSync(OPENCODE_USER_BACKUP)) {
      try {
        writeFileSync(OPENCODE_USER_BACKUP, readFileSync(OPENCODE_USER_FILE))
      } catch {
        /* backup is best-effort */
      }
    }
  }
  const { document: generated } = buildOpenCodeConfig(config, { base, token, agentId: 'opencode' })
  const document = mergeOpenCodeConfig(existing, generated, LEGACY_ROUTER_PROVIDERS)
  try {
    mkdirSync(dirname(OPENCODE_USER_FILE), { recursive: true })
    const temporary = `${OPENCODE_USER_FILE}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`)
    renameSync(temporary, OPENCODE_USER_FILE)
    return OPENCODE_USER_FILE
  } catch {
    return null
  }
}

// Undo the opt-in OpenCode write. The pre-edit file is kept beside it so a
// restore is byte-for-byte, including any JSONC comments the writer could not
// round-trip. If the backup is gone, fall back to removing only our provider
// and the model pins we may have written, leaving unrelated edits in place.
export function restoreOpenCodeUserConfig() {
  try {
    if (existsSync(OPENCODE_USER_BACKUP)) {
      const original = readFileSync(OPENCODE_USER_BACKUP)
      const temporary = `${OPENCODE_USER_FILE}.${process.pid}.tmp`
      writeFileSync(temporary, original)
      renameSync(temporary, OPENCODE_USER_FILE)
      rmSync(OPENCODE_USER_BACKUP, { force: true })
      return true
    }
    if (!existsSync(OPENCODE_USER_FILE)) return false
    const document = JSON.parse(readFileSync(OPENCODE_USER_FILE, 'utf8'))
    if (!document || typeof document !== 'object') return false
    let changed = false
    if (document.provider && typeof document.provider === 'object' && 'orca-router' in document.provider) {
      delete document.provider['orca-router']
      changed = true
    }
    for (const key of ['model', 'small_model']) {
      if (typeof document[key] === 'string' && document[key].startsWith('orca-router/')) {
        delete document[key]
        changed = true
      }
    }
    if (!changed) return false
    // If the file was created by us and holds nothing else, remove it entirely.
    const unrelated = Object.keys(document).filter((key) => !['$schema', 'disabled_providers', 'provider'].includes(key))
    const emptyProvider = !document.provider || Object.keys(document.provider).length === 0
    if (!unrelated.length && emptyProvider) {
      rmSync(OPENCODE_USER_FILE, { force: true })
      return true
    }
    const temporary = `${OPENCODE_USER_FILE}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`)
    renameSync(temporary, OPENCODE_USER_FILE)
    return true
  } catch {
    return false
  }
}

async function storageGet(orca, key) {
  try {
    return { ok: true, value: (await orca.storage.get(key)) ?? null }
  } catch (error) {
    return { ok: false, value: null, error }
  }
}

async function storageDelete(orca, key) {
  try {
    if (typeof orca?.storage?.delete === 'function') await orca.storage.delete(key)
    else if (typeof orca?.storage?.set === 'function') await orca.storage.set(key, null)
  } catch {
    /* best-effort cleanup */
  }
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value))
}

async function hostCall(orca, method, params) {
  try {
    return await orca.host.call(method, params)
  } catch {
    return null
  }
}

// Verify a web-chat credential with a cheap real upstream call. Used both when
// credentials are captured and by the panel's Test action.
async function probeWebChat(transport, creds) {
  const fetchFn = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10000) })
  try {
    const client = transport === 'deepseek-web'
      ? new DeepSeekWebTransport({ creds, fetchFn })
      : new QwenWebTransport({ creds, fetchFn })
    const ok = await client.probe()
    return { ok: Boolean(ok), message: ok ? 'verified' : 'auth check returned no result' }
  } catch (probeError) {
    return { ok: false, message: String(probeError?.message ?? probeError) }
  }
}

// Web-chat credentials are stored as a JSON string in the vault. The transports
// and status checks consume an object, so parse those secrets on load — plain
// API keys stay untouched strings.
function parseCachedSecret(secretKey, value) {
  if (typeof value !== 'string' || !secretKey?.startsWith('webchat:')) return value
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* not JSON — keep the raw value */ }
  return value
}

async function refreshSecrets(orca) {
  secretsCache.clear()
  for (const provider of config?.providers ?? []) {
    for (const key of provider.keys ?? []) {
      try {
        const value = (await orca.secrets.get(key.secretKey)) ?? null
        if (value) secretsCache.set(key.secretKey, parseCachedSecret(key.secretKey, value))
      } catch {
        /* unreadable store: leave the slot empty, requests fall back to the caller's key */
      }
    }
  }
  for (const key of config?.clientKeys ?? []) {
    try {
      const value = (await orca.secrets.get(key.secretKey)) ?? null
      if (value) secretsCache.set(key.secretKey, parseCachedSecret(key.secretKey, value))
    } catch {
      /* as above */
    }
  }
}

// Provider-reported quota is fetched per credential, not per provider: a plan
// key can have its own rolling window. The cache keeps the 5-second panel poll
// from hammering usage endpoints; each key is refreshed at most once a minute.
async function providerKeyUsage(provider, { force = false } = {}) {
  const usageFetch = resolveUsageFetch(provider)
  const connectors = usageFetch?.enabled === false ? [] : (usageFetch?.connectors ?? [])
  if (!connectors.length) return { provider: provider.name, keys: [], reason: 'no-endpoint' }
  const pool = (provider.keys ?? []).filter((key) => key.secretKey)
  if (!pool.length) return { provider: provider.name, keys: [], reason: 'no-keys' }
  const meteredProvider = usageFetch === provider.usageFetch ? provider : { ...provider, usageFetch }
  const now = Date.now()
  if (keyUsageCache.size > 1000) {
    for (const [id, entry] of keyUsageCache) if (now - entry.at > KEY_USAGE_TTL_MS) keyUsageCache.delete(id)
  }
  const keys = await Promise.all(pool.map(async (key) => {
    const cacheKey = `${provider.name}\u0000${key.secretKey}`
    const cached = keyUsageCache.get(cacheKey)
    if (!force && cached && now - cached.at < KEY_USAGE_TTL_MS) return cached.value
    let value
    try {
      const result = await fetchProviderUsage(meteredProvider, {
        getSecret: (secretKey) => secretsCache.get(secretKey) ?? null,
        secretKey: key.secretKey
      })
      value = {
        id: key.id,
        secretKey: key.secretKey,
        enabled: key.enabled !== false,
        status: result.status,
        meters: result.meters,
        errors: result.errors,
        fetchedAt: now
      }
    } catch (error) {
      value = {
        id: key.id,
        secretKey: key.secretKey,
        enabled: key.enabled !== false,
        status: 'error',
        meters: [],
        errors: [{ message: String(error?.message ?? error) }],
        fetchedAt: now
      }
    }
    keyUsageCache.set(cacheKey, { at: now, value })
    return value
  }))
  return { provider: provider.name, keys }
}

function normalizeUsageMeter(meter, index) {
  if (!meter || typeof meter !== 'object') return null
  const mapped = {
    id: String(meter.id ?? `meter-${index + 1}`),
    kind: meter.kind === 'quota' ? 'quota' : 'balance',
    label: String(meter.label ?? meter.id ?? 'Usage'),
    ...(meter.limit != null ? { limit: meter.limit } : {}),
    ...(meter.used != null ? { used: meter.used } : {}),
    ...(meter.remaining != null ? { remaining: meter.remaining } : {}),
    ...(meter.unit != null ? { unit: String(meter.unit) } : {}),
    ...(meter.window != null ? { window: String(meter.window) } : {}),
    ...(meter.resetAt != null ? { resetAt: String(meter.resetAt) } : {})
  }
  if (mapped.limit == null && mapped.used == null && mapped.remaining == null) return null
  return mapped
}

// Panel saves only: accept the connector shape the panel builds, trim it, and
// drop anything the usage reader cannot use.
function normalizeUsageFetchInput(value) {
  if (!value || typeof value !== 'object') return undefined
  const connectors = (Array.isArray(value.connectors) ? value.connectors : [])
    .map((connector, index) => {
      const endpoint = String(connector?.endpoint ?? '').trim()
      if (!/^https?:\/\//i.test(endpoint)) return null
      const meters = (Array.isArray(connector?.mapping?.meters) ? connector.mapping.meters : [])
        .map((meter, meterIndex) => normalizeUsageMeter(meter, meterIndex))
        .filter(Boolean)
      if (!meters.length) return null
      return {
        id: String(connector.id ?? `connector-${index + 1}`),
        type: connector.type ?? 'http-json',
        endpoint,
        auth: connector.auth === 'none' ? 'none' : 'provider-api-key',
        method: connector.method ?? 'GET',
        ...(connector.headers && typeof connector.headers === 'object' ? { headers: connector.headers } : {}),
        ...(connector.body != null ? { body: connector.body } : {}),
        mapping: { meters }
      }
    })
    .filter(Boolean)
  if (!connectors.length) return undefined
  return { enabled: value.enabled !== false, connectors }
}

async function refreshSettings(orca) {
  const wasGlobal = settings.enabled && settings.routeOutsideOrca
  try {
    const live = await orca.settings.get()
    if (live && typeof live === 'object') {
      settings = {
        enabled: live.enabled ?? true,
        routeOutsideOrca: live.routeOutsideOrca === true,
        port: live.port ?? 18080,
        bindHost: live.bindHost ?? '127.0.0.1',
        timeoutMs: live.timeoutMs ?? 600000,
        retries: live.retries ?? 2,
        baseDelayMs: live.baseDelayMs ?? 200
      }
    }
  } catch {
    /* keep cache: hook must stay synchronous */
  }
  // Turning either switch off removes the global blocks; turning both on
  // publishes them again. Orca-launched agents are unaffected either way.
  if (wasGlobal !== (settings.enabled && settings.routeOutsideOrca)) {
    await syncGlobalAgentConfig(orca, config).catch(() => {})
  }
}

function effectiveConfig() {
  return {
    ...config,
    port: settings.port,
    bindHost: settings.bindHost,
    timeoutMs: settings.timeoutMs,
    retries: settings.retries,
    baseDelayMs: settings.baseDelayMs
  }
}

async function announce(orca, running, port) {
  await hostCall(orca, 'statusBar.update', {
    id: STATUS_BAR_ID,
    text: running ? `router:${port}` : 'router:off',
    tone: running ? 'success' : 'warning',
    icon: 'zap'
  })
}

function gatewayAddress() {
  const host = boundAddress?.host ?? settings.bindHost
  const port = boundAddress?.port ?? settings.port
  return `http://${host}:${port}`
}

async function ensureRunning(orca) {
  if (sidecar?.status().running) {
    await syncGlobalAgentConfig(orca, config)
    return
  }
  try {
    boundAddress = await sidecar.start(settings.bindHost, settings.port)
    await announce(orca, true, boundAddress.port)
    await syncGlobalAgentConfig(orca, config)
  } catch (error) {
    // The sidecar is down, so the global writes must not be left behind.
    await syncGlobalAgentConfig(orca, config).catch(() => {})
    await hostCall(orca, 'notifications.show', {
      title: 'Orca LLM Router',
      body: `Sidecar failed to start: ${error?.message ?? error}`
    })
  }
}

async function stopSidecar(orca) {
  await sidecar?.stop?.().catch(() => {})
  boundAddress = null
  // The sidecar is stopped now, so this always takes the restore path.
  await syncGlobalAgentConfig(orca, config)
  await announce(orca, false, settings.port)
}

function validateConfig(next) {
  if (!Array.isArray(next?.providers)) return 'providers must be an array'
  for (const provider of next.providers) {
    if (!provider?.name) return 'each provider needs a name'
    if (!provider.baseUrl && !provider.endpoints?.length) return `provider ${provider.name} needs a baseUrl`
  }
  if (!Array.isArray(next?.routes)) return 'routes must be an array'
  if (!Array.isArray(next?.policies)) return 'policies must be an array'
  if (!Array.isArray(next?.clientKeys)) return 'clientKeys must be an array'
  if (!Array.isArray(next?.agentProfiles)) return 'agentProfiles must be an array'
  if (next.aliases && typeof next.aliases !== 'object') return 'aliases must be an object'
  return null
}

async function mergeSecretsIntoConfig(next, previous, preserveMissingKeys = true) {
  // Panel saves carry no secret values; keep the stored key pools when the
  // incoming entry omits them so saving routes never drops keys. Intentional
  // removals (the key handlers) clear the pool explicitly, so they opt out.
  for (const provider of next.providers) {
    const prior = previous.providers.find((item) => item.name === provider.name)
    if (preserveMissingKeys && (!provider.keys || provider.keys.length === 0) && prior?.keys?.length) {
      provider.keys = prior.keys
    }
    provider.keys = provider.keys ?? []
  }
  const priorClientKeys = previous.clientKeys ?? []
  for (const key of next.clientKeys) {
    if (!key.secretKey) {
      const priorKey = priorClientKeys.find((item) => item.id === key.id)
      key.secretKey = priorKey?.secretKey
    }
  }
}

// Report chains that were just converted into routes. The panel shows
// the same entries from config.migration; this keeps the worker log useful
// when a config arrives through import or an older build.
function logMigrationSummary(previous, next) {
  const key = (entry) => `${entry.kind}:${entry.from}:${entry.to}`
  const before = new Set((previous?.migration ?? []).map(key))
  for (const entry of next?.migration ?? []) {
    if (before.has(key(entry))) continue
    console.info(
      `[llm-router] migrated ${entry.kind} '${entry.from}' to route '${entry.to}'` +
      ` (${entry.targets?.length ?? 0} target(s))${entry.note ? `: ${entry.note}` : ''}`
    )
  }
}

async function persistConfig(orca, next, options = {}) {
  const previous = config
  const normalized = normalizeConfig(next)
  await mergeSecretsIntoConfig(normalized, config, options.preserveMissingKeys !== false)
  // Key pools may have been restored above; derive the provider flag from them
  // so a keyed provider is on exactly when one of its keys is on.
  config = jsonSafe(normalizeConfig(normalized))
  logMigrationSummary(previous, config)
  await orca.storage.set(CONFIG_KEY, config)
  await refreshSecrets(orca)
  // When opted in, keep a plain terminal's Codex/OpenCode config in sync with
  // provider and key changes made in the panel. Otherwise this clears any
  // stale global block left by an older version.
  await syncGlobalAgentConfig(orca, config)
  return config
}

// Serialize runtime snapshots so a slow write cannot be overwritten by a newer
// one landing out of order. Storage failures are swallowed: usage tracking is
// best-effort and must never break routing or panel requests.
function persistRuntime(orca, snapshot) {
  runtimeWrite = runtimeWrite
    .then(() => orca.storage.set(RUNTIME_KEY, snapshot))
    .catch(() => {})
  return runtimeWrite
}

// --- Persisted request logs -------------------------------------------------
// These are opt-in and separate from the runtime snapshot: only sanitized
// entries reach storage, so captured bodies/headers are never persisted.
function persistSavedLogs() {
  if (!activeOrca) return
  logsDirty = false
  lastLogPersistAt = Date.now()
  logWrite = logWrite
    .then(() => activeOrca.storage.set(LOGS_KEY, persistedLogs))
    .catch(() => {})
  return logWrite
}

function markSavedLogsDirty() {
  if (config?.persistLogs !== true || !activeOrca) return
  logsDirty = true
  if (Date.now() - lastLogPersistAt >= LOGS_PERSIST_THROTTLE_MS) {
    persistSavedLogs()
    return
  }
  if (logFlushTimer == null && typeof setTimeout === 'function') {
    logFlushTimer = setTimeout(() => {
      logFlushTimer = null
      if (logsDirty) persistSavedLogs()
    }, LOGS_PERSIST_THROTTLE_MS)
    logFlushTimer.unref?.()
  }
}

function rememberLog(entry) {
  if (config?.persistLogs !== true) return
  const safe = panelLogEntry(entry)
  if (!safe) return
  persistedLogs.push(safe)
  if (persistedLogs.length > MAX_PERSISTED_LOGS) {
    persistedLogs.splice(0, persistedLogs.length - MAX_PERSISTED_LOGS)
  }
  markSavedLogsDirty()
}

function clearSavedLogs() {
  persistedLogs = []
  logsDirty = false
  if (logFlushTimer != null) {
    clearTimeout(logFlushTimer)
    logFlushTimer = null
  }
  persistSavedLogs()
}

/** @type {import('orca/worker').Activate} */
export default async function activate(orca) {
  activeOrca = orca
  const stored = await storageGet(orca, CONFIG_KEY)
  const storedRuntime = await storageGet(orca, RUNTIME_KEY)
  // Never replace what the store holds just because a read failed: a transient
  // error at activation used to overwrite an imported config with the default.
  if (stored.ok && stored.value && (stored.value.providers || stored.value.upstreams)) {
    config = jsonSafe(normalizeConfig(stored.value))
  } else {
    config = jsonSafe(normalizeConfig(structuredClone(DEFAULT_CONFIG)))
  }
  logMigrationSummary(stored.ok ? stored.value : null, config)
  if (stored.ok) await orca.storage.set(CONFIG_KEY, config).catch(() => {})
  await refreshSettings(orca)
  await refreshSecrets(orca)

  // Older versions added a web-chat provider as soon as "Add provider" was
  // pressed, even with no credentials. Drop those orphans so the provider list
  // only contains web accounts that actually have a verified secret.
  {
    const kept = config.providers.filter((provider) => {
      if (!isWebChatTransport(provider)) return true
      const key = (provider.keys ?? []).find((k) => k.enabled !== false) ?? (provider.keys ?? [])[0]
      const secretKey = key?.secretKey || `webchat:${provider.transport}:auth`
      return webchatConfigured(provider, secretsCache.get(secretKey))
    })
    if (kept.length !== config.providers.length) {
      config = jsonSafe(normalizeConfig({ ...config, providers: kept }))
      await orca.storage.set(CONFIG_KEY, config).catch(() => {})
    }
  }

  // Restore previously saved logs only when the toggle is on. Storage entries
  // were already sanitized on the way out, but filter defensively on the way in.
  persistedLogs = []
  if (config.persistLogs === true) {
    const storedLogs = await storageGet(orca, LOGS_KEY)
    if (storedLogs.ok && Array.isArray(storedLogs.value)) {
      persistedLogs = storedLogs.value
        .filter((entry) => entry && typeof entry.at === 'number' && Number.isFinite(entry.status))
        .slice(-MAX_PERSISTED_LOGS)
        .map((entry) => panelLogEntry(entry))
        .filter(Boolean)
    }
  }

  sidecar = createSidecar({
    getConfig: effectiveConfig,
    getSecret: (secretKey) => secretsCache.get(secretKey) ?? null,
    initialState: storedRuntime.ok ? storedRuntime.value : null,
    persistState: (snapshot) => persistRuntime(orca, snapshot),
    onLog: (entry) => {
      try {
        const sanitized = panelLogEntry(entry)
        if (sanitized) orca.panels.post('router.log', { entry: sanitized })
      } catch {
        /* no panel open */
      }
      rememberLog(entry)
    }
  })
  // A periodic flush catches the tail of a burst; deactivate() flushes the
  // final state. The sidecar throttles on-change writes in between.
  if (runtimeFlushTimer == null && typeof setInterval === 'function') {
    runtimeFlushTimer = setInterval(() => sidecar?.flushRuntime?.(), RUNTIME_FLUSH_INTERVAL_MS)
    runtimeFlushTimer.unref?.()
  }

  if (settings.enabled) await ensureRunning(orca)
  else await announce(orca, false, settings.port)
  // A previous run or an older version may have left the global Codex block
  // or OpenCode provider behind. With the opt-in off this clears them; with it
  // on the current provider/catalog is (re)published.
  await syncGlobalAgentConfig(orca, config).catch(() => {})

  // --- panel requests ---
  orca.panels.handle('router.status', async () => {
    await refreshSettings(orca)
    const status = sidecar.status()
    const source = config?.persistLogs === true ? persistedLogs : (sidecar.logs || [])
    let logs = source.slice(-50).map(panelLogEntry).filter(Boolean)
    let payload = jsonSafe({ ...status, agents: agentRoutes(), logs })
    let serialized = JSON.stringify(payload)
    if (serialized.length > 750_000) {
      logs = logs.slice(-20)
      payload = jsonSafe({ ...status, agents: agentRoutes(), logs })
      serialized = JSON.stringify(payload)
      if (serialized.length > 750_000) {
        payload = jsonSafe({ ...status, agents: agentRoutes(), logs: [] })
      }
    }
    return payload
  })
  orca.panels.handle('router.start', async () => {
    await refreshSettings(orca)
    await ensureRunning(orca)
    return { running: sidecar.status().running, port: sidecar.status().port }
  })
  orca.panels.handle('router.stop', async () => {
    await stopSidecar(orca)
    return { running: false }
  })
  orca.panels.handle('router.restart', async () => {
    await stopSidecar(orca)
    await refreshSettings(orca)
    await ensureRunning(orca)
    return { running: sidecar.status().running, port: sidecar.status().port }
  })
  orca.panels.handle('router.test', async () => testProviders())
  orca.panels.handle('router.testProvider', async ({ provider: name }) => testProviders(name))
  orca.panels.handle('router.webchat.setup', async ({ transport }) => {
    if (!authTransportFor(transport).transport) throw new Error(`unknown web-chat transport: ${transport}`)
    const existing = config.providers.find((item) => item.transport === transport)
    if (existing) return { ok: true, provider: existing.name, created: false, secretKey: webchatSecretKey(existing) }
    const secretKey = `webchat:${transport}:auth`
    const provider = providerFromPreset(transport, { apiKeySecretKey: secretKey })
    if (!provider) throw new Error(`unknown web-chat preset: ${transport}`)
    const next = structuredClone(config)
    next.providers.push(provider)
    await persistConfig(orca, next)
    return { ok: true, provider: provider.name, created: true, secretKey }
  })
  orca.panels.handle('router.webchat.resetSession', async ({ provider, affinityKey, keyIdentity: kid, all }) => {
    const target = config.providers.find((item) => item.name === provider)
    const transport = target?.transport || 'deepseek-web'
    if (all) {
      const removed = typeof sidecar?.resetWebChatSessionsByTransport === 'function'
        ? sidecar.resetWebChatSessionsByTransport(transport) : 0
      return { ok: true, removed, key: `webchat:${transport}:*` }
    }
    const key = `webchat:${transport}:${affinityKey || 'anon'}:${kid || ''}`
    const removed = typeof sidecar?.resetWebChatSession === 'function' ? sidecar.resetWebChatSession(key) : false
    return { ok: true, removed, key }
  })
  orca.panels.handle('router.webchat.sessions', async () => {
    const list = typeof sidecar?.webchatSessions?.list === 'function' ? sidecar.webchatSessions.list() : []
    return { ok: true, sessions: list }
  })
  // --- web-chat auth: native Chrome/CDP login capture + paste fallback -------
  const authProfilesRoot = () => join(tmpdir(), 'orca-router-webchat')
  const authTransportFor = (name) => {
    const target = config.providers.find((item) => item.name === name)
    const transport = target?.transport || (name && isWebChatTransport({ transport: name }) ? name : null)
    return { target, transport }
  }
  const webchatSecretKey = (target) => {
    const key = (target?.keys ?? []).find((k) => k.enabled !== false) ?? (target?.keys ?? [])[0]
    return key?.secretKey || `webchat:${target?.transport || 'deepseek-web'}:auth`
  }
  const closeAuthBrowser = async (session) => {
    if (!session) return
    // Always drop the page CDP connection; it holds the header event buffer.
    try { session.cdp?.close?.() } catch { /* noop */ }
    session.cdp = null
    if (session.mode === 'attach' || !session.port) return
    try {
      const version = await devtoolsReady(session.port)
      if (version && version.webSocketDebuggerUrl) {
        const browser = new CDPClient(version.webSocketDebuggerUrl)
        await browser.ready()
        try { await browser.send('Browser.close') } catch { /* already closed */ }
        await new Promise((r) => setTimeout(r, 800))
        browser.close()
      }
    } catch { /* noop */ }
    if (session.profileDir) removeProfileSafely(session.profileDir)
  }
  const ensureWebChatKey = async (name, secretKey) => {
    const next = structuredClone(config)
    const t = next.providers.find((item) => item.name === name)
    if (!t) return
    t.keys = t.keys ?? []
    if (!t.keys.some((k) => k.secretKey === secretKey)) {
      t.keys.push({ id: 'auth', secretKey, enabled: true })
      await persistConfig(orca, next)
    }
  }
  // A web-chat provider is created only AFTER its credentials were captured and
  // verified with a real upstream call — never just because "Add provider" was
  // pressed. The preset supplies the model catalog; the key points to the vault.
  const ensureWebChatProvider = async (transport, secretKey) => {
    const existing = config.providers.find((item) => item.transport === transport)
    if (existing) return existing.name
    const provider = providerFromPreset(transport, { apiKeySecretKey: secretKey })
    if (!provider) return null
    const next = structuredClone(config)
    next.providers.push(provider)
    await persistConfig(orca, next)
    return provider.name
  }
  const summarizeAuth = (auth) => ({
    token: auth.token ? `OK (${auth.token.length} chars)` : 'MISSING',
    cookie: auth.cookie ? `OK (${auth.cookiesCount ?? '?'} cookies)` : 'MISSING',
    hif: (auth.hif_dliq || auth.hif_leim) ? 'captured' : 'optional',
    bx: (auth.bx_umidtoken || auth.bx_ua || auth.bx_v) ? 'captured' : 'optional',
  })

  orca.panels.handle('router.webchat.auth.start', async ({ provider: name, port }) => {
    const { target, transport } = authTransportFor(name)
    if (!transport) throw new Error(`not a web-chat provider: ${name}`)
    const prior = authSessions.get(transport)
    if (prior) { await closeAuthBrowser(prior).catch(() => {}); authSessions.delete(transport) }
    // Starting a new login invalidates any previously stored session — clear it
    // so the UI cannot show "Connected" from stale credentials captured before
    // the user actually signed in. Auto-capture restores it after a real login.
    // Keep any existing credentials until the new ones are captured AND
    // verified — a failed reconnect must not leave the account disconnected.
    const started = await startAuthBrowser(transport, {
      attachPorts: port ? [Number(port)] : [],
      profileRoot: authProfilesRoot(),
    })
    // Attach the CDP session NOW, before the user logs in and sends the test
    // message. Network headers (bx-*, x-hif-*) must be observed at that moment;
    // connecting only at capture time would miss them entirely.
    const url = AUTH_PROVIDERS[transport].url
    const { cdp } = await connectPageTarget(started.port, url)
    authSessions.set(transport, { ...started, provider: name, cdp, startedAt: Date.now() })
    return { ok: true, ...started, secretKey: webchatSecretKey(target) }
  })

  orca.panels.handle('router.webchat.auth.status', async ({ provider: name }) => {
    const { target, transport } = authTransportFor(name)
    const session = transport ? authSessions.get(transport) : null
    const secretKey = target ? webchatSecretKey(target) : ''
    const creds = secretsCache.get(secretKey)
    const configured = Boolean(target && webchatConfigured(target, creds))
    const parsed = typeof creds === 'string' ? (() => { try { return JSON.parse(creds) } catch { return null } })() : creds
    const headersCaptured = transport === 'qwen-web'
      ? Boolean(parsed?.bx_umidtoken || parsed?.bx_ua || parsed?.bx_v)
      : Boolean(parsed?.hif_dliq || parsed?.hif_leim)
    return {
      ok: true,
      configured,
      secretKey,
      headersCaptured,
      session: session ? { mode: session.mode, port: session.port, startedAt: session.startedAt } : null,
    }
  })

  orca.panels.handle('router.webchat.auth.capture', async ({ provider: name, secretKey, silent, attempts }) => {
    const { target, transport } = authTransportFor(name)
    if (!transport) throw new Error(`not a web-chat provider: ${name}`)
    const session = authSessions.get(transport)
    if (!session) throw new Error('no web-chat login session; start the login first')
    const url = AUTH_PROVIDERS[transport].url
    // Reuse the CDP connection opened at start so headers captured while the
    // user sent the test message are still available. For silent polling we
    // leave it open so later attempts see the same accumulated header buffer.
    let cdp = session.cdp
    if (!cdp) {
      ({ cdp } = await connectPageTarget(session.port, url))
      session.cdp = cdp
    }
    const { ok, auth } = await captureAuth(transport, {
      port: session.port,
      url,
      cdp,
      attempts: Number.isFinite(attempts) ? Math.max(1, Math.min(attempts, 20)) : 20,
      close: !silent,
      // Automatic capture must prove the user actually logged in; a manual
      // Capture credentials click is an explicit override.
      requireLiveSession: Boolean(silent),
    })
    const sk = secretKey || webchatSecretKey(target)
    if (!ok || !auth) {
      if (silent) return { ok: false, secretKey: sk, summary: null }
      // A failed capture must not leave the closed/dead CDP object cached —
      // the next click reconnects to the still-open browser instead.
      cdp.close()
      session.cdp = null
      throw new Error(`no credentials captured. Log in to ${url} in the opened Chrome window, send one short message (e.g. "ok"), then capture again.`)
    }
    // Only accept credentials that actually work: make a real upstream call
    // with them before saving anything or adding the provider to the config.
    // Silent capture is polled every 2.5s while the browser stays open; the
    // Qwen probe creates a remote chat, so re-verifying on every poll would
    // leave an orphan chat behind each time. Throttle silent re-verification.
    const probeDue = !silent || Date.now() - (session.lastProbeAt ?? 0) >= 60_000
    const probe = probeDue ? await probeWebChat(transport, auth) : { ok: true, message: 'verified' }
    if (probeDue) session.lastProbeAt = Date.now()
    if (!probe.ok) {
      if (silent) return { ok: false, secretKey: sk, summary: null, reason: 'verification_failed', message: probe.message }
      cdp.close()
      session.cdp = null
      throw new Error(`Credentials were captured but could not be verified: ${probe.message}`)
    }
    await orca.secrets.set(sk, JSON.stringify(auth))
    secretsCache.set(sk, auth)
    await ensureWebChatProvider(transport, sk)
    if (target) await ensureWebChatKey(name, sk)
    if (!silent) {
      // An explicit capture means "I'm done" — close the browser and session.
      await closeAuthBrowser(session).catch(() => {})
      authSessions.delete(transport)
    }
    // Silent (automatic) capture only refreshes the stored credentials: leave
    // the window and CDP session alive so the person can finish logging in or
    // send their test message, and later polls can pick up rotated headers.
    return { ok: true, secretKey: sk, summary: summarizeAuth(auth), verified: true }
  })

  orca.panels.handle('router.webchat.auth.cancel', async ({ provider: name }) => {
    const { transport } = authTransportFor(name)
    const session = transport ? authSessions.get(transport) : null
    if (session) { await closeAuthBrowser(session).catch(() => {}); authSessions.delete(transport) }
    return { ok: true }
  })

  orca.panels.handle('router.webchat.auth.paste', async ({ provider: name, json, secretKey }) => {
    const { target, transport } = authTransportFor(name)
    if (!transport) throw new Error(`not a web-chat provider: ${name}`)
    let parsed
    try { parsed = typeof json === 'string' ? JSON.parse(json) : json } catch { parsed = null }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('credentials must be a JSON object')
    const creds = transport === 'deepseek-web' ? normalizeDeepSeekCred(parsed) : normalizeQwenCred(parsed)
    if (!creds.token) throw new Error('credentials contain no token (look for "token", "access_token" or "userToken")')
    const probe = await probeWebChat(transport, creds)
    if (!probe.ok) throw new Error(`credentials could not be verified: ${probe.message}`)
    const sk = secretKey || webchatSecretKey(target)
    await orca.secrets.set(sk, JSON.stringify(creds))
    secretsCache.set(sk, creds)
    await ensureWebChatProvider(transport, sk)
    if (target) await ensureWebChatKey(name, sk)
    return { ok: true, secretKey: sk, verified: true, summary: summarizeAuth({ ...creds, cookiesCount: creds.cookie ? 1 : 0 }) }
  })

  orca.panels.handle('router.clearLogs', async () => {
    if (typeof sidecar?.clearLogs === 'function') sidecar.clearLogs()
    else sidecar.logs.length = 0
    clearSavedLogs()
    return { ok: true }
  })
  orca.panels.handle('router.usage', async ({ window }) => sidecar.usage({ window: window ?? 'today' }))
  orca.panels.handle('router.presets', async () => ({
    // Web-chat presets are configured from the dedicated Web Chat tab, not the
    // generic preset picker (they have no base URL and need browser login).
    presets: PROVIDER_PRESETS.filter((preset) => !preset.transport)
  }))
  orca.panels.handle('router.config.get', async () => jsonSafe({ config }))
  orca.panels.handle('router.config.save', async ({ config: next }) => {
    const problem = validateConfig(next)
    if (problem) {
      const error = new Error(problem)
      error.code = 'invalid_params'
      throw error
    }
    const wasPersisting = config?.persistLogs === true
    await persistConfig(orca, next)
    if (config.persistLogs === true && !wasPersisting) {
      // Seed from the live buffer so enabling the toggle is immediate.
      persistedLogs = (sidecar?.logs ?? []).slice(-MAX_PERSISTED_LOGS)
        .map(panelLogEntry).filter(Boolean)
      logsDirty = true
      persistSavedLogs()
    } else if (config.persistLogs !== true && wasPersisting) {
      clearSavedLogs()
    }
    return { ok: true }
  })
  orca.panels.handle('router.config.export', async () => {
    const text = JSON.stringify(config, null, 2)
    const file = join(tmpdir(), 'llm-router-config.json')
    try { writeFileSync(file, text) } catch { /* non-fatal */ }
    return jsonSafe({ config, json: text, file })
  })
  orca.panels.handle('router.config.detectLocal', async () => {
    const detected = detectLocalRouterConfigs()
    return jsonSafe(detected)
  })
  orca.panels.handle('router.config.importLocal', async ({ source, path, merge = true, encryptionKey }) => {
    let converted
    try {
      if (source === 'both') {
        const detected = detectLocalRouterConfigs()
        if (!detected.ccr && !detected.omniroute) {
          throw new Error('Neither Claude Code Router nor OmniRoute installation was found')
        }
        const ccrTarget = detected.ccr?.path
        const omniTarget = detected.omniroute?.path
        const ccrResult = ccrTarget ? detectAndConvertConfig(ccrTarget) : null
        const omniResult = omniTarget ? detectAndConvertConfig(omniTarget, { encryptionKey }) : null
        if (ccrResult && omniResult) {
          const merged = mergeRouterConfigs(ccrResult.config, omniResult.config, ccrResult.secrets, omniResult.secrets)
          converted = { type: 'both', config: merged.config, secrets: merged.secrets }
        } else {
          converted = ccrResult || omniResult
        }
      } else if (source === 'ccr') {
        const detected = detectLocalRouterConfigs()
        const target = path || detected.ccr?.path
        if (!target) throw new Error('Claude Code Router installation not found')
        converted = detectAndConvertConfig(target)
      } else if (source === 'omni') {
        const detected = detectLocalRouterConfigs()
        const target = path || detected.omniroute?.path
        if (!target) throw new Error('OmniRoute installation not found')
        converted = detectAndConvertConfig(target, { encryptionKey })
      } else {
        throw new Error(`Unknown source: ${source}`)
      }
    } catch (error) {
      const failure = new Error(`Import failed: ${error?.message ?? error}`)
      failure.code = 'invalid_params'
      throw failure
    }

    for (const entry of converted.secrets) {
      try { await orca.secrets.set(entry.secretKey, entry.value) } catch { /* ignore */ }
    }

    let targetConfig = converted.config
    if (merge && config?.providers?.length) {
      const merged = mergeRouterConfigs(config, converted.config)
      targetConfig = merged.config
    }

    const problem = validateConfig(targetConfig)
    if (problem) {
      const failure = new Error(problem)
      failure.code = 'invalid_params'
      throw failure
    }

    await persistConfig(orca, targetConfig)
    await refreshSecrets(orca)
    return {
      ok: true,
      importedFrom: converted.type,
      providers: targetConfig.providers.length,
      aliases: Object.keys(targetConfig.aliases || {}).length,
      merged: Boolean(merge && config?.providers?.length)
    }
  })
  orca.panels.handle('router.config.import', async ({ json, path, merge = false, encryptionKey }) => {
    let converted
    try {
      if (path) {
        converted = detectAndConvertConfig(path, { encryptionKey })
      } else if (json) {
        converted = detectAndConvertConfig(json, { encryptionKey })
      } else {
        const failure = new Error('No JSON content or file path provided')
        failure.code = 'invalid_params'
        throw failure
      }
    } catch (error) {
      const failure = new Error(`Import failed: ${error?.message ?? error}`)
      failure.code = 'invalid_params'
      throw failure
    }
    for (const entry of converted.secrets) {
      try { await orca.secrets.set(entry.secretKey, entry.value) } catch { /* ignore */ }
    }

    let targetConfig = converted.config
    if (merge && config?.providers?.length) {
      const merged = mergeRouterConfigs(config, converted.config)
      targetConfig = merged.config
    }

    const problem = validateConfig(targetConfig)
    if (problem) {
      const failure = new Error(problem)
      failure.code = 'invalid_params'
      throw failure
    }
    await persistConfig(orca, targetConfig)
    await refreshSecrets(orca)
    return {
      ok: true,
      importedFrom: converted.type,
      providers: targetConfig.providers.length,
      aliases: Object.keys(targetConfig.aliases || {}).length,
      merged: Boolean(merge && config?.providers?.length)
    }
  })
  orca.panels.handle('router.provider.addPreset', async ({ presetId, name, secretKey, value }) => {
    const provider = providerFromPreset(presetId, { name, apiKeySecretKey: secretKey })
    if (!provider) {
      const error = new Error(`unknown preset: ${presetId}`)
      error.code = 'invalid_params'
      throw error
    }
    if (config.providers.some((item) => item.name === provider.name)) {
      const error = new Error(`provider already exists: ${provider.name}`)
      error.code = 'conflict'
      throw error
    }
    if (secretKey && value) {
      await orca.secrets.set(secretKey, value)
    }
    const next = structuredClone(config)
    next.providers.push(provider)
    await persistConfig(orca, next)
    return { ok: true, provider: provider.name }
  })
  orca.panels.handle('router.key.add', async ({ provider: name, secretKey, id, value, priority, weight, limits }) => {
    if (!secretKey) {
      const error = new Error('a key needs a secret name')
      error.code = 'invalid_params'
      throw error
    }
    if (!value) {
      const error = new Error('empty key value')
      error.code = 'invalid_params'
      throw error
    }
    const provider = config.providers.find((item) => item.name === name)
    if (!provider) {
      const error = new Error(`unknown provider: ${name}`)
      error.code = 'invalid_params'
      throw error
    }
    await orca.secrets.set(secretKey, value)
    const next = structuredClone(config)
    const target = next.providers.find((item) => item.name === name)
    target.keys = target.keys ?? []
    const existing = target.keys.find((item) => item.secretKey === secretKey)
    const metadata = {
      ...(existing ?? { id: id || secretKey, secretKey, enabled: true })
    }
    if (id) metadata.id = id
    if (Number.isFinite(Number(priority))) metadata.priority = Number(priority)
    if (Number.isFinite(Number(weight))) metadata.weight = Number(weight)
    if (limits && typeof limits === 'object' && !Array.isArray(limits)) metadata.limits = limits
    if (existing) Object.assign(existing, metadata)
    else target.keys.push(metadata)
    await persistConfig(orca, next)
    sidecar?.clearKeyCooldown?.(secretKey)
    return { ok: true, id: metadata.id, secretKey }
  })
  orca.panels.handle('router.key.update', async ({ provider: name, secretKey, id, enabled, priority, weight, limits, value }) => {
    const next = structuredClone(config)
    const provider = next.providers.find((item) => item.name === name)
    if (!provider) {
      const error = new Error(`unknown provider: ${name}`)
      error.code = 'invalid_params'
      throw error
    }
    const key = (provider.keys ?? []).find((item) => item.secretKey === secretKey || (id && item.id === id))
    if (!key) {
      const error = new Error(`unknown key: ${secretKey}`)
      error.code = 'invalid_params'
      throw error
    }
    if (typeof enabled === 'boolean') key.enabled = enabled
    if (typeof id === 'string' && id.trim()) key.id = id.trim()
    if (typeof value === 'string' && value.trim()) {
      if (!key.secretKey) {
        const error = new Error('key has no secret name')
        error.code = 'invalid_params'
        throw error
      }
      await orca.secrets.set(key.secretKey, value.trim())
    }
    if (Number.isFinite(Number(priority))) key.priority = Number(priority)
    if (typeof weight !== 'undefined' && Number.isFinite(Number(weight))) key.weight = Number(weight)
    if (limits && typeof limits === 'object' && !Array.isArray(limits)) key.limits = limits
    await persistConfig(orca, next)
    // An explicit edit (re-enable, new limit) should get a fresh try.
    if (key.secretKey) sidecar?.clearKeyCooldown?.(key.secretKey)
    return { ok: true }
  })
  orca.panels.handle('router.key.remove', async ({ provider: name, secretKey, id }) => {
    const next = structuredClone(config)
    const provider = next.providers.find((item) => item.name === name)
    if (!provider) {
      const error = new Error(`unknown provider: ${name}`)
      error.code = 'invalid_params'
      throw error
    }
    const removed = (provider.keys ?? []).filter((item) => item.secretKey === secretKey || (id && item.id === id))
    provider.keys = (provider.keys ?? []).filter((item) => !(item.secretKey === secretKey || (id && item.id === id)))
    for (const key of removed) {
      if (key.secretKey) await orca.secrets.delete(key.secretKey).catch(() => {})
      sidecar?.clearKeyCooldown?.(key.secretKey)
    }
    await persistConfig(orca, next, { preserveMissingKeys: false })
    return { ok: true }
  })
  orca.panels.handle('router.clientKeys.create', async ({ name, expiresAt, limits }) => {
    const id = `key-${Date.now().toString(36)}`
    const secretKey = `clientKeys.${id}`
    const value = `llmr-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
    await orca.secrets.set(secretKey, value)
    const next = structuredClone(config)
    next.clientKeys.push({ id, name: name || 'Client', secretKey, expiresAt, limits: limits ?? {}, enabled: true })
    await persistConfig(orca, next)
    return { ok: true, id, key: value, secretKey }
  })
  orca.panels.handle('router.clientKeys.revoke', async ({ id }) => {
    const next = structuredClone(config)
    next.clientKeys = next.clientKeys.filter((key) => key.id !== id)
    await persistConfig(orca, next)
    return { ok: true }
  })
  orca.panels.handle('router.discoverModels', async ({ provider: name, baseUrl, protocols, secretKey, value }) => {
    // Pull model ids without touching the stored config: the caller uses the
    // list to fill a textarea before saving. A provider name reuses its saved
    // endpoint + enabled key; a bare baseUrl/protocols is used for a form that
    // has not been saved yet.
    const target = name ? config.providers.find((item) => item.name === name) : null
    if (name && !target) throw new Error(`unknown provider: ${name}`)
    // Web-chat transports have no /v1/models endpoint; return the static catalog.
    if (isWebChatTransport(target ?? { transport: null })) {
      return { ok: true, models: webchatCatalog(target).map((m) => m.id), provider: name ?? null }
    }
    const resolvedBaseUrl = String(baseUrl ?? target?.baseUrl ?? target?.endpoints?.[0]?.baseUrl ?? '').trim()
    if (!resolvedBaseUrl) throw new Error('a base URL is required to fetch models')
    const resolvedProtocols = protocols ?? target?.protocols ?? target?.capabilities ?? []
    let key = value
    if (!key && target) {
      const picked = (target.keys ?? []).find((entry) => entry.enabled !== false) ?? (target.keys ?? [])[0]
      if (picked?.secretKey) key = secretsCache.get(picked.secretKey) ?? undefined
      if (secretKey && !key) key = secretsCache.get(secretKey) ?? undefined
    } else if (!key && secretKey) {
      key = secretsCache.get(secretKey) ?? undefined
    }
    const models = await fetchModels({ baseUrl: resolvedBaseUrl, protocols: resolvedProtocols, key })
    return { ok: true, models, provider: name ?? null }
  })
  orca.panels.handle('router.discoverAllModels', async () => {
    // Pull model ids from every configured provider in one pass, so the panel
    // can offer one searchable list across providers. A provider that fails
    // reports its error and contributes no models; the others are unaffected.
    const providers = effectiveConfig().providers ?? []
    const results = await Promise.all(
      providers.map(async (provider) => {
        if (isWebChatTransport(provider)) {
          return { provider: provider.name, models: webchatCatalog(provider).map((m) => m.id) }
        }
        const baseUrl = String(provider.baseUrl ?? provider.endpoints?.[0]?.baseUrl ?? '').trim()
        if (!baseUrl) return { provider: provider.name, models: [], error: 'no base URL' }
        const key = (provider.keys ?? []).map((entry) => secretsCache.get(entry.secretKey)).find(Boolean)
        try {
          const models = await fetchModels({
            baseUrl,
            protocols: provider.protocols ?? provider.capabilities ?? [],
            key
          })
          return { provider: provider.name, models }
        } catch (cause) {
          return { provider: provider.name, models: [], error: String(cause?.message ?? cause) }
        }
      })
    )
    return { ok: true, providers: results }
  })
  orca.panels.handle('router.testUsage', async ({ provider: name, secretKey }) => {
    const provider = config.providers.find((item) => item.name === name)
    if (!provider) throw new Error(`unknown provider: ${name}`)
    const usageFetch = resolveUsageFetch(provider)
    const meteredProvider = usageFetch === provider.usageFetch ? provider : { ...provider, usageFetch }
    return fetchProviderUsage(meteredProvider, { getSecret: (key) => secretsCache.get(key) ?? null, secretKey })
  })
  orca.panels.handle('router.keyUsage', async ({ provider: name, refresh } = {}) => {
    const providers = (config?.providers ?? []).filter((provider) => !name || provider.name === name)
    const results = await Promise.all(providers.map(async (provider) => {
      try {
        return await providerKeyUsage(provider, { force: refresh === true })
      } catch {
        return { provider: provider.name, keys: [], reason: 'error' }
      }
    }))
    return { providers: results }
  })
  orca.panels.handle('router.usageProbe', async ({ provider: name } = {}) => {
    const provider = (config?.providers ?? []).find((item) => item.name === name)
    if (!provider) {
      const error = new Error(`unknown provider: ${name}`)
      error.code = 'invalid_params'
      throw error
    }
    const result = await probeProviderUsage(provider, {
      getSecret: (secretKey) => secretsCache.get(secretKey) ?? null
    })
    return { provider: name, ...result }
  })
  orca.panels.handle('router.provider.usage', async ({ provider: name, usageFetch } = {}) => {
    const next = structuredClone(config)
    const provider = next.providers.find((item) => item.name === name)
    if (!provider) {
      const error = new Error(`unknown provider: ${name}`)
      error.code = 'invalid_params'
      throw error
    }
    const normalized = normalizeUsageFetchInput(usageFetch)
    if (normalized) provider.usageFetch = normalized
    else delete provider.usageFetch
    await persistConfig(orca, next)
    // Drop cached per-key readings so the next click reads the new endpoint.
    for (const id of [...keyUsageCache.keys()]) {
      if (id.startsWith(`${name}\u0000`)) keyUsageCache.delete(id)
    }
    return { ok: true }
  })
  orca.panels.handle('router.vpn.save', async ({ server: input, username, password } = {}) => {
    const existingId = String(input?.id ?? '').trim()
    const existing = (config.vpnServers ?? []).find((item) => item.id === existingId)
    const used = new Set((config.vpnServers ?? []).filter((item) => item.id !== existingId).map((item) => item.id))
    const server = normalizeVpnServer({
      ...input,
      id: existingId || undefined,
      secretKey: existing?.secretKey || undefined
    }, used)
    if (!server) {
      const error = new Error('a VPN server needs a type (HTTP or SOCKS5) and a host')
      error.code = 'invalid_params'
      throw error
    }
    const hasCredentials = typeof username === 'string' && username.trim() !== '' || typeof password === 'string' && password !== ''
    if (hasCredentials) {
      await orca.secrets.set(server.secretKey ?? `vpn.${server.id}`, JSON.stringify({
        username: String(username ?? '').trim(),
        password: String(password ?? '')
      }))
      server.secretKey = server.secretKey ?? `vpn.${server.id}`
    } else if (existing?.secretKey) {
      // Empty credential fields mean "keep what is stored" on edit; removal of
      // the secret happens only with the explicit Remove action.
      server.secretKey = existing.secretKey
    }
    const next = structuredClone(config)
    next.vpnServers = [...(next.vpnServers ?? [])]
    const index = next.vpnServers.findIndex((item) => item.id === server.id)
    if (index >= 0) next.vpnServers[index] = server
    else next.vpnServers.push(server)
    await persistConfig(orca, next)
    return { ok: true, server }
  })
  orca.panels.handle('router.vpn.remove', async ({ id } = {}) => {
    const target = (config.vpnServers ?? []).find((item) => item.id === id)
    if (!target) return { ok: true }
    const next = structuredClone(config)
    next.vpnServers = (next.vpnServers ?? []).filter((item) => item.id !== id)
    // Clearing the last server is an explicit choice: do not re-offer the sample.
    if (!next.vpnServers.length) next.vpnSampleDismissed = true
    for (const route of next.routes ?? []) {
      if (route.vpn === id) delete route.vpn
    }
    await persistConfig(orca, next)
    if (target.secretKey) await orca.secrets.delete(target.secretKey).catch(() => {})
    return { ok: true }
  })

  // --- command palette ---
  orca.commands.register('router.status', async () => {
    await refreshSettings(orca)
    const status = sidecar.status()
    await hostCall(orca, 'notifications.show', {
      title: 'Orca LLM Router',
      body: status.running
        ? `Sidecar on ${status.host}:${status.port} — providers: ${status.providers.map((p) => p.name).join(', ') || 'none'}`
        : 'Sidecar is stopped. Open the Orca LLM Router panel to start it.'
    })
    return { running: status.running, port: status.port }
  })
  orca.commands.register('router.start', async () => {
    await refreshSettings(orca)
    await ensureRunning(orca)
    return { running: sidecar.status().running, port: sidecar.status().port }
  })
  orca.commands.register('router.stop', async () => {
    await stopSidecar(orca)
    return { running: false }
  })
  orca.commands.register('router.restart', async () => {
    await stopSidecar(orca)
    await refreshSettings(orca)
    await ensureRunning(orca)
    return { running: sidecar.status().running, port: sidecar.status().port }
  })
  orca.commands.register('router.test', async () => {
    const { results } = await testProviders()
    const down = results.filter((result) => !result.ok).map((result) => result.provider).join(', ')
    await hostCall(orca, 'notifications.show', {
      title: 'Orca LLM Router',
      body: down ? `Unreachable providers: ${down}` : `All ${results.length} providers reachable`
    })
    return { results }
  })

  // --- the routing hook: every enabled agent launch is pointed at the sidecar ---
  orca.hooks.on('agent.launch.before', (event, next) => {
    // Synchronous by design: settings and config are cached at activate time.
    // A slow host call here would stall every agent launch, so the hook only
    // reads the cache. `enabled` toggles in Settings apply at next router call.
    if (!settings.enabled || !sidecar?.status().running || !boundAddress) {
      return next(event)
    }
    const base = `http://${boundAddress.host}:${boundAddress.port}`
    const { env, model, routed, profile } = buildAgentLaunchEnv(config, event.agent, {
      base,
      token: config.token || 'orca-router',
      eventEnv: event.env ?? {}
    })
    if (routed === false) {
      orca.log(`skip ${event.agent}: disabled in Orca LLM Router`)
      return next(event)
    }
    const agentId = String(event.agent ?? '').toLowerCase()
    // OpenCode ignores OPENAI_BASE_URL and keeps its provider list in config.
    // Publish the gateway + models and, for the v2 CLI, force a private server
    // so the env (and therefore the generated config) is actually read.
    if (agentId === 'opencode' || agentId === 'opencode2') {
      const opencodeConfigPath = writeOpenCodeConfig(config, {
        base,
        token: config.token || 'orca-router',
        agentId
      })
      if (opencodeConfigPath) env.OPENCODE_CONFIG = opencodeConfigPath
    }
    const update = { ...event, env }
    // Codex also reads its provider and model list from on-disk config. The
    // per-launch overrides keep the user's file untouched while making this
    // session use the gateway and show the same model list as OpenCode.
    if (agentId === 'codex') {
      const catalog = writeCodexCatalog(config, { agentId })
      update.command = injectCodexProvider(event.command, {
        base,
        token: config.token || 'orca-router',
        catalogPath: catalog?.path,
        model: catalog?.model ?? model,
        reasoningEffort: profile?.reasoningEffort
      })
    }
    // Claude Code reads ~/.claude/settings.json over the process env, so a
    // stale provider there (for example another router) would win. Pin our env
    // with --settings, which takes CLI precedence but keeps other settings.
    if (agentId === 'claude') {
      const settingsPath = writeClaudeSettings(env)
      if (settingsPath) update.command = injectClaudeSettings(event.command, settingsPath)
    }
    if (agentId === 'opencode' && opencodeSupportsStandalone()) {
      update.command = injectOpenCodeStandalone(event.command)
    }
    orca.log(`route ${event.agent} via ${base}${model ? ` as ${model}` : ''}`)
    return next(update)
  })

  orca.events.on('agent.status.changed', async () => {
    await refreshSettings(orca)
    await announce(orca, sidecar.status().running, sidecar.status().port)
  })
}

// Probe the provider's model list (which validates the credential) and fall
// back to a reachability check when the endpoint is absent. URL joining is
// shared with the gateway so /v1 is never duplicated.
function providerProbe(provider, key) {
  const baseUrl = String(provider.baseUrl ?? provider.endpoints?.[0]?.baseUrl ?? '').replace(/\/+$/, '')
  const protocols = (provider.protocols ?? provider.capabilities ?? []).map(String)
  const onlyGemini = protocols.includes('gemini') && !['openai', 'anthropic', 'responses', 'passthrough'].some((p) => protocols.includes(p))
  if (onlyGemini) {
    return { url: joinUpstreamUrl(baseUrl, '/v1beta/models'), headers: key ? { 'x-goog-api-key': key } : {}, protocol: 'gemini' }
  }
  const onlyAnthropic = protocols.includes('anthropic') && !['openai', 'responses', 'passthrough'].some((p) => protocols.includes(p))
  if (onlyAnthropic) {
    return { url: joinUpstreamUrl(baseUrl, '/v1/models'), headers: { ...(key ? { 'x-api-key': key } : {}), 'anthropic-version': '2023-06-01' }, protocol: 'anthropic' }
  }
  return { url: joinUpstreamUrl(baseUrl, '/v1/models'), headers: key ? { authorization: `Bearer ${key}` } : {}, protocol: 'openai' }
}

// Ask an endpoint for its model list, using the probe that matches its
// protocol. Gemini lists under `models[].name` (strip the `models/` prefix),
// everyone else under `data[].id`. Returns bare model ids.
async function fetchModels({ baseUrl, protocols, key } = {}) {
  const probe = providerProbe({ baseUrl, protocols: protocols ?? [] }, key)
  const res = await fetch(probe.url, { method: 'GET', headers: probe.headers, signal: AbortSignal.timeout(12000) })
  if (res.status === 401 || res.status === 403) {
    throw new Error(res.status === 401 ? 'invalid API key' : 'access forbidden')
  }
  if (!res.ok) throw new Error(`model list returned ${res.status}`)
  const json = await res.json().catch(() => ({}))
  const raw = json.data ?? json.models ?? []
  return [...new Set(
    raw
      .map((model) => String(model?.id ?? model?.name ?? model ?? '').replace(/^models\//, ''))
      .filter(Boolean)
  )].sort()
}

async function testProviders(only) {
  const results = []
  for (const provider of effectiveConfig().providers.filter((item) => !only || item.name === only)) {
    const started = Date.now()
    const key = (provider.keys ?? []).map((entry) => secretsCache.get(entry.secretKey)).find(Boolean)
    // Web-chat transports have no /v1/models endpoint, but we can still probe
    // the actual subscription with a cheap authenticated call. This surfaces
    // expired tokens/cookies as a failed test instead of a false green badge.
    if (isWebChatTransport(provider)) {
      if (!webchatConfigured(provider, key)) {
        results.push({
          provider: provider.name,
          ok: false, status: 401,
          message: 'missing auth secret (run the web-chat login)',
          latencyMs: Date.now() - started,
        })
      } else {
        const probe = await probeWebChat(provider.transport, key)
        results.push({
          provider: provider.name,
          ok: probe.ok,
          status: probe.ok ? 200 : 401,
          message: probe.ok ? undefined : probe.message,
          latencyMs: Date.now() - started,
        })
      }
      continue
    }
    const baseUrl = provider.baseUrl ?? provider.endpoints?.[0]?.baseUrl
    const probe = providerProbe(provider, key)
    try {
      const res = await fetch(probe.url, { method: 'GET', headers: probe.headers, signal: AbortSignal.timeout(8000) })
      if (res.status === 401 || res.status === 403) {
        results.push({ provider: provider.name, ok: false, status: res.status, message: res.status === 401 ? 'invalid API key' : 'access forbidden', latencyMs: Date.now() - started })
        continue
      }
      if (res.status < 400 || res.status === 429) {
        results.push({ provider: provider.name, ok: true, status: res.status, latencyMs: Date.now() - started })
        continue
      }
      // No model-list endpoint (404/405): fall back to a reachability probe.
      const health = await fetch(joinUpstreamUrl(baseUrl, '/health'), { method: 'GET', headers: probe.headers, signal: AbortSignal.timeout(5000) }).catch(() => null)
      if (health) {
        results.push({ provider: provider.name, ok: health.status < 500, status: health.status, latencyMs: Date.now() - started })
      } else {
        results.push({ provider: provider.name, ok: false, status: res.status, latencyMs: Date.now() - started })
      }
    } catch {
      results.push({ provider: provider.name, ok: false, status: null, message: 'no response', latencyMs: Date.now() - started })
    }
  }
  // Feed the same samples real traffic records, so a manual speed test can
  // prime health-aware failover for a provider that has been idle.
  sidecar?.recordProbes?.(results)
  return { results }
}

export async function deactivate() {
  await restoreGlobalAgentConfig(activeOrca)
  // Close any web-chat auth browser and remove its throwaway profiles.
  for (const [, session] of authSessions) {
    try { session?.cdp?.close?.() } catch { /* noop */ }
    if (session && session.mode !== 'attach' && session.port) {
      try {
        const version = await devtoolsReady(session.port)
        if (version && version.webSocketDebuggerUrl) {
          const browser = new CDPClient(version.webSocketDebuggerUrl)
          await browser.ready()
          try { await browser.send('Browser.close') } catch { /* noop */ }
          browser.close()
        }
      } catch { /* noop */ }
      if (session.profileDir) removeProfileSafely(session.profileDir)
    }
  }
  authSessions.clear()
  try { removeProfileSafely(join(tmpdir(), 'orca-router-webchat')) } catch { /* noop */ }
  sidecar?.flushRuntime?.()
  await runtimeWrite.catch(() => {})
  if (logFlushTimer != null) {
    clearTimeout(logFlushTimer)
    logFlushTimer = null
  }
  if (logsDirty) persistSavedLogs()
  await logWrite.catch(() => {})
  if (runtimeFlushTimer != null) {
    clearInterval(runtimeFlushTimer)
    runtimeFlushTimer = null
  }
  await sidecar?.stop?.().catch(() => {})
  boundAddress = null
  activeOrca = null
}
