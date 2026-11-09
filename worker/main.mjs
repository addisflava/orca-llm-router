// Orca LLM Router worker: owns the self-contained local gateway and wires it into Orca.
//
//   agent launch -> agent.launch.before hook rewrites env (ANTHROPIC_BASE_URL,
//                   OPENAI_BASE_URL, auth) and, for Claude Code, adds
//                   `--settings` so on-disk settings cannot override the local
//                   gateway at http://127.0.0.1:18080 (or the configured port).
//                   OpenCode gets a generated OPENCODE_CONFIG so its model
//                   picker lists the gateway's providers and models; Codex gets
//                   a generated model catalog plus per-launch `-c` provider
//                   overrides for terminal launches, and a managed block in
//                   ~/.codex/config.toml while the gateway runs so Orca's
//                   native Codex chat sees the same list.
//   CLI -> sidecar (worker/sidecar.mjs) -> providers in the config, with
//                   conditional routing rules, rewrites, aliases, fallback
//                   chains, retries and per-provider credential pools.
//
// Config lives in storage 'router.config' (seeded from DEFAULT_CONFIG);
// API keys live in secrets:own under the key entries' secretKey names, never
// in storage or logs. Settings (port, host, timeouts, enabled) come from Orca
// Settings via settings:own and are cached so the launch hook never blocks on
// a host round-trip.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  normalizeConfig,
  buildAgentLaunchEnv,
  buildOpenCodeConfig,
  buildCodexModelCatalog,
  mergeOpenCodeConfig,
  agentProfileFor,
  providerFromPreset
} from './sidecar.mjs'
import { ORCA_AGENTS } from './orca-agents.mjs'

const CONFIG_KEY = 'router.config'
const STATUS_BAR_ID = 'router-status'

let sidecar = null
let config = null
let settings = { enabled: true, port: 18080, bindHost: '127.0.0.1', timeoutMs: 600000, retries: 2, baseDelayMs: 200 }
const secretsCache = new Map()
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
    credential: entry.credential ?? null,
    requestModel: entry.requestModel,
    resolvedModel: entry.resolvedModel,
    model: entry.model ?? entry.resolvedModel ?? '',
    protocol: entry.protocol ?? '',
    status: Number(entry.status ?? 0),
    latencyMs: entry.latencyMs ?? null,
    attempts: Array.isArray(entry.attempts) ? entry.attempts.slice(0, 10) : [],
    failures: Array.isArray(entry.failures)
      ? entry.failures.slice(0, 5).map((f) => ({
          provider: f.provider,
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

// Codex reads its provider and model catalog from config. Terminal launches get
// per-launch `-c key=value` overrides, while Orca's native chat starts its own
// `codex app-server` that ignores the launch hook. Native chat reads the user's
// ~/.codex/config.toml directly, so while the router is running we install a
// marker-delimited managed block there and remove it again when the router
// stops or the plugin is deactivated. The user's original values are kept in
// plugin storage so the restore preserves unrelated edits.
const CODEX_CONFIG_MARKER_BEGIN = '# BEGIN Orca LLM Router managed profile'
const CODEX_CONFIG_MARKER_END = '# END Orca LLM Router managed profile'
const CODEX_PROVIDER_MARKER_BEGIN = '# BEGIN Orca LLM Router managed Codex provider'
const CODEX_PROVIDER_MARKER_END = '# END Orca LLM Router managed Codex provider'
const CODEX_MANAGED_TOP_LEVEL = ['model', 'model_provider', 'model_catalog_json', 'model_reasoning_effort']
const CODEX_CONFIG_BACKUP_KEY = 'router.codexConfigBackup'
let lastCodexCatalogJson = null
let activeOrca = null

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

// Remove a marker-delimited managed block, leaving every other line intact.
function stripCodexManagedBlocks(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let skipping = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === CODEX_CONFIG_MARKER_BEGIN || trimmed === CODEX_PROVIDER_MARKER_BEGIN) {
      skipping = true
      continue
    }
    if (skipping) {
      if (trimmed === CODEX_CONFIG_MARKER_END) skipping = false
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
// so the profile block is prepended and the provider table appended.
export function buildCodexManagedConfig(text, { base, token, catalogPath, model, reasoningEffort }) {
  let clean = stripCodexManagedBlocks(text)
  clean = stripTomlTable(clean, 'model_providers.orca-router')
  clean = stripTopLevelKeys(clean, CODEX_MANAGED_TOP_LEVEL)
  clean = clean.replace(/^\n+/, '').replace(/\n+$/, '')
  const effort = ['low', 'medium', 'high'].includes(String(reasoningEffort)) ? String(reasoningEffort) : 'high'
  const baseUrl = `${String(base).replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`
  const profile = [
    CODEX_CONFIG_MARKER_BEGIN,
    `model = ${tomlQuoted(model)}`,
    'model_provider = "orca-router"',
    `model_catalog_json = ${tomlQuoted(catalogPath)}`,
    `model_reasoning_effort = ${tomlQuoted(effort)}`,
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

async function applyCodexGlobal(orca, options) {
  if (!orca || !options?.model || !options?.catalogPath) return null
  const { path, text: current } = readCodexConfigFile()
  const managed = current.includes(CODEX_CONFIG_MARKER_BEGIN) || current.includes('[model_providers.orca-router]')
  const stored = await storageGet(orca, CODEX_CONFIG_BACKUP_KEY)
  const backup = stored.ok ? stored.value : null
  if (!managed) {
    // First apply: remember only the values we replace, so unrelated edits made
    // while the router is active survive the restore.
    await orca.storage.set(CODEX_CONFIG_BACKUP_KEY, {
      path,
      keys: extractTopLevelKeys(current, CODEX_MANAGED_TOP_LEVEL),
      providerTable: extractTomlTable(current, 'model_providers.orca-router'),
      appliedAt: new Date().toISOString()
    }).catch(() => {})
  } else if (!backup || backup.path !== path) {
    // Marker present without a usable backup (for example storage was cleared):
    // restore what we can by stripping our own block.
    await orca.storage.set(CODEX_CONFIG_BACKUP_KEY, {
      path,
      keys: {},
      providerTable: null,
      appliedAt: new Date().toISOString(),
      fallback: true
    }).catch(() => {})
  }
  const next = buildCodexManagedConfig(current, options)
  if (next === current) return path
  writeCodexConfigFile(path, next)
  return path
}

async function restoreCodexGlobal(orca) {
  if (!orca) return false
  const { path, text: current } = readCodexConfigFile()
  const managed = current.includes(CODEX_CONFIG_MARKER_BEGIN) || current.includes('[model_providers.orca-router]')
  if (!managed) {
    await storageDelete(orca, CODEX_CONFIG_BACKUP_KEY)
    return false
  }
  const stored = await storageGet(orca, CODEX_CONFIG_BACKUP_KEY)
  const backup = stored.ok ? stored.value : null
  let next = stripCodexManagedBlocks(current)
  next = stripTomlTable(next, 'model_providers.orca-router')
  next = stripTopLevelKeys(next, CODEX_MANAGED_TOP_LEVEL)
  next = next.replace(/^\n+/, '').replace(/\n+$/, '')
  if (backup && backup.path === path) {
    const keyLines = Object.values(backup.keys ?? {}).filter(Boolean)
    if (keyLines.length) next = `${keyLines.join('\n')}\n\n${next}`
    if (backup.providerTable) next = `${next ? `${next}\n\n` : ''}${backup.providerTable}`
  }
  writeCodexConfigFile(path, next ? `${next}\n` : '')
  await storageDelete(orca, CODEX_CONFIG_BACKUP_KEY)
  return true
}

async function syncCodexGlobal(orca, current) {
  if (!orca) return null
  if (!settings.enabled || !current || !sidecar?.status().running) {
    await restoreCodexGlobal(orca)
    return null
  }
  const catalog = writeCodexCatalog(current, { agentId: 'codex' })
  if (!catalog) return null
  const profile = agentProfileFor(normalizeConfig(current), 'codex')
  return applyCodexGlobal(orca, {
    base: gatewayAddress(),
    token: current.token || 'orca-router',
    catalogPath: catalog.path,
    model: catalog.model,
    reasoningEffort: profile?.reasoningEffort
  })
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
// `-c key=value` is Codex's supported per-launch config override, so a terminal
// launch never needs to rewrite the user's config file. Native chat, which does
// not run this hook, is handled by the managed block above.
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

// A person can also open a plain terminal and type `opencode`; that launch has
// no agent hook to rewrite. OpenCode merges the global config and watches it
// live, so publish the same provider there. The modification is intentionally
// narrow: replace the stale CCR provider with ours and repoint model ids,
// leaving MCP servers, agents, plugins and unrelated providers untouched.
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

async function refreshSecrets(orca) {
  secretsCache.clear()
  for (const provider of config?.providers ?? []) {
    for (const key of provider.keys ?? []) {
      try {
        const value = (await orca.secrets.get(key.secretKey)) ?? null
        if (value) secretsCache.set(key.secretKey, value)
      } catch {
        /* unreadable store: leave the slot empty, requests fall back to the caller's key */
      }
    }
  }
  for (const key of config?.clientKeys ?? []) {
    try {
      const value = (await orca.secrets.get(key.secretKey)) ?? null
      if (value) secretsCache.set(key.secretKey, value)
    } catch {
      /* as above */
    }
  }
}

async function refreshSettings(orca) {
  const wasEnabled = settings.enabled
  try {
    const live = await orca.settings.get()
    if (live && typeof live === 'object') {
      settings = {
        enabled: live.enabled ?? true,
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
  if (wasEnabled !== settings.enabled) await syncCodexGlobal(orca, config).catch(() => {})
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

function syncOpenCodeGlobal(current) {
  if (!settings.enabled || !current || !sidecar?.status().running) return null
  return syncOpenCodeUserConfig(current, {
    base: gatewayAddress(),
    token: current.token || 'orca-router'
  })
}

async function ensureRunning(orca) {
  if (sidecar?.status().running) {
    syncOpenCodeGlobal(config)
    await syncCodexGlobal(orca, config)
    return
  }
  try {
    boundAddress = await sidecar.start(settings.bindHost, settings.port)
    await announce(orca, true, boundAddress.port)
    syncOpenCodeGlobal(config)
    await syncCodexGlobal(orca, config)
  } catch (error) {
    await hostCall(orca, 'notifications.show', {
      title: 'Orca LLM Router',
      body: `Sidecar failed to start: ${error?.message ?? error}`
    })
  }
}

async function stopSidecar(orca) {
  await sidecar?.stop?.().catch(() => {})
  boundAddress = null
  await restoreCodexGlobal(orca).catch(() => {})
  await announce(orca, false, settings.port)
}

function validateConfig(next) {
  if (!Array.isArray(next?.providers)) return 'providers must be an array'
  for (const provider of next.providers) {
    if (!provider?.name) return 'each provider needs a name'
    if (!provider.baseUrl && !provider.endpoints?.length) return `provider ${provider.name} needs a baseUrl`
  }
  if (!Array.isArray(next?.routes)) return 'routes must be an array'
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
  if (!next.clientKeys.length && priorClientKeys.length && next.clientKeys === priorClientKeys) {
    // keep previous keys untouched
    next.clientKeys = priorClientKeys
  }
}

async function persistConfig(orca, next, options = {}) {
  const normalized = normalizeConfig(next)
  await mergeSecretsIntoConfig(normalized, config, options.preserveMissingKeys !== false)
  // Key pools may have been restored above; derive the provider flag from them
  // so a keyed provider is on exactly when one of its keys is on.
  config = jsonSafe(normalizeConfig(normalized))
  await orca.storage.set(CONFIG_KEY, config)
  await refreshSecrets(orca)
  // Keep the model list a plain `opencode` terminal sees in sync with provider
  // and key changes made in the panel, and refresh Codex native chat too.
  syncOpenCodeGlobal(config)
  await syncCodexGlobal(orca, config)
  return config
}

/** @type {import('orca/worker').Activate} */
export default async function activate(orca) {
  activeOrca = orca
  const stored = await storageGet(orca, CONFIG_KEY)
  // Never replace what the store holds just because a read failed: a transient
  // error at activation used to overwrite an imported config with the default.
  if (stored.ok && stored.value && (stored.value.providers || stored.value.upstreams)) {
    config = jsonSafe(normalizeConfig(stored.value))
  } else {
    config = jsonSafe(normalizeConfig(structuredClone(DEFAULT_CONFIG)))
  }
  if (stored.ok) await orca.storage.set(CONFIG_KEY, config).catch(() => {})
  await refreshSettings(orca)
  await refreshSecrets(orca)

  sidecar = createSidecar({
    getConfig: effectiveConfig,
    getSecret: (secretKey) => secretsCache.get(secretKey) ?? null,
    onLog: (entry) => {
      try {
        const sanitized = panelLogEntry(entry)
        if (sanitized) orca.panels.post('router.log', { entry: sanitized })
      } catch {
        /* no panel open */
      }
    }
  })

  if (settings.enabled) await ensureRunning(orca)
  else await announce(orca, false, settings.port)
  // A previous run may have left the managed Codex block behind after a crash;
  // restore first, then publish the current provider/catalog.
  await syncCodexGlobal(orca, config).catch(() => {})

  // --- panel requests ---
  orca.panels.handle('router.status', async () => {
    await refreshSettings(orca)
    const status = sidecar.status()
    let logs = (sidecar.logs || []).slice(-50).map(panelLogEntry).filter(Boolean)
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
  orca.panels.handle('router.clearLogs', async () => {
    if (typeof sidecar?.clearLogs === 'function') sidecar.clearLogs()
    else sidecar.logs.length = 0
    return { ok: true }
  })
  orca.panels.handle('router.usage', async ({ window }) => sidecar.usage({ window: window ?? 'today' }))
  orca.panels.handle('router.presets', async () => ({ presets: PROVIDER_PRESETS }))
  orca.panels.handle('router.config.get', async () => jsonSafe({ config }))
  orca.panels.handle('router.config.save', async ({ config: next }) => {
    const problem = validateConfig(next)
    if (problem) {
      const error = new Error(problem)
      error.code = 'invalid_params'
      throw error
    }
    await persistConfig(orca, next)
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
    if (!next.defaultProvider) next.defaultProvider = provider.name
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
  orca.panels.handle('router.key.update', async ({ provider: name, secretKey, id, enabled, priority, weight, limits }) => {
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
  orca.panels.handle('router.testUsage', async ({ provider: name }) => {
    const provider = config.providers.find((item) => item.name === name)
    if (!provider) throw new Error(`unknown provider: ${name}`)
    return fetchProviderUsage(provider, { getSecret: (secretKey) => secretsCache.get(secretKey) ?? null })
  })

  // (debug handler removed)
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
// back to a reachability check when the endpoint is absent.
function joinProbeUrl(baseUrl, pathname) {
  const base = String(baseUrl).replace(/\/+$/, '')
  const dedup = base.toLowerCase().endsWith('/v1') && pathname.toLowerCase().startsWith('/v1') ? base.slice(0, -3) : base
  return `${dedup}${pathname}`
}

function providerProbe(provider, key) {
  const baseUrl = String(provider.baseUrl ?? provider.endpoints?.[0]?.baseUrl ?? '').replace(/\/+$/, '')
  const protocols = (provider.protocols ?? provider.capabilities ?? []).map(String)
  const onlyGemini = protocols.includes('gemini') && !['openai', 'anthropic', 'responses', 'passthrough'].some((p) => protocols.includes(p))
  if (onlyGemini) {
    return { url: joinProbeUrl(baseUrl, '/v1beta/models'), headers: key ? { 'x-goog-api-key': key } : {}, protocol: 'gemini' }
  }
  const onlyAnthropic = protocols.includes('anthropic') && !['openai', 'responses', 'passthrough'].some((p) => protocols.includes(p))
  if (onlyAnthropic) {
    return { url: joinProbeUrl(baseUrl, '/v1/models'), headers: { ...(key ? { 'x-api-key': key } : {}), 'anthropic-version': '2023-06-01' }, protocol: 'anthropic' }
  }
  return { url: joinProbeUrl(baseUrl, '/v1/models'), headers: key ? { authorization: `Bearer ${key}` } : {}, protocol: 'openai' }
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
      const health = await fetch(joinProbeUrl(baseUrl, '/health'), { method: 'GET', headers: probe.headers, signal: AbortSignal.timeout(5000) }).catch(() => null)
      if (health) {
        results.push({ provider: provider.name, ok: health.status < 500, status: health.status, latencyMs: Date.now() - started })
      } else {
        results.push({ provider: provider.name, ok: false, status: res.status, latencyMs: Date.now() - started })
      }
    } catch {
      results.push({ provider: provider.name, ok: false, status: null, message: 'no response', latencyMs: Date.now() - started })
    }
  }
  return { results }
}

export async function deactivate() {
  await restoreCodexGlobal(activeOrca).catch(() => {})
  await sidecar?.stop?.().catch(() => {})
  boundAddress = null
  activeOrca = null
}
