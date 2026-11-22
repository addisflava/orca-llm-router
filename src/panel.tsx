// LLM Router dashboard: gateway state, providers, routing rules, aliases,
// agent profiles, client keys, logs and usage. All edits flow through the
// worker's panel handlers (typed by protocol.ts).
//
// The panel is designed for Orca's narrow right sidebar: one column, wrapping
// action rows, disclosure forms and compact list rows instead of tables.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  Code,
  Collapsible,
  derived,
  EmptyState,
  Grid,
  Heading,
  IconButton,
  Image,
  Input,
  KeyValue,
  Link,
  plugin,
  read,
  RelativeTime,
  Row,
  secrets,
  Select,
  Separator,
  set,
  settings,
  Skeleton,
  Stack,
  Switch,
  Table,
  Text,
  Textarea,
  update,
  type Atom,
  type PanelContext,
  type Tone,
  type WithChildren
} from 'orca'
import type { AgentRoute, DetectedRouterInfo, FallbackPolicy, KeyProviderUsage, LogEntry, ModelRoute, ModelTarget, ProviderConfig, ProviderHealthView, ProviderKeyUsage, ProviderKeyUsageReport, ProviderPreset, ProviderUsageMeter, ProviderView, RouterConfig, UsageConnector, UsageMeterMapping, PolicyCondition, PolicyRewrite, RequestPolicy, VpnServerConfig } from './protocol'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
type KeyDraft = { name: string; value: string; priority: string; weight: string; limits: string; open: boolean }

function blankKeyDraft(): KeyDraft {
  return { name: '', value: '', priority: '', weight: '', limits: '', open: false }
}

const running = atom(false)
const host = atom('127.0.0.1')
const port = atom(18080)
const portDraft = atom('')
const editingPort = atom(false)
const savingPort = atom(false)
const tab = atom('tab', 'overview', { persist: 'plugin' })
const config = atom<RouterConfig | null>(null)
const providers = atom<ProviderView[]>([])
const policies = atom<RequestPolicy[]>([])
const aliases = atom<Record<string, string>>({})
const clientKeys = atom<{ id: string; name: string; expiresAt?: string; limits?: Record<string, unknown>; enabled: boolean }[]>([])
const agentList = atom<AgentRoute[]>([])
const presetList = atom<ProviderPreset[]>([])
const logs = atom<LogEntry[]>([])
const pendingLogs = atom<LogEntry[]>([])
const logLive = atom('logLive', true)
const logSearch = atom('logSearch', '')
const logErrorsOnly = atom('logErrorsOnly', false)
const logExpanded = atom('logExpanded', '')
const routeFailovers = atom<Record<string, number>>({})
const routeRequests = atom<Record<string, number>>({})
const keyQuotaReports = atom<ProviderKeyUsageReport[]>([])
// The provider whose usage is being fetched, and the last inline result for it.
// Transient UI state: plain (per-panel) atoms, never shared or persisted.
const usageBusy = atom('')
const usageNote = atom<{
  provider: string
  text: string
  tone: 'neutral' | 'success' | 'danger'
  action?: 'configure'
} | null>(null)
const usageDraft = atom({ endpoint: '', auth: 'provider-api-key', meters: '' })
const usageDetected = atom<{ provider: string; endpoint: string; connector: UsageConnector } | null>(null)
const loaded = atom(false)
const usage = atom<{
  requests: number
  successRate: number
  errors: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cost: number
  unpricedRequests?: number
  cachedTokens?: number
  uncachedTokens?: number
  avgLatencyMs: number
  cacheHits?: number
  cacheSavedTokens?: number
  cacheSavedCost?: number
  compressionSavedChars?: number
  relayEvents?: number
  byProvider: { provider: string; count: number }[]
  byModel: { model: string; count: number }[]
  byRoute?: { route: string; requests: number; cost: number; failovers: number }[]
  byAgent?: { agent: string; requests: number; cost: number; failovers: number }[]
  byKey?: { credential: string; requests: number; cost: number; failovers: number }[]
  byProviderSpend?: { provider: string; requests: number; cost: number; failovers: number }[]
  daily?: DailyUsage[]
  modelUsage?: { model: string; requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }[]
} | null>(null)
const message = atom('')
const error = atom('')
const createdKey = atom('')

// Web chat (native DeepSeek / Qwen web subscriptions) — Add provider dialog mode.
type WebChatLogin = { mode: string; port: number; secretKey: string; captured?: boolean }
const webchatBusy = atom('webchatBusy', '')
const webchatStatus = atom<Record<string, WebChatStatus>>('webchatStatus', {})
const webchatLogins = atom<Record<string, WebChatLogin>>('webchatLogins', {})
const webchatPasteFor = atom('webchatPasteFor', '')
const webchatPasteText = atom('webchatPasteText', '')
const webchatReconnectFor = atom('webchatReconnectFor', '')

// Add provider forms. Preset and custom are kept apart so switching between
// them never leaves one form's values in the other's fields.
const addProviderOpen = atom(false)
const addMode = atom<'preset' | 'custom' | 'webchat'>('preset')
const presetId = atom('')
const presetName = atom('')
const presetKeys = atom<KeyDraft[]>([blankKeyDraft()])

const customName = atom('')
const customEndpoints = atom<{ baseUrl: string; protocols: string[] }[]>([{ baseUrl: '', protocols: ['openai'] }])
const customModels = atom('')
const customKeys = atom<KeyDraft[]>([blankKeyDraft()])
const customUsageDraft = atom<{ endpoint: string; auth: string; meters: string }>({ endpoint: '', auth: 'provider-api-key', meters: '' })

// Naming fields stay quiet: the effective provider name is shown inline and
// only becomes an input when its edit icon is pressed. `fetchingModels`
// disables the model-pull buttons while a list is in flight.
const presetNameEditing = atom(false)
const fetchingModels = atom(false)

// Model discovery picker. Fetching a provider's models no longer writes the
// whole endpoint list into the config: the fetched ids are offered with
// checkboxes, a name filter and bulk select, and only chosen models are kept.
type ModelChoice = { id: string; checked: boolean; existing: boolean }
const modelPickerFor = atom('')
const modelPickerChoices = atom<ModelChoice[]>([])
const modelPickerFilter = atom('')
const modelPickerSaving = atom(false)

// Cross-provider model search. One request pulls every provider's models and
// they arrive as a single provider-grouped, searchable list; saving writes the
// picked ids into each provider's model list so they show up under Providers
// and as route targets alike.
type GlobalModelChoice = { provider: string; id: string; checked: boolean; existing: boolean }
const globalModelsOpen = atom(false)
const globalModelsFetching = atom(false)
const globalModelsSaving = atom(false)
const globalModelChoices = atom<GlobalModelChoice[]>([])
const globalModelFilter = atom('')
const globalModelErrors = atom<{ provider: string; message: string }[]>([])

// A policy can carry several rewrites, each with its own operation
// (set/delete/array-*), so the add/edit form keeps them as a list of drafts.
type RewriteDraft = { key: string; operation: string; value: string; match: string }

function blankRewriteDraft(): RewriteDraft {
  return { key: 'request.body.model', operation: 'set', value: '', match: '' }
}

// Route targets are edited as provider/model rows behind a searchable
// multi-select. `ANY_PROVIDER` keeps entries that are aliases or bare model ids
// (the raw editor is the way to add those; the picker keeps existing ones).
type ChainRow = { key: string; provider: string; model: string; custom: boolean }
const ANY_PROVIDER = '__any__'

let chainRowSeq = 0
function newChainRow(provider = '', model = '', custom = false): ChainRow {
  chainRowSeq += 1
  return { key: `chain-${chainRowSeq}`, provider, model, custom }
}

const policyOpen = atom(false)
const policyName = atom('')
const policyMatchAll = atom(false)
const policySource = atom('request.body')
const policyField = atom('model')
const policyOperator = atom('starts-with')
const policyValue = atom('claude-')
const policyModel = atom('')
const policyRewrites = atom<RewriteDraft[]>([])
// A policy fallback is an ordered chain of entries appended after the primary
// target on failure. Each entry is a route name or a raw provider/model target.
const policyFallback = atom<string[]>('policyFallback', [])
const policyFallbackRaw = atom('policyFallbackRaw', false)
const policyFallbackText = atom('policyFallbackText', '')
const policyFallbackFilter = atom('policyFallbackFilter', '')

// Route editor. A route is the alias-like unit that owns failover:
// one name agents send, plus one or more provider/model targets.
const routeOpen = atom(false)
const routeName = atom('')
const routeTargets = atom<ChainRow[]>('routeTargets', [])
const routeTargetFilter = atom('routeTargetFilter', '')
const routeFastest = atom('routeFastest', true)
const routeRetries = atom('2')
const routeEditName = atom('')
// Models pulled by "Fetch all models from all providers" in a route's target editor that are not saved to
// their provider yet. Picking one adds it as a target; saving the route also
// writes it into that provider's model list.
const routeFetchedModels = atom<ModelTarget[]>('routeFetchedModels', [])
// A route's optional VPN/proxy server id. Empty means direct.
const routeVpn = atom('')

// VPN / proxy server editor (Settings). Credentials are written through the
// worker to Orca's secret store; only their secret name is kept in config.
const vpnFormOpen = atom(false)
const vpnEditId = atom('')
const vpnName = atom('')
const vpnType = atom<'http' | 'socks5'>('socks5')
const vpnHost = atom('')
const vpnPort = atom('')
const vpnUsername = atom('')
const vpnPassword = atom('')

const agentsOtherOpen = atom(false)

const keyFormFor = atom('')
// The add-key form is a list of rows so a provider can take several pool
// entries at once; each row carries its own optional name, priority and limits.
const keyDrafts = atom<KeyDraft[]>([])
// Inline editor for an existing key's scheduling metadata.
const keyEditFor = atom('')
const keyEditName = atom('')
const keyEditValue = atom('')
const keyEditValueOpen = atom(false)
const keyEditValueLoading = atom(false)
const keyEditPriority = atom('')
const keyEditWeight = atom('')
const keyEditLimits = atom('')
// Which destructive action is awaiting confirmation, as a target token
// (`provider:<name>` or `key:<provider>:<secretKey>`).
const confirmTarget = atom('')
// Key values never live in the config (which stores secret names only), so
// copying reads the encrypted value from Orca's secret store on demand.
const clientKeyName = atom('')
const clientKeyExpires = atom('')
const clientKeyLimits = atom('')
const clientKeyOpen = atom(false)

const importJsonText = atom('')
const importPathText = atom('')
const importMerge = atom(true)
const detectedLocal = atom<{ ccr: DetectedRouterInfo | null; omniroute: DetectedRouterInfo | null } | null>(null)
const detectingLocal = atom(false)

// Info banners stay as a single title line once something is configured and
// expand on demand; with nothing configured they start open. `null` means
// "auto", so the banner opens or closes as the configuration appears.
const overviewInfoOpen = atom<boolean | null>(null)
const providersInfoOpen = atom<boolean | null>(null)
const routingInfoOpen = atom<boolean | null>(null)
const settingsInfoOpen = atom<boolean | null>(null)
const profilesInfoOpen = atom<boolean | null>(null)
const logsInfoOpen = atom<boolean | null>(null)

// Inline edit state. Each list card swaps its summary for an editor when it
// owns the edit slot; the shared add forms double as editors for rules/routes.
const providerEditFor = atom('')
const providerEditDisplayName = atom('')
const providerEditEndpoints = atom<{ baseUrl: string; protocols: string[] }[]>('providerEditEndpoints', [])
const providerEditModels = atom('')
// Which provider's full model list is expanded under its header, so long
// endpoint lists stay compact until someone asks for all of them.
const modelsExpandedFor = atom('')

const policyEditIndex = atom(-1)

const SECTIONS = [
  { value: 'overview', label: 'Home' },
  { value: 'providers', label: 'Providers' },
  { value: 'routing', label: 'Routing' },
  { value: 'profiles', label: 'Agents' },
  { value: 'usage', label: 'Usage' },
  { value: 'logs', label: 'Logs' },
  { value: 'settings', label: 'Settings' }
]

const SOURCE_OPTIONS = [
  { value: 'request.body', label: 'Request body' },
  { value: 'request.header', label: 'Request header' },
  { value: 'request.headers', label: 'Request headers' }
]
// Operator values are the exact strings evaluateCondition() handles in the
// worker; keep this list in sync with its switch (worker/sidecar.mjs).
const OPERATOR_OPTIONS = [
  { value: 'equals', label: 'equals' },
  { value: '==', label: 'equals (loose / numeric)' },
  { value: '!=', label: 'does not equal' },
  { value: 'starts-with', label: 'starts with' },
  { value: 'contains', label: 'contains' },
  { value: 'contains-deep', label: 'contains (deep)' },
  { value: 'not-contains', label: 'does not contain' },
  { value: 'matches', label: 'matches glob (*)' },
  { value: '>', label: 'greater than' },
  { value: '>=', label: 'greater than or equal' },
  { value: '<', label: 'less than' },
  { value: '<=', label: 'less than or equal' }
]
// Operations accepted by applyRewrites() in the worker.
const REWRITE_OPERATIONS = [
  { value: 'set', label: 'Set value' },
  { value: 'delete', label: 'Delete field' },
  { value: 'array-append', label: 'Append to array' },
  { value: 'array-prepend', label: 'Prepend to array' },
  { value: 'array-remove', label: 'Remove from array' },
  { value: 'array-replace', label: 'Replace in array' }
]
// Keep an operator saved by an older panel visible in the Select even when it
// is no longer one of the current options (e.g. a legacy "not-equals" policy).
function operatorOptions() {
  const current = read(policyOperator)
  return OPERATOR_OPTIONS.some((option) => option.value === current)
    ? OPERATOR_OPTIONS
    : [{ value: current, label: current }, ...OPERATOR_OPTIONS]
}

function findPreset(id: string) {
  return read(presetList).find((item) => item.id === id)
}

function presetDescription(preset: ProviderPreset | undefined) {
  if (!preset) return 'Pick a provider preset; it fills in the base URL, protocols and default models.'
  return `${preset.baseUrl} · ${preset.capabilities.map(friendlyProtocol).join(', ') || 'custom protocols'}`
}

function friendlyProtocol(capability: string) {
  if (capability === 'openai_chat_completions' || capability === 'openai') return 'OpenAI Chat'
  if (capability === 'openai_responses' || capability === 'responses') return 'OpenAI Responses'
  if (capability === 'anthropic_messages' || capability === 'anthropic') return 'Anthropic Messages'
  if (capability === 'gemini_generate_content' || capability === 'gemini_interactions') return 'Gemini'
  return capability
}

function configProvider(name: string) {
  return read(config)?.providers.find((provider) => provider.name === name)
}

// Naming for the add-key draft rows: resolve the name each row will be saved
// under, so the form shows the real value and fresh defaults step past names
// that already exist.
function existingProviderNames() {
  return new Set((read(config)?.providers ?? []).map((provider) => provider.name))
}

function existingSecretNames() {
  const names = new Set<string>()
  for (const provider of read(config)?.providers ?? []) {
    for (const key of provider.keys ?? []) names.add(key.secretKey)
  }
  return names
}

function uniqueProviderName(base: string, used: Set<string>) {
  if (!used.has(base)) return base
  let index = 2
  while (used.has(`${base}-${index}`)) index++
  return `${base}-${index}`
}

// The effective provider name for the preset form: the typed override, else the
// preset id bumped past any provider that already uses it.
function presetProviderName() {
  const typed = read(presetName).trim()
  if (typed) return typed
  return uniqueProviderName(read(presetId) || 'provider', existingProviderNames())
}

// Naming for the add-key draft rows: blank rows become `key-1`, `key-2`, ...
// skipping any name already taken and any name typed in another row.
function draftKeyNames(drafts: KeyDraft[], taken: Set<string>) {
  const used = new Set(taken)
  const blocked = new Set(taken)
  for (const draft of drafts) {
    const typed = draft.name.trim()
    if (typed) blocked.add(typed)
  }
  return drafts.map((draft) => {
    const typed = draft.name.trim()
    if (typed) return reserveName(typed, used)
    let index = 1
    let candidate = `key-${index}`
    while (used.has(candidate) || blocked.has(candidate)) {
      index += 1
      candidate = `key-${index}`
    }
    used.add(candidate)
    return candidate
  })
}

function reserveName(desired: string, used: Set<string>) {
  let candidate = desired
  let index = 1
  while (used.has(candidate)) {
    index += 1
    candidate = `${desired}-${index}`
  }
  used.add(candidate)
  return candidate
}

// ---------------------------------------------------------------------------
// Loading and mutations
// ---------------------------------------------------------------------------
let keyQuotaRefreshInFlight = false
let lastKeyQuotaRefresh = 0
async function refreshKeyQuotas() {
  if (keyQuotaRefreshInFlight) return
  if (Date.now() - lastKeyQuotaRefresh < 20_000) return
  keyQuotaRefreshInFlight = true
  lastKeyQuotaRefresh = Date.now()
  try {
    const result = await plugin.request('router.keyUsage', {})
    set(keyQuotaReports, result.providers)
  } catch {
    // Provider usage is optional; keep the last successful snapshot.
  } finally {
    keyQuotaRefreshInFlight = false
  }
}

async function refresh() {
  set(error, '')
  try {
    const [status, loadedConfig, metrics, presets] = await Promise.all([
      plugin.request('router.status', {}),
      plugin.request('router.config.get', {}),
      plugin.request('router.usage', { window: 'today' }).catch(() => null),
      plugin.request('router.presets', {}).catch(() => ({ presets: [] as ProviderPreset[] }))
    ])
    set(running, status.running)
    set(host, status.host)
    set(port, status.port)
    set(portDraft, String(status.port))
    set(providers, status.providers)
    set(policies, status.policies)
    set(aliases, status.aliases)
    set(clientKeys, status.clientKeys)
    set(agentList, status.agents ?? [])
    set(routeFailovers, status.routeFailovers ?? {})
    set(routeRequests, status.routeRequests ?? {})
    if (read(logLive)) set(logs, status.logs)
    set(config, loadedConfig.config)
    set(usage, metrics)
    set(presetList, presets.presets)
  } catch (cause) {
    set(error, `Status failed: ${(cause as Error).message}`)
  } finally {
    set(loaded, true)
    void refreshKeyQuotas()
  }
}

async function mutate(name: 'router.start' | 'router.stop' | 'router.restart') {
  set(error, '')
  set(message, '')
  try {
    await plugin.request(name, {})
    set(message, name === 'router.stop' ? 'Gateway stopped.' : 'Gateway is running.')
    await refresh()
  } catch (cause) {
    set(error, `${name.replace('router.', '')} failed: ${(cause as Error).message}`)
  }
}

// The port lives in Orca's plugin settings (retries and timeouts read it the
// same way). Changing it restarts a running gateway so the new address applies
// immediately; a stopped one picks it up on the next start.
async function saveGatewayPort() {
  const next = Number(read(portDraft).trim())
  if (!Number.isInteger(next) || next < 1024 || next > 65535) {
    set(error, 'Gateway port must be a whole number between 1024 and 65535')
    return
  }
  const wasRunning = read(running)
  set(error, '')
  set(message, '')
  set(savingPort, true)
  try {
    await settings.set('port', next)
    if (wasRunning) {
      const result = await plugin.request('router.restart', {})
      await refresh()
      if (!result.running) {
        set(error, `Gateway did not start on port ${next}; the port may be in use.`)
        return
      }
      set(message, `Gateway restarted on port ${next}.`)
    } else {
      await refresh()
      set(message, `Gateway port set to ${next}.`)
    }
    set(editingPort, false)
  } catch (cause) {
    set(error, `Port change failed: ${(cause as Error).message}`)
  } finally {
    set(savingPort, false)
  }
}

async function testProviders() {
  set(error, '')
  set(message, '')
  try {
    const { results } = await plugin.request('router.test', {})
    await refresh()
    const down = results.filter((result) => !result.ok)
    const fastest = results
      .filter((result) => result.ok && Number.isFinite(result.latencyMs))
      .sort((a, b) => a.latencyMs - b.latencyMs)[0]
    const fastestNote = fastest ? ` · fastest ${fastest.provider} ${fastest.latencyMs}ms` : ''
    set(
      message,
      down.length
        ? `Unreachable: ${down.map((result) => `${result.provider}${result.message ? ` (${result.message})` : ''}`).join(', ')}`
        : `${results.length} provider${results.length === 1 ? '' : 's'} reachable${fastestNote}`
    )
  } catch (cause) {
    set(error, `Connectivity test failed: ${(cause as Error).message}`)
  }
}

async function testProvider(name: string) {
  set(error, '')
  set(message, '')
  try {
    const { results } = await plugin.request('router.testProvider', { provider: name })
    await refresh()
    const result = results[0]
    set(message, result?.ok
      ? `${name} is reachable (${result.latencyMs ?? '—'}ms)`
      : `${name} failed${result?.status ? ` (HTTP ${result.status})` : ''}${result?.message ? `: ${result.message}` : ''}`)
  } catch (cause) {
    set(error, `Test failed: ${(cause as Error).message}`)
  }
}

function parseMaybe(value: string) {
  const text = value.trim()
  if (!text) return ''
  try {
    return JSON.parse(text)
  } catch {
    return value
  }
}

// `modelWindows` is populated by the worker (model discovery and the models.dev
// sync), never edited here, and re-merged from the worker's live copy on save.
// It grows with every discovered model, so round-tripping the whole cache
// through the panel can exceed Orca's panel-message size limit (64 KB) and make
// every save fail with "Message exceeds the size limit." Send everything the
// panel actually owns, but leave that cache out of the wire payload.
function configSavePayload(next: RouterConfig): RouterConfig {
  const payload = { ...next } as RouterConfig & { modelWindows?: unknown }
  delete payload.modelWindows
  return payload
}

async function saveConfig(mutator: (next: RouterConfig) => void) {
  const current = read(config)
  if (!current) {
    set(error, 'Config not loaded yet')
    return false
  }
  const next = structuredClone(current)
  mutator(next)
  try {
    await plugin.request('router.config.save', { config: configSavePayload(next) })
    set(config, next)
    await refresh()
    return true
  } catch (cause) {
    set(error, `Save failed: ${(cause as Error).message}`)
    return false
  }
}

async function dismissMigrationReport() {
  const saved = await saveConfig((next) => {
    next.migration = []
  })
  if (saved) set(message, 'Migration report dismissed')
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
async function addPresetProvider() {
  const id = read(presetId).trim()
  if (!id) {
    set(error, 'Choose a preset first')
    return
  }
  set(error, '')
  set(message, '')
  try {
    const result = await plugin.request('router.provider.addPreset', {
      presetId: id,
      name: presetProviderName()
    })
    let added = 0
    try {
      added = await addDraftKeys(result.provider, read(presetKeys), existingSecretNames())
    } catch (cause) {
      set(error, `Provider saved, but a key failed: ${(cause as Error).message}`)
    }
    set(message, `Added provider ${result.provider}${added ? ` with ${added} key${added === 1 ? '' : 's'}` : ''}`)
    set(presetId, '')
    set(presetName, '')
    set(presetKeys, [blankKeyDraft()])
    set(presetNameEditing, false)
    set(addProviderOpen, false)
    closeModelPicker()
    await refresh()
  } catch (cause) {
    set(error, `Add provider failed: ${(cause as Error).message}`)
  }
}

async function addCustomProvider() {
  const name = read(customName).trim()
  const endpoints = read(customEndpoints)
    .map((endpoint) => ({
      baseUrl: endpoint.baseUrl.trim().replace(/\/+$/, ''),
      protocols: [...new Set(endpoint.protocols.filter(Boolean))]
    }))
    .filter((endpoint) => endpoint.baseUrl)
  if (!name || !endpoints.length) {
    set(error, 'Custom provider needs a name and base URL')
    return
  }
  if (!endpoints.some((endpoint) => endpoint.protocols.length)) {
    set(error, 'Enable at least one protocol')
    return
  }
  const protocols = [...new Set(endpoints.flatMap((endpoint) => endpoint.protocols))]
  const models = parseModelLines(read(customModels)).map(({ id, contextWindow, maxOutput }) => ({
    id,
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutput ? { maxOutput } : {})
  }))
  set(error, '')
  set(message, '')
  const saved = await saveConfig((next) => {
    next.providers.push({ name, baseUrl: endpoints[0].baseUrl, endpoints, protocols, models, keys: [] })
  })
  if (!saved) return
  let added = 0
  try {
    added = await addDraftKeys(name, read(customKeys), existingSecretNames())
  } catch (cause) {
    set(error, `Provider saved, but a key failed: ${(cause as Error).message}`)
  }
  // The Edit form carries a Usage source group too, so save a connector here
  // when the user filled one in.
  const usage = read(customUsageDraft)
  const usageEndpoint = usage.endpoint.trim()
  if (/^https?:\/\//i.test(usageEndpoint)) {
    try {
      const meters: unknown = JSON.parse(usage.meters || '[]')
      if (Array.isArray(meters) && meters.length) {
        await plugin.request('router.provider.usage', {
          provider: name,
          usageFetch: {
            enabled: true,
            connectors: [{
              id: 'custom',
              type: 'http-json',
              endpoint: usageEndpoint,
              auth: usage.auth === 'none' ? 'none' : 'provider-api-key',
              mapping: { meters: meters as UsageMeterMapping[] }
            }]
          }
        })
      }
    } catch {
      set(error, 'Usage source was not saved: check the endpoint and meters JSON')
    }
  }
  set(message, `Added provider ${name}${added ? ` with ${added} key${added === 1 ? '' : 's'}` : ''}`)
  set(customName, '')
  set(customEndpoints, [{ baseUrl: '', protocols: ['openai'] }])
  set(customModels, '')
  set(customKeys, [blankKeyDraft()])
  set(customUsageDraft, { endpoint: '', auth: 'provider-api-key', meters: '' })
  set(addProviderOpen, false)
  closeModelPicker()
  await refresh()
}

async function removeProvider(name: string) {
  closeModelPicker()
  await saveConfig((next) => {
    next.providers = next.providers.filter((provider) => provider.name !== name)
  })
}

// Add every filled draft row to a provider's key pool. Limits are validated up
// front so a bad row does not leave a partial batch behind. Returns how many
// keys were added.
async function addDraftKeys(providerName: string, drafts: KeyDraft[], taken: Set<string>) {
  const names = draftKeyNames(drafts, taken)
  const rows = drafts
    .map((draft, index) => ({ draft, name: names[index], position: index }))
    .filter((row) => row.draft.value.trim())
  if (!rows.length) return 0
  const parsedLimits: (Record<string, unknown> | undefined)[] = []
  for (let index = 0; index < rows.length; index++) {
    const text = rows[index].draft.limits.trim()
    if (!text) {
      parsedLimits.push(undefined)
      continue
    }
    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object')
      parsedLimits.push(parsed as Record<string, unknown>)
    } catch (cause) {
      throw new Error(
        `Key ${rows[index].position + 1} limits must be a JSON object like {"rpm":60,"rpd":1000} (${(cause as Error).message})`
      )
    }
  }
  for (let index = 0; index < rows.length; index++) {
    const { draft, name } = rows[index]
    await plugin.request('router.key.add', {
      provider: providerName,
      secretKey: name,
      value: draft.value.trim(),
      ...(draft.priority.trim() ? { priority: Number(draft.priority) } : {}),
      ...(draft.weight.trim() ? { weight: Number(draft.weight) } : {}),
      ...(parsedLimits[index] ? { limits: parsedLimits[index] } : {})
    })
  }
  return rows.length
}

async function submitKeyDrafts(providerName: string) {
  const drafts = read(keyDrafts)
  const rows = drafts.filter((draft) => draft.value.trim())
  if (!rows.length) {
    set(error, 'Add at least one API key')
    return
  }
  set(error, '')
  set(message, '')
  try {
    const added = await addDraftKeys(providerName, drafts, existingSecretNames())
    set(keyDrafts, [])
    set(keyFormFor, '')
    set(message, `Saved ${added} key${added === 1 ? '' : 's'} to ${providerName}`)
    await refresh()
  } catch (cause) {
    set(error, `Key failed: ${(cause as Error).message}`)
  }
}

function updateKeyDraft(index: number, patch: Partial<KeyDraft>) {
  set(
    keyDrafts,
    read(keyDrafts).map((draft, position) => (position === index ? { ...draft, ...patch } : draft))
  )
}

function removeKeyDraft(index: number) {
  set(
    keyDrafts,
    read(keyDrafts).filter((_, position) => position !== index)
  )
}

// Generic draft-row helpers for the add-provider forms, which keep their own
// key arrays rather than the card's shared `keyDrafts`.
function patchDraft(target: Atom<KeyDraft[]>, index: number, patch: Partial<KeyDraft>) {
  update(target, (list) => list.map((draft, position) => (position === index ? { ...draft, ...patch } : draft)))
}

function dropDraft(target: Atom<KeyDraft[]>, index: number) {
  update(target, (list) => list.filter((_, position) => position !== index))
}

function appendDraft(target: Atom<KeyDraft[]>) {
  update(target, (list) => [...list, blankKeyDraft()])
}

async function updateProviderKey(
  providerName: string,
  secretKey: string,
  patch: { enabled?: boolean; id?: string; value?: string; priority?: number; weight?: number; limits?: Record<string, unknown> }
) {
  set(error, '')
  set(message, '')
  try {
    await plugin.request('router.key.update', { provider: providerName, secretKey, ...patch })
    await refresh()
    return true
  } catch (cause) {
    set(error, `Key update failed: ${(cause as Error).message}`)
    return false
  }
}

async function removeProviderKey(providerName: string, secretKey: string) {
  set(error, '')
  set(message, '')
  try {
    await plugin.request('router.key.remove', { provider: providerName, secretKey })
    set(message, `Removed key from ${providerName}`)
    await refresh()
  } catch (cause) {
    set(error, `Remove key failed: ${(cause as Error).message}`)
  }
}

function startKeyEdit(providerName: string, key: { secretKey?: string; id?: string; priority?: number; weight?: number; limits?: Record<string, unknown> }) {
  const id = key.secretKey || key.id || ''
  set(keyEditFor, `key-edit:${providerName}:${id}`)
  set(keyEditName, key.id ?? '')
  set(keyEditValue, '')
  set(keyEditValueOpen, false)
  set(keyEditValueLoading, false)
  set(keyEditPriority, String(key.priority ?? 0))
  set(keyEditWeight, String(key.weight ?? 1))
  set(keyEditLimits, key.limits && Object.keys(key.limits).length ? JSON.stringify(key.limits) : '')
}

function closeKeyEdit() {
  set(keyEditFor, '')
  set(keyEditValue, '')
  set(keyEditValueOpen, false)
  set(keyEditValueLoading, false)
}

async function openKeyValueEdit(providerName: string, secretKey: string) {
  const token = `key-edit:${providerName}:${secretKey}`
  set(error, '')
  set(message, '')
  set(keyEditValueLoading, true)
  try {
    const value = await providerKeyValue(secretKey)
    if (read(keyEditFor) !== token) return
    set(keyEditValue, value)
    set(keyEditValueOpen, true)
  } catch (cause) {
    if (read(keyEditFor) !== token) return
    set(error, `Edit key failed: ${(cause as Error).message}`)
  } finally {
    set(keyEditValueLoading, false)
  }
}

async function saveKeyEdit(providerName: string, secretKey: string) {
  let limits: Record<string, unknown> = {}
  const limitsText = read(keyEditLimits).trim()
  if (limitsText) {
    try {
      const parsed = JSON.parse(limitsText)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object')
      limits = parsed as Record<string, unknown>
    } catch (cause) {
      set(error, `Key limits must be a JSON object like {"rpm":60,"rpd":1000} (${(cause as Error).message})`)
      return
    }
  }
  set(error, '')
  const saved = await updateProviderKey(providerName, secretKey, {
    id: read(keyEditName).trim() || undefined,
    value: read(keyEditValue).trim() || undefined,
    priority: Number(read(keyEditPriority)) || 0,
    weight: Number(read(keyEditWeight)) || 1,
    limits
  })
  if (saved) {
    closeKeyEdit()
    set(message, `Saved key options for ${providerName}`)
  }
}

async function saveKeyValueEdit(providerName: string, secretKey: string) {
  const value = read(keyEditValue).trim()
  if (!value) {
    set(error, 'Enter a key value before saving')
    return
  }
  set(error, '')
  const saved = await updateProviderKey(providerName, secretKey, { value })
  if (saved) {
    set(keyEditValue, '')
    set(keyEditValueOpen, false)
    set(message, `Updated API key for ${providerName}`)
  }
}

// Key values never live in the config (which stores secret names only), so
// copying reads the encrypted value from Orca's secret store on demand.
async function providerKeyValue(secretKey: string) {
  const value = await secrets.get(secretKey)
  if (!value) throw new Error(`no stored value for ${secretKey}`)
  return value
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    return
  } catch {
    // Older/embedded renderers can refuse the async clipboard API; the
    // selection-based path still works from the button's user gesture.
    const area = document.createElement('textarea')
    area.value = value
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    if (!copied) throw new Error('clipboard is unavailable')
  }
}

async function copyProviderKey(secretKey: string) {
  set(error, '')
  set(message, '')
  try {
    const value = await providerKeyValue(secretKey)
    await copyText(value)
    set(message, `Copied ${secretKey} to the clipboard.`)
  } catch (cause) {
    set(error, `Copy key failed: ${(cause as Error).message}`)
  }
}

async function discover(name: string) {
  set(error, '')
  set(message, '')
  set(fetchingModels, true)
  try {
    const result = await plugin.request('router.discoverModels', { provider: name })
    const knownIds = (configProvider(name)?.models ?? []).map((model) => model.id)
    openModelPicker(`provider:${name}`, result.models, knownIds)
    set(
      message,
      `Found ${result.models.length} model${result.models.length === 1 ? '' : 's'} for ${name}. Pick which to save.`
    )
  } catch (cause) {
    set(error, `Fetch models failed: ${(cause as Error).message}`)
  } finally {
    set(fetchingModels, false)
  }
}

// The picker is global so only one fetched list is open at a time: a list on
// another provider (or in the add/edit form) closes when a new fetch lands.
function openModelPicker(token: string, fetched: string[], existingIds: string[]) {
  const known = new Set(existingIds)
  const seen = new Set<string>()
  const choices: ModelChoice[] = []
  for (const id of fetched) {
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    choices.push({ id: trimmed, checked: known.has(trimmed), existing: known.has(trimmed) })
  }
  set(modelPickerFor, token)
  set(modelPickerFilter, '')
  set(modelPickerChoices, choices)
}

function closeModelPicker() {
  set(modelPickerFor, '')
  set(modelPickerChoices, [])
  set(modelPickerFilter, '')
}

function toggleModelChoice(id: string, checked: boolean) {
  update(modelPickerChoices, (list) =>
    list.map((choice) => (choice.id === id ? { ...choice, checked } : choice))
  )
}

// Bulk actions take explicit ids, so callers can target every fetched model or
// only the rows left after filtering by name.
function setModelChoices(ids: string[], checked: boolean) {
  const target = new Set(ids)
  update(modelPickerChoices, (list) =>
    list.map((choice) => (target.has(choice.id) ? { ...choice, checked } : choice))
  )
}

function applyPickedModelsTo(target: Atom<string>, label: string) {
  const choices = read(modelPickerChoices)
  const selected = choices.filter((choice) => choice.checked).map((choice) => choice.id)
  const fetched = new Set(choices.map((choice) => choice.id))
  const selectedSet = new Set(selected)
  // Keep the full original line (`id | context | output`) for surviving models
  // so re-picking cannot drop a hand-written window override.
  const rawLines = read(target).split(/\n/).map((line) => line.trim()).filter(Boolean)
  const lineById = new Map(rawLines.map((line) => [line.split('|')[0].trim(), line]))
  const next = modelTextIds(read(target)).filter((id) => !fetched.has(id) || selectedSet.has(id))
  const seen = new Set(next)
  for (const id of selected) {
    if (seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  set(error, '')
  set(target, next.map((id) => lineById.get(id) ?? id).join('\n'))
  closeModelPicker()
  set(message, `${label}: ${next.length} model${next.length === 1 ? '' : 's'}`)
}

// Save the selected fetched models as the provider's endpoint list. Models the
// endpoint did not return stay put, so hand-written extras are never dropped;
// unchecking a fetched model removes it. Known entries keep their
// description/pricing metadata.
async function savePickedModels(name: string) {
  const cfg = configProvider(name)
  if (!cfg) {
    set(error, `Provider ${name} no longer exists`)
    return
  }
  const choices = read(modelPickerChoices)
  const selected = choices.filter((choice) => choice.checked).map((choice) => choice.id)
  const fetched = new Set(choices.map((choice) => choice.id))
  const selectedSet = new Set(selected)
  const known = new Map((cfg.models ?? []).map((model) => [model.id, model]))
  const ids = (cfg.models ?? [])
    .map((model) => model.id)
    .filter((id) => !fetched.has(id) || selectedSet.has(id))
  const seen = new Set(ids)
  for (const id of selected) {
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  set(error, '')
  set(message, '')
  set(modelPickerSaving, true)
  try {
    const saved = await saveConfig((next) => {
      const provider = next.providers.find((item) => item.name === name)
      if (!provider) return
      provider.models = ids.map((id) => known.get(id) ?? { id })
    })
    if (!saved) return
    closeModelPicker()
    set(message, `Saved ${ids.length} model${ids.length === 1 ? '' : 's'} for ${name}`)
  } finally {
    set(modelPickerSaving, false)
  }
}

// Fetch every provider's models in one request and open the cross-provider
// picker, seeding each row from the models the provider already has saved.
async function fetchAllModels() {
  set(error, '')
  set(message, '')
  set(globalModelsFetching, true)
  try {
    const result = await plugin.request('router.discoverAllModels', {})
    const choices: GlobalModelChoice[] = []
    const seen = new Set<string>()
    const errors: { provider: string; message: string }[] = []
    let reached = 0
    for (const entry of result.providers) {
      if (entry.error) errors.push({ provider: entry.provider, message: entry.error })
      if (entry.models.length) reached++
      const known = new Set((configProvider(entry.provider)?.models ?? []).map((model) => model.id))
      for (const raw of entry.models) {
        const id = raw.trim()
        if (!id) continue
        const key = `${entry.provider}\u0000${id}`
        if (seen.has(key)) continue
        seen.add(key)
        choices.push({ provider: entry.provider, id, checked: known.has(id), existing: known.has(id) })
      }
    }
    set(globalModelChoices, choices)
    set(globalModelErrors, errors)
    set(globalModelFilter, '')
    set(globalModelsOpen, true)
    set(
      message,
      choices.length
        ? `Found ${choices.length} model${choices.length === 1 ? '' : 's'} across ${reached} provider${
            reached === 1 ? '' : 's'
          }. Pick which to make available.`
        : 'No provider returned any models.'
    )
  } catch (cause) {
    set(error, `Search models failed: ${(cause as Error).message}`)
  } finally {
    set(globalModelsFetching, false)
  }
}

function closeGlobalModels() {
  set(globalModelsOpen, false)
  set(globalModelChoices, [])
  set(globalModelFilter, '')
  set(globalModelErrors, [])
}

function toggleGlobalModel(provider: string, id: string, checked: boolean) {
  update(globalModelChoices, (list) =>
    list.map((choice) => (choice.provider === provider && choice.id === id ? { ...choice, checked } : choice))
  )
}

// Bulk actions take explicit keys, so callers can target every fetched model or
// only the rows left after filtering.
function setGlobalModelChoices(keys: string[], checked: boolean) {
  const target = new Set(keys)
  update(globalModelChoices, (list) =>
    list.map((choice) =>
      target.has(`${choice.provider}\u0000${choice.id}`) ? { ...choice, checked } : choice
    )
  )
}

// Persist the picked models into every provider's list. A provider whose fetch
// failed has no rows and keeps its models untouched; models the endpoint did not
// return are kept too, so hand-written extras survive.
async function saveGlobalModels() {
  const choices = read(globalModelChoices)
  const selected = choices.filter((choice) => choice.checked)
  set(error, '')
  set(message, '')
  set(globalModelsSaving, true)
  try {
    const saved = await saveConfig((next) => {
      for (const provider of next.providers) {
        const rows = choices.filter((choice) => choice.provider === provider.name)
        if (!rows.length) continue
        const fetched = new Set(rows.map((row) => row.id))
        const selectedSet = new Set(rows.filter((row) => row.checked).map((row) => row.id))
        const known = new Map((provider.models ?? []).map((model) => [model.id, model]))
        const ids = (provider.models ?? [])
          .map((model) => model.id)
          .filter((id) => !fetched.has(id) || selectedSet.has(id))
        const present = new Set(ids)
        for (const row of rows) {
          if (!row.checked || present.has(row.id)) continue
          present.add(row.id)
          ids.push(row.id)
        }
        provider.models = ids.map((id) => known.get(id) ?? { id })
      }
    })
    if (!saved) return
    set(globalModelsOpen, false)
    set(globalModelChoices, [])
    set(globalModelErrors, [])
    set(message, `Made ${selected.length} model${selected.length === 1 ? '' : 's'} available.`)
  } finally {
    set(globalModelsSaving, false)
  }
}

// Route target editor variant of the cross-provider pull: fetch every provider,
// then offer the models that are not saved to their provider yet as extra target
// choices. Ticking one adds it as a target; saving the route also writes it into
// that provider's model list, so there is no second list to reconcile.
async function fetchRouteModels() {
  set(error, '')
  set(message, '')
  set(globalModelsFetching, true)
  try {
    const result = await plugin.request('router.discoverAllModels', {})
    const existing = new Set<string>()
    for (const provider of read(providers)) {
      for (const model of provider.models ?? []) existing.add(`${provider.name}\u0000${model}`)
    }
    const fetched: ModelTarget[] = []
    const seen = new Set<string>()
    let total = 0
    let failed = 0
    for (const entry of result.providers) {
      if (entry.error) failed++
      for (const raw of entry.models) {
        const id = raw.trim()
        if (!id) continue
        const key = `${entry.provider}\u0000${id}`
        if (seen.has(key)) continue
        seen.add(key)
        total++
        if (existing.has(key)) continue
        fetched.push({ provider: entry.provider, model: id })
      }
    }
    set(routeFetchedModels, fetched)
    set(
      message,
      fetched.length
        ? `Found ${total} models; ${fetched.length} not saved yet — tick them to add and save.`
        : `Found ${total} models, all already available${failed ? ` (${failed} provider(s) unreachable)` : ''}.`
    )
  } catch (cause) {
    set(error, `Search models failed: ${(cause as Error).message}`)
  } finally {
    set(globalModelsFetching, false)
  }
}

type ParsedModelLine = { id: string; contextWindow?: number; maxOutput?: number }

// A model line is `id`, or `id | contextWindow | maxOutput` for providers whose
// /v1/models response does not expose limits. The extra columns are optional
// and stored on the model entry, which takes precedence over discovery data.
function parseModelLines(text: string): ParsedModelLine[] {
  const entries: ParsedModelLine[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/[\n,]/)) {
    const line = raw.trim()
    if (!line) continue
    const [idPart, contextPart, outputPart] = line.split('|').map((part) => part.trim())
    const id = idPart ?? ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const contextWindow = Number.parseInt(contextPart ?? '', 10)
    const maxOutput = Number.parseInt(outputPart ?? '', 10)
    entries.push({
      id,
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
      ...(Number.isFinite(maxOutput) && maxOutput > 0 ? { maxOutput } : {})
    })
  }
  return entries
}

function modelTextIds(text: string) {
  return parseModelLines(text).map((entry) => entry.id)
}

function formatModelLines(models: { id: string; contextWindow?: number; maxOutput?: number }[] | undefined) {
  return (models ?? [])
    .map((model) => {
      if (!model.contextWindow && !model.maxOutput) return model.id
      return [model.id, model.contextWindow ?? '', model.maxOutput ?? ''].join(' | ').trim()
    })
    .join('\n')
}

// Fill the custom provider's model textarea from its endpoint. The form is not
// saved yet, so the base URL, protocols and (optional) key come straight from
// the fields. The fetched list lands in the picker first.
async function fetchCustomModels() {
  const endpoint = read(customEndpoints)[0]
  const baseUrl = endpoint?.baseUrl.trim() ?? ''
  if (!baseUrl) {
    set(error, 'Add a base URL before fetching models')
    return
  }
  const protocols = endpoint.protocols
  set(error, '')
  set(message, '')
  set(fetchingModels, true)
  try {
    const keyValue = read(customKeys)
      .map((draft) => draft.value.trim())
      .find(Boolean)
    const result = await plugin.request('router.discoverModels', {
      baseUrl,
      protocols,
      ...(keyValue ? { value: keyValue } : {})
    })
    openModelPicker('custom', result.models, modelTextIds(read(customModels)))
    set(message, `Found ${result.models.length} model${result.models.length === 1 ? '' : 's'}. Pick which to save.`)
  } catch (cause) {
    set(error, `Fetch models failed: ${(cause as Error).message}`)
  } finally {
    set(fetchingModels, false)
  }
}

// Fill the provider edit model textarea from the saved provider (its endpoint
// and enabled key). Nothing is persisted until Save changes.
async function fetchEditModels(name: string) {
  set(error, '')
  set(message, '')
  set(fetchingModels, true)
  try {
    const result = await plugin.request('router.discoverModels', { provider: name })
    openModelPicker(`edit:${name}`, result.models, modelTextIds(read(providerEditModels)))
    set(
      message,
      `Found ${result.models.length} model${result.models.length === 1 ? '' : 's'} for ${name}. Pick which to save.`
    )
  } catch (cause) {
    set(error, `Fetch models failed: ${(cause as Error).message}`)
  } finally {
    set(fetchingModels, false)
  }
}

function usageMeterSummary(meters: ProviderUsageMeter[]) {
  return meters
    .map((meter) => {
      const value = meter.remaining ?? meter.used ?? meter.limit
      return `${meter.label ?? meter.id ?? 'meter'}: ${value ?? 'n/a'} ${meter.unit ?? ''}`.trim()
    })
    .join('; ')
}

async function fetchUsage(name: string) {
  set(error, '')
  set(message, '')
  set(usageBusy, name)
  set(usageNote, null)
  set(usageDetected, null)
  try {
    const result = await plugin.request('router.keyUsage', { provider: name, refresh: true })
    const report = result.providers.find((item) => item.provider === name)
    if (report?.keys.length) {
      const current = read(keyQuotaReports)
      set(keyQuotaReports, [...current.filter((item) => item.provider !== name), report])
      lastKeyQuotaRefresh = Date.now()
      const summary = report.keys
      .map((key) => {
        const meters = usageMeterSummary(key.meters)
        if (!meters) return ''
        return report.keys.length > 1 ? `${key.id || key.secretKey}: ${meters}` : meters
      })
      .filter(Boolean)
      .join('; ')
    const errors = report.keys.flatMap((key) => key.errors)
      set(usageNote, {
        provider: name,
        text: summary || (errors.length ? `Usage failed: ${errors[0].message}` : 'Usage: no meters returned'),
        tone: summary ? 'success' : 'danger'
      })
      return
    }
    if (report?.reason === 'no-keys') {
      set(usageNote, { provider: name, text: 'Add a key to read provider usage.', tone: 'neutral' })
      return
    }
    if (report?.reason === 'error') {
      set(usageNote, { provider: name, text: 'Usage failed: the endpoint could not be read.', tone: 'danger' })
      return
    }
    // No saved connector: try a few well-known balance endpoints once, using
    // the provider key. Nothing is saved until the user accepts the result.
    const probe = await plugin.request('router.usageProbe', { provider: name })
    if (probe.ok && probe.meters?.length) {
      const secretKey = probe.secretKey ?? ''
      if (secretKey) {
        const current = read(keyQuotaReports).filter((item) => item.provider !== name)
        set(keyQuotaReports, [
          ...current,
          {
            provider: name,
            keys: [{
              id: 'detected',
              secretKey,
              enabled: true,
              status: 'ok',
              meters: probe.meters,
              errors: [] as { message: string }[],
              fetchedAt: Date.now()
            }]
          }
        ])
      }
      if (probe.connector) {
        set(usageDetected, { provider: name, endpoint: probe.endpoint ?? probe.connector.endpoint, connector: probe.connector })
      }
      // Keep the detected bars visible until the user saves or dismisses them;
      // the periodic quota refresh would otherwise replace the list.
      lastKeyQuotaRefresh = Date.now()
      set(usageNote, {
        provider: name,
        text: `Detected ${usageMeterSummary(probe.meters)} from ${probe.endpoint}. Save it to keep it.`,
        tone: 'success'
      })
      return
    }
    const tried = probe.tried?.length ?? 0
    set(usageNote, {
      provider: name,
      text: probe.reason === 'no-keys'
        ? 'Add a key to read provider usage.'
        : `No usage source found${tried ? ` after trying ${tried} endpoint${tried === 1 ? '' : 's'}` : ''}.`,
      tone: 'neutral',
      action: probe.reason === 'no-keys' ? undefined : 'configure'
    })
  } catch (cause) {
    set(usageNote, { provider: name, text: `Usage failed: ${(cause as Error).message}`, tone: 'danger' })
  } finally {
    set(usageBusy, '')
  }
}

// Protocols an edited provider can expose. Kept in sync with the outbound
// translation layer in worker/sidecar.mjs.
const EDIT_PROTOCOLS = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'responses', label: 'Responses' },
  { id: 'gemini', label: 'Gemini' }
]

// Shared section shell for the Add provider and Edit provider forms so both
// read the same way: bold title, small inline description, grouped fields.
function FormGroup({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: WithChildren['children']
}) {
  return (
    <Box background="muted" radius="md" padding="sm">
      <Stack gap="sm">
        <Row gap="xs" wrap align="center">
          <Text size="sm" weight="semibold">
            {title}
          </Text>
          {description ? (
            <Text size="xs" muted>
              {description}
            </Text>
          ) : null}
        </Row>
        {children}
      </Stack>
    </Box>
  )
}

function ProtocolChips({
  active,
  onToggle
}: {
  active: (id: string) => boolean
  onToggle: (id: string, next: boolean) => void
}) {
  return (
    <Row gap="none" wrap>
      {EDIT_PROTOCOLS.map((protocol) => {
        const on = active(protocol.id)
        return (
          <Button
            key={protocol.id}
            size="xs"
            variant="ghost"
            tone={on ? 'accent' : undefined}
            onPress={() => onToggle(protocol.id, !on)}
          >
            {on ? `✓ ${protocol.label}` : protocol.label}
          </Button>
        )
      })}
    </Row>
  )
}

// Endpoint rows shown in the provider editor. Imported configs often repeat the
// same base URL once per protocol, so group by URL and union the protocols to
// keep the form readable; saving writes one endpoint per URL.
function canonicalProtocol(protocol: string) {
  const normalized = protocol.toLowerCase().replace(/[-_]/g, '_')
  if (normalized.includes('anthropic')) return 'anthropic'
  if (normalized.includes('responses')) return 'responses'
  if (normalized.includes('gemini') || normalized.includes('google')) return 'gemini'
  if (normalized.includes('openai') || normalized.includes('chat')) return 'openai'
  return protocol
}

function editEndpointsFor(
  cfg: ProviderConfig | undefined,
  fallback: { baseUrl: string; protocols: string[] }
): { baseUrl: string; protocols: string[] }[] {
  const source = cfg?.endpoints?.length
    ? cfg.endpoints
    : [{ baseUrl: cfg?.baseUrl ?? fallback.baseUrl, protocols: cfg?.protocols ?? fallback.protocols }]
  const grouped = new Map<string, Set<string>>()
  for (const endpoint of source) {
    const baseUrl = (endpoint.baseUrl ?? '').trim()
    if (!baseUrl) continue
    const protocols = grouped.get(baseUrl) ?? new Set<string>()
    for (const protocol of endpoint.protocols ?? []) protocols.add(canonicalProtocol(protocol))
    grouped.set(baseUrl, protocols)
  }
  return [...grouped].map(([baseUrl, protocols]) => ({ baseUrl, protocols: [...protocols] }))
}

function updateCustomEndpoint(index: number, patch: Partial<{ baseUrl: string; protocols: string[] }>) {
  set(customEndpoints, read(customEndpoints).map((endpoint, position) => (position === index ? { ...endpoint, ...patch } : endpoint)))
}

function toggleCustomEndpointProtocol(index: number, protocol: string, checked: boolean) {
  const endpoint = read(customEndpoints)[index]
  if (!endpoint) return
  const protocols = checked
    ? [...endpoint.protocols.filter((item) => item !== protocol), protocol]
    : endpoint.protocols.filter((item) => item !== protocol)
  updateCustomEndpoint(index, { protocols })
}

function updateEditEndpoint(index: number, patch: Partial<{ baseUrl: string; protocols: string[] }>) {
  set(
    providerEditEndpoints,
    read(providerEditEndpoints).map((endpoint, position) => (position === index ? { ...endpoint, ...patch } : endpoint))
  )
}

function toggleEditEndpointProtocol(index: number, protocol: string, checked: boolean) {
  const endpoint = read(providerEditEndpoints)[index]
  if (!endpoint) return
  const protocols = checked
    ? [...endpoint.protocols.filter((item) => item !== protocol), protocol]
    : endpoint.protocols.filter((item) => item !== protocol)
  updateEditEndpoint(index, { protocols })
}

function startEditProvider(provider: ProviderView) {
  const cfg = configProvider(provider.name)
  const connector = cfg?.usageFetch?.connectors?.[0]
  closeModelPicker()
  set(providerEditFor, provider.name)
  set(providerEditDisplayName, cfg?.displayName ?? provider.displayName ?? '')
  set(providerEditEndpoints, editEndpointsFor(cfg, provider))
  set(providerEditModels, formatModelLines(cfg?.models))
  set(usageDraft, {
    endpoint: connector?.endpoint ?? '',
    auth: connector?.auth === 'none' ? 'none' : 'provider-api-key',
    meters: connector?.mapping?.meters?.length ? JSON.stringify(connector.mapping.meters, null, 2) : ''
  })
  set(usageDetected, null)
}

async function saveUsageSource(name: string) {
  const draft = read(usageDraft)
  const endpoint = draft.endpoint.trim()
  if (!/^https?:\/\//i.test(endpoint)) {
    set(error, 'Usage endpoint must start with http:// or https://')
    return
  }
  let meters: unknown
  try {
    meters = JSON.parse(draft.meters || '[]')
  } catch {
    set(error, 'Meters must be valid JSON')
    return
  }
  if (!Array.isArray(meters) || !meters.length) {
    set(error, 'Add at least one meter mapping')
    return
  }
  set(error, '')
  try {
    await plugin.request('router.provider.usage', {
      provider: name,
      usageFetch: {
        enabled: true,
        connectors: [{
          id: 'custom',
          type: 'http-json',
          endpoint,
          auth: draft.auth === 'none' ? 'none' : 'provider-api-key',
          mapping: { meters: meters as UsageMeterMapping[] }
        }]
      }
    })
    set(usageDetected, null)
    await refresh()
    await fetchUsage(name)
    set(message, 'Usage source saved')
  } catch (cause) {
    set(error, `Usage source failed: ${(cause as Error).message}`)
  }
}

async function clearUsageSource(name: string) {
  set(error, '')
  try {
    await plugin.request('router.provider.usage', { provider: name, usageFetch: null })
    set(keyQuotaReports, read(keyQuotaReports).filter((item) => item.provider !== name))
    set(usageDetected, null)
    await refresh()
    set(usageNote, { provider: name, text: 'Usage source removed.', tone: 'neutral' })
  } catch (cause) {
    set(error, `Usage source failed: ${(cause as Error).message}`)
  }
}

async function saveDetectedUsage(name: string) {
  const detected = read(usageDetected)
  if (!detected || detected.provider !== name) return
  set(error, '')
  try {
    await plugin.request('router.provider.usage', {
      provider: name,
      usageFetch: { enabled: true, connectors: [detected.connector] }
    })
    set(usageDetected, null)
    await refresh()
    await fetchUsage(name)
    set(message, 'Usage source saved')
  } catch (cause) {
    set(error, `Usage source failed: ${(cause as Error).message}`)
  }
}

async function saveProviderEdit(name: string) {
  const cfg = configProvider(name)
  const endpoints = read(providerEditEndpoints)
    .map((endpoint) => ({
      baseUrl: endpoint.baseUrl.trim().replace(/\/+$/, ''),
      protocols: [...new Set(endpoint.protocols.filter(Boolean))]
    }))
    .filter((endpoint) => endpoint.baseUrl)
  if (!endpoints.length) {
    set(error, 'Provider needs a base URL')
    return
  }
  if (!endpoints.some((endpoint) => endpoint.protocols.length)) {
    set(error, 'Enable at least one protocol')
    return
  }
  // Keep description/pricing on models that survive the edit. The optional
  // `| context | output` columns override what discovery cached, and omitting
  // them clears a previous override.
  const known = new Map((cfg?.models ?? []).map((model) => [model.id, model]))
  const models = parseModelLines(read(providerEditModels)).map(({ id, contextWindow, maxOutput }) => {
    const entry = { ...(known.get(id) ?? { id }), id }
    if (contextWindow) entry.contextWindow = contextWindow
    else delete entry.contextWindow
    if (maxOutput) entry.maxOutput = maxOutput
    else delete entry.maxOutput
    return entry
  })
  const displayName = read(providerEditDisplayName).trim()
  const protocols = [...new Set(endpoints.flatMap((endpoint) => endpoint.protocols))]
  set(error, '')
  set(message, '')
  const saved = await saveConfig((next) => {
    const provider = next.providers.find((item) => item.name === name)
    if (!provider) return
    provider.baseUrl = endpoints[0].baseUrl
    provider.endpoints = endpoints
    provider.protocols = protocols
    provider.models = models
    if (displayName) provider.displayName = displayName
    else delete provider.displayName
  })
  if (saved) {
    set(providerEditFor, '')
    set(message, `Updated provider ${name}`)
  }
}

// ---------------------------------------------------------------------------
// Routing rules and aliases
// ---------------------------------------------------------------------------
function splitModelList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

// Filter text is a set of words that must all appear, in any order. So
// "deepseek 1017" matches both "deepseek/deepseek-1017" and
// "1017/deepseek-chat", which a single substring test would miss.
function matchesFilter(text: string, filter: string): boolean {
  const tokens = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return true
  const haystack = text.toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

function providerNameSet(): Set<string> {
  return new Set(read(providers).map((provider) => provider.name))
}

function parseChainRows(models: string[] | undefined): ChainRow[] {
  const names = providerNameSet()
  return (models ?? [])
    .map((entry) => {
      const text = String(entry ?? '').trim()
      const slash = text.indexOf('/')
      if (slash > 0) {
        const provider = text.slice(0, slash)
        const model = text.slice(slash + 1)
        if (names.has(provider)) return newChainRow(provider, model)
        return newChainRow(ANY_PROVIDER, text)
      }
      if (names.has(text)) return newChainRow(text, '')
      return newChainRow(ANY_PROVIDER, text)
    })
    .filter((row) => (row.provider === ANY_PROVIDER ? row.model !== '' : row.provider !== ''))
}

function disabledProviderNames(): Set<string> {
  return new Set(
    (read(config)?.providers ?? [])
      .filter((provider) => provider.enabled === false)
      .map((provider) => provider.name)
  )
}

type ChainTarget = { provider: string; model: string; entry: string; duplicate: boolean }
type ChainWarning = { entry: string; message: string }
type ChainPreview = { targets: ChainTarget[]; warnings: ChainWarning[]; primaryKnown: boolean }

// Mirrors resolveRouteTarget() in worker/sidecar.mjs so the editor can show
// what the worker will do without a round trip on every keystroke. Resolution is
// strict: an unknown provider prefix or an unlisted bare model resolves to
// nothing instead of being sent to some default provider.
function resolveChainTarget(
  selector: string,
  fallbackModel: string,
  list: ProviderView[],
  aliasMap: Record<string, string>,
  disabled: Set<string>
): ChainTarget | null {
  if (!selector) return null
  const byName = new Map(list.map((provider) => [provider.name, provider]))
  const text = aliasMap[selector] ?? selector
  const slash = text.indexOf('/')
  if (slash > 0) {
    const provider = byName.get(text.slice(0, slash))
    if (!provider) return null
    return { provider: provider.name, model: text.slice(slash + 1), entry: selector, duplicate: false }
  }
  const owner = list.find((provider) => !disabled.has(provider.name) && (provider.models ?? []).includes(text))
  if (owner) return { provider: owner.name, model: text, entry: selector, duplicate: false }
  const named = byName.get(text)
  if (named) return { provider: named.name, model: fallbackModel, entry: selector, duplicate: false }
  return null
}

function previewChain(
  primaryModel: string,
  rows: ChainRow[],
  list: ProviderView[],
  aliasMap: Record<string, string>,
  disabled: Set<string>
): ChainPreview {
  const byName = new Map(list.map((provider) => [provider.name, provider]))
  const targets: ChainTarget[] = []
  const warnings: ChainWarning[] = []
  const seen = new Set<string>()

  const primary = resolveChainTarget(primaryModel, '', list, aliasMap, disabled)
  // A provider-only target reuses the first concrete model in the route, just
  // like the worker's chain builder.
  const bare = primary?.model ?? rows
    .map((row) => {
      const text = row.model.trim()
      if (!text) return ''
      const entry = row.provider === ANY_PROVIDER ? text : `${row.provider}/${text}`
      return resolveChainTarget(entry, '', list, aliasMap, disabled)?.model ?? ''
    })
    .find((model) => model)
    ?? primaryModel
  if (primary) {
    seen.add(`${primary.provider}/${primary.model}`)
    targets.push(primary)
    if (disabled.has(primary.provider)) {
      warnings.push({ entry: primaryModel, message: `${primary.provider} is disabled; requests will not reach it.` })
    }
  }

  for (const row of rows) {
    const model = row.model.trim()
    const entry = row.provider === ANY_PROVIDER ? model : model ? `${row.provider}/${model}` : row.provider
    if (!entry) {
      warnings.push({ entry: '(empty)', message: 'An empty target is skipped.' })
      continue
    }
    if (row.provider !== ANY_PROVIDER) {
      const provider = byName.get(row.provider)
      if (!provider) {
        warnings.push({ entry, message: `Provider "${row.provider}" is not configured; this target is skipped.` })
      } else {
        if (disabled.has(row.provider)) {
          warnings.push({ entry, message: `${provider.displayName || provider.name} is disabled.` })
        }
        if (model && !(provider.models ?? []).includes(model)) {
          warnings.push({
            entry,
            message: `"${model}" is not in ${provider.displayName || provider.name}'s model list. It will still be sent.`
          })
        }
      }
    } else {
      const slash = model.indexOf('/')
      if (slash > 0) {
        if (!byName.has(model.slice(0, slash))) {
          warnings.push({
            entry,
            message: `Provider "${model.slice(0, slash)}" is not configured; this target is skipped.`
          })
        }
      } else if (!aliasMap[model] && !list.some((provider) => !disabled.has(provider.name) && (provider.models ?? []).includes(model))) {
        warnings.push({ entry, message: `No provider lists "${model}"; this target is skipped.` })
      }
    }

    const target =
      row.provider !== ANY_PROVIDER && !model
        ? byName.get(row.provider)
          ? { provider: row.provider, model: bare, entry, duplicate: false }
          : null
        : resolveChainTarget(entry, bare, list, aliasMap, disabled)
    if (!target) {
      warnings.push({ entry, message: 'No provider could be resolved for this entry.' })
      continue
    }
    if (!target.model) {
      warnings.push({ entry, message: 'This target has no model and no earlier target to reuse; it is skipped.' })
      continue
    }
    if (row.provider === ANY_PROVIDER && aliasMap[model]) {
      target.entry = `${model} → ${aliasMap[model]}`
    }
    const key = `${target.provider}/${target.model}`
    if (seen.has(key)) {
      targets.push({ ...target, duplicate: true })
      continue
    }
    seen.add(key)
    targets.push(target)
  }

  return { targets, warnings, primaryKnown: Boolean(primary) }
}

// Routes are the primary failover unit. Legacy `aliases` entries are
// shown as one-target routes so an existing config keeps working and
// migrates the first time it is edited.
function mergedRoutes(): ModelRoute[] {
  const routes = (read(config)?.routes ?? []).map((route) => ({
    ...route,
    targets: [...(route.targets ?? [])]
  }))
  const names = new Set(routes.map((route) => route.name))
  for (const [name, target] of Object.entries(read(aliases))) {
    if (names.has(name)) continue
    const row = parseChainRows([target])[0]
    const modelTarget: ModelTarget = row
      ? row.provider === ANY_PROVIDER
        ? { provider: '', model: row.model }
        : { provider: row.provider, model: row.model }
      : { provider: '', model: target }
    routes.push({ name, targets: [modelTarget], strategy: 'ordered', enabled: true })
    names.add(name)
  }
  return routes
}

// Reading a derived atom subscribes to the atoms mergedRoutes() reads, so the
// four panels that render the route list share one computation per change.
const mergedRoutesView = derived(() => mergedRoutes())

function routeTargetsToRows(targets: ModelTarget[]): ChainRow[] {
  return parseChainRows(targets.map((target) => (target.provider ? `${target.provider}/${target.model}` : target.model)))
}

function routeTargetsFromRows(rows: ChainRow[]): ModelTarget[] {
  const targets: ModelTarget[] = []
  for (const row of rows) {
    if (row.provider === ANY_PROVIDER) {
      const text = row.model.trim()
      if (!text) continue
      const slash = text.indexOf('/')
      targets.push(slash > 0
        ? { provider: text.slice(0, slash), model: text.slice(slash + 1) }
        : { provider: '', model: text })
      continue
    }
    const model = row.model.trim()
    if (row.provider && model) targets.push({ provider: row.provider, model })
  }
  return targets
}

function routeTargetWarnings(rows: ChainRow[]): string[] {
  return rows
    .filter((row) => row.provider !== ANY_PROVIDER && row.provider && !row.model.trim())
    .map((row) => `${row.provider}/ has no model; choose one or remove the target.`)
}

function chainRowTarget(row: ChainRow): ModelTarget {
  if (row.provider === ANY_PROVIDER) {
    const text = row.model.trim()
    if (!text) return { provider: '', model: '' }
    const slash = text.indexOf('/')
    return slash > 0
      ? { provider: text.slice(0, slash), model: text.slice(slash + 1) }
      : { provider: '', model: text }
  }
  return { provider: row.provider, model: row.model.trim() }
}

function targetIdentity(target: ModelTarget): string {
  return `${target.provider}\u0000${target.model}`
}

type TargetChoice = { target: ModelTarget; checked: boolean; custom: boolean; fetched: boolean }

// Every provider/model pair, plus any freshly fetched models still to save, plus
// any custom target already in the route, so a route's targets can be picked from
// one searchable list instead of row by row.
function routeTargetChoices(rows: ChainRow[], list: ProviderView[], fetched: ModelTarget[] = []): TargetChoice[] {
  const choices: TargetChoice[] = []
  const index = new Map<string, TargetChoice>()
  const add = (target: ModelTarget, custom: boolean, fetchedFlag = false) => {
    if (!target.provider && !target.model) return
    const key = targetIdentity(target)
    const existing = index.get(key)
    if (existing) {
      if (!custom) existing.custom = false
      if (fetchedFlag) existing.fetched = true
      return
    }
    const choice: TargetChoice = { target, checked: false, custom, fetched: fetchedFlag }
    index.set(key, choice)
    choices.push(choice)
  }
  for (const target of fetched) add(target, false, true)
  for (const provider of list) {
    for (const model of provider.models ?? []) add({ provider: provider.name, model }, false)
  }
  for (const row of rows) add(chainRowTarget(row), true)
  const checked = new Set(rows.map((row) => targetIdentity(chainRowTarget(row))))
  for (const choice of choices) choice.checked = checked.has(targetIdentity(choice.target))
  return choices
}

function routeTargetSummary(route: ModelRoute): string {
  const labels = (route.targets ?? [])
    .map((target) => (target.provider ? `${target.provider}/${target.model || '…'}` : target.model))
    .filter(Boolean)
  // Keep the list-row summary short so the row actions (edit/delete) stay visible.
  const MAX_SHOWN = 2
  if (labels.length <= MAX_SHOWN) return labels.join(' → ')
  const rest = labels.length - MAX_SHOWN
  return `${labels.slice(0, MAX_SHOWN).join(' → ')} → +${rest} more`
}

async function saveRoute() {
  const name = read(routeName).trim()
  if (!name) {
    set(error, 'Route needs a name')
    return
  }
  const rows = read(routeTargets)
  if (routeTargetWarnings(rows).length) {
    set(error, routeTargetWarnings(rows).join(' ') || 'Choose a model for every target')
    return
  }
  const targets = routeTargetsFromRows(rows)
  if (!targets.length) {
    set(error, 'Add at least one provider/model target')
    return
  }
  const previous = read(routeEditName)
  const existing = mergedRoutes().find((route) => route.name === (previous || name))
  const retriesInput = Number(read(routeRetries))
  const retries = Number.isFinite(retriesInput) ? Math.max(0, Math.min(20, Math.floor(retriesInput))) : 2
  // Targets pulled from an endpoint in this form that aren't saved to their
  // provider yet: picking one also makes it available under Providers.
  const fetchedKeys = new Set(read(routeFetchedModels).map(targetIdentity))
  const route: ModelRoute = {
    name,
    targets,
    strategy: read(routeFastest) ? 'fastest' : 'ordered',
    enabled: existing?.enabled ?? true,
    retries,
    ...(read(routeVpn) ? { vpn: read(routeVpn) } : {})
  }
  const saved = await saveConfig((next) => {
    next.routes = [...(next.routes ?? [])]
    if (previous && previous !== name) {
      next.routes = next.routes.filter((entry) => entry.name !== previous)
    }
    const index = next.routes.findIndex((entry) => entry.name === name)
    if (index >= 0) next.routes[index] = route
    else next.routes.push(route)
    if (next.aliases) {
      delete next.aliases[name]
      if (previous && previous !== name) delete next.aliases[previous]
    }
    if (fetchedKeys.size) {
      for (const target of targets) {
        if (!target.provider || !target.model || !fetchedKeys.has(targetIdentity(target))) continue
        const provider = next.providers.find((item) => item.name === target.provider)
        if (!provider) continue
        const models = [...(provider.models ?? [])]
        if (!models.some((model) => model.id === target.model)) models.push({ id: target.model })
        provider.models = models
      }
    }
  })
  if (saved) {
    resetRouteForm()
    set(message, `Saved route ${name}`)
  }
}

function startEditRoute(route: ModelRoute) {
  set(routeEditName, route.name)
  set(routeName, route.name)
  set(routeTargets, routeTargetsToRows(route.targets))
  set(routeFetchedModels, [])
  set(routeTargetFilter, '')
  set(routeFastest, route.strategy !== 'ordered')
  set(routeRetries, String(route.retries ?? 2))
  set(routeVpn, route.vpn ?? '')
  set(routeOpen, true)
}

function resetRouteForm() {
  set(routeOpen, false)
  set(routeName, '')
  set(routeTargets, [])
  set(routeFetchedModels, [])
  set(routeTargetFilter, '')
  set(routeFastest, true)
  set(routeRetries, '2')
  set(routeVpn, '')
  set(routeEditName, '')
}

async function removeRoute(name: string) {
  const saved = await saveConfig((next) => {
    next.routes = (next.routes ?? []).filter((route) => route.name !== name)
    if (next.aliases) delete next.aliases[name]
  })
  if (!saved) return
  if (read(routeEditName) === name) resetRouteForm()
  set(message, `Deleted route ${name}`)
}

async function addPolicy() {
  const name = read(policyName).trim()
  const matchAll = read(policyMatchAll)
  const field = read(policyField).trim()
  const value = read(policyValue)
  if (!matchAll && (!field || !value)) {
    set(error, 'Policy needs a condition field and a value (or enable "Match all requests")')
    return
  }

  // Build the rewrite list. A row with no path is ignored unless it was
  // partially filled; operations other than delete need a value, and
  // array-replace also needs the element to match.
  const rewrites: PolicyRewrite[] = []
  const drafts = read(policyRewrites)
  for (let index = 0; index < drafts.length; index++) {
    const draft = drafts[index]
    const key = draft.key.trim()
    const operation = draft.operation || 'set'
    if (!key) {
      if (draft.value.trim() || draft.match.trim()) {
        set(error, `Rewrite ${index + 1} needs a path`)
        return
      }
      continue
    }
    const needsValue = operation !== 'delete'
    if (needsValue && !draft.value.trim()) {
      set(error, `Rewrite ${index + 1} needs a value`)
      return
    }
    const rewrite: PolicyRewrite = { key, operation: operation as PolicyRewrite['operation'] }
    if (needsValue) rewrite.value = parseMaybe(draft.value)
    if (operation === 'array-replace') {
      if (!draft.match.trim()) {
        set(error, `Rewrite ${index + 1} needs a match value`)
        return
      }
      rewrite.match = parseMaybe(draft.match)
    }
    rewrites.push(rewrite)
  }

  const model = read(policyModel).trim()
  const fallbackEntries = read(policyFallbackRaw)
    ? splitModelList(read(policyFallbackText))
    : read(policyFallback).map((entry) => entry.trim()).filter(Boolean)
  const fallback: FallbackPolicy = fallbackEntries.length
    ? { mode: 'provider-chain', models: fallbackEntries }
    : { mode: 'off' }
  const editIndex = read(policyEditIndex)
  const existing = editIndex >= 0 ? read(policies)[editIndex] : undefined
  const policy: RequestPolicy = {
    id: existing?.id ?? `policy-${Date.now().toString(36)}`,
    name: name || existing?.name || `Policy ${read(policies).length + 1}`,
    enabled: existing?.enabled ?? true,
    condition: matchAll
      ? null
      : { source: read(policySource) as PolicyCondition['source'], field, operator: read(policyOperator), value },
    ...(rewrites.length ? { rewrites } : {}),
    ...(model ? { model } : {}),
    fallback
  }
  const saved = await saveConfig((next) => {
    if (editIndex >= 0) next.policies[editIndex] = policy
    else next.policies.push(policy)
  })
  if (saved) resetPolicyForm()
}

function resetPolicyForm() {
  set(policyEditIndex, -1)
  set(policyOpen, false)
  set(policyName, '')
  set(policyMatchAll, false)
  set(policySource, 'request.body')
  set(policyField, 'model')
  set(policyOperator, 'starts-with')
  set(policyValue, 'claude-')
  set(policyModel, '')
  set(policyRewrites, [])
  set(policyFallback, [])
  set(policyFallbackRaw, false)
  set(policyFallbackText, '')
  set(policyFallbackFilter, '')
}

function addRewriteDraft() {
  set(policyRewrites, [...read(policyRewrites), blankRewriteDraft()])
}

function updateRewriteDraft(index: number, patch: Partial<RewriteDraft>) {
  update(policyRewrites, (drafts) => drafts.map((draft, position) => (position === index ? { ...draft, ...patch } : draft)))
}

function removeRewriteDraft(index: number) {
  update(policyRewrites, (drafts) => drafts.filter((_, position) => position !== index))
}

function startEditPolicy(index: number) {
  const policy = read(policies)[index]
  if (!policy) return
  set(policyEditIndex, index)
  set(policyName, policy.name)
  set(policyMatchAll, !policy.condition)
  set(policySource, policy.condition?.source ?? 'request.body')
  set(policyField, policy.condition?.field ?? 'model')
  set(policyOperator, policy.condition?.operator ?? 'starts-with')
  set(policyValue, policy.condition?.value ?? '')
  set(policyModel, policy.model ?? '')
  set(
    policyRewrites,
    (policy.rewrites ?? []).map((rewrite) => ({
      key: rewrite.key,
      operation: rewrite.operation ?? 'set',
      value: rewrite.value === undefined ? '' : typeof rewrite.value === 'string' ? rewrite.value : JSON.stringify(rewrite.value),
      match: rewrite.match === undefined ? '' : typeof rewrite.match === 'string' ? rewrite.match : JSON.stringify(rewrite.match)
    }))
  )
  const models = policy.fallback?.mode && policy.fallback.mode !== 'off' ? (policy.fallback.models ?? []) : []
  set(policyFallback, models)
  set(policyFallbackText, models.join(', '))
  set(policyFallbackRaw, false)
  set(policyFallbackFilter, '')
  set(policyOpen, true)
}

function cancelPolicyEdit() {
  resetPolicyForm()
}

async function removePolicy(index: number) {
  const saved = await saveConfig((next) => {
    next.policies.splice(index, 1)
  })
  if (!saved) return
  const editing = read(policyEditIndex)
  if (editing === index) set(policyEditIndex, -1)
  else if (editing > index) set(policyEditIndex, editing - 1)
}

async function togglePolicy(index: number, enabled: boolean) {
  await saveConfig((next) => {
    const policy = next.policies[index]
    if (policy) policy.enabled = enabled
  })
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
// An entry exists only when a person turns an agent off. Everything else routes
// by default, so enabling the gateway covers every agent Orca launches.
async function toggleAgent(route: AgentRoute, enabled: boolean) {
  await saveConfig((next) => {
    const index = next.agentProfiles.findIndex((profile) => profile.agent === route.agent)
    if (index >= 0) {
      next.agentProfiles[index].enabled = enabled
      next.agentProfiles[index].name = next.agentProfiles[index].name || route.name
      return
    }
    next.agentProfiles.push({ agent: route.agent, name: route.name, model: '', enabled })
  })
}

// ---------------------------------------------------------------------------
// Gateway client keys
// ---------------------------------------------------------------------------
async function createClientKey() {
  const name = read(clientKeyName).trim()
  const expires = read(clientKeyExpires).trim()
  const limitsText = read(clientKeyLimits).trim()
  set(error, '')
  set(message, '')
  set(createdKey, '')
  try {
    const result = await plugin.request('router.clientKeys.create', {
      ...(name ? { name } : {}),
      ...(expires ? { expiresAt: expires } : {}),
      ...(limitsText ? { limits: parseMaybe(limitsText) as Record<string, unknown> } : {})
    })
    set(createdKey, result.key)
    set(message, `Created gateway key ${result.id}. Copy it now — Orca stores only the secret.`)
    set(clientKeyName, '')
    set(clientKeyExpires, '')
    set(clientKeyLimits, '')
    set(clientKeyOpen, false)
    await refresh()
  } catch (cause) {
    set(error, `Create key failed: ${(cause as Error).message}`)
  }
}

async function revokeClientKey(id: string) {
  set(createdKey, '')
  try {
    await plugin.request('router.clientKeys.revoke', { id })
    set(message, `Revoked gateway key ${id}`)
    await refresh()
  } catch (cause) {
    set(error, `Revoke failed: ${(cause as Error).message}`)
  }
}

async function clearLogs() {
  set(error, '')
  set(message, '')
  try {
    await plugin.request('router.clearLogs', {})
    set(logs, [])
    set(pendingLogs, [])
    set(logExpanded, '')
    set(message, 'Request log cleared.')
  } catch (cause) {
    set(error, `Clear failed: ${(cause as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// Import and export
// ---------------------------------------------------------------------------
async function exportConfig() {
  set(error, '')
  set(message, '')
  try {
    const result = await plugin.request('router.config.export', {})
    set(message, `Config exported to ${result.file} (${result.json.length} bytes).`)
  } catch (cause) {
    set(error, `Export failed: ${(cause as Error).message}`)
  }
}

async function checkLocalRouters() {
  set(detectingLocal, true)
  try {
    const res = await plugin.request('router.config.detectLocal', {})
    set(detectedLocal, res)
  } catch {
    /* non-fatal */
  } finally {
    set(detectingLocal, false)
  }
}

async function importLocal(source: 'ccr' | 'omni' | 'both') {
  set(error, '')
  set(message, '')
  try {
    const result = await plugin.request('router.config.importLocal', { source, merge: read(importMerge) })
    const sourceLabel = source === 'both' ? 'both Claude Code Router and OmniRoute' : source === 'ccr' ? 'Claude Code Router' : 'OmniRoute'
    set(message, `Imported from ${sourceLabel}: ${result.providers} providers, ${result.aliases} aliases${result.merged ? ' (merged)' : ''}`)
    await refresh()
    await checkLocalRouters()
  } catch (cause) {
    set(error, `Import failed: ${(cause as Error).message}`)
  }
}

async function importPath() {
  const path = read(importPathText).trim()
  if (!path) {
    set(error, 'Enter a file path to import')
    return
  }
  set(error, '')
  set(message, '')
  try {
    const result = await plugin.request('router.config.import', { path, merge: read(importMerge) })
    set(message, `Imported ${result.importedFrom} config: ${result.providers} providers, ${result.aliases} aliases${result.merged ? ' (merged)' : ''}`)
    set(importPathText, '')
    await refresh()
  } catch (cause) {
    set(error, `Import failed: ${(cause as Error).message}`)
  }
}

async function importJson() {
  const json = read(importJsonText).trim()
  if (!json) {
    set(error, 'Paste a config JSON to import')
    return
  }
  set(error, '')
  set(message, '')
  try {
    const result = await plugin.request('router.config.import', { json, merge: read(importMerge) })
    set(message, `Imported ${result.importedFrom} config: ${result.providers} providers, ${result.aliases} aliases${result.merged ? ' (merged)' : ''}`)
    set(importJsonText, '')
    await refresh()
  } catch (cause) {
    set(error, `Import failed: ${(cause as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function conditionSummary(policy: RequestPolicy) {
  const condition = policy.condition
  if (!condition) return 'Always matches'
  return `${condition.source.replace('request.', '')} · ${condition.field} ${condition.operator.replace(/-/g, ' ')} ${condition.value}`
}

function rewriteSummary(policy: RequestPolicy) {
  const rewrites = policy.rewrites ?? []
  if (!rewrites.length) return 'Pass through'
  return rewrites
    .map((rewrite) => {
      const operation = rewrite.operation ?? 'set'
      const value =
        rewrite.value === undefined ? '(empty)' : typeof rewrite.value === 'string' ? rewrite.value : JSON.stringify(rewrite.value)
      if (operation === 'delete') return `${rewrite.key} → delete`
      if (operation === 'set') return `${rewrite.key} = ${value}`
      if (operation === 'array-replace') {
        const match =
          rewrite.match === undefined ? '(any)' : typeof rewrite.match === 'string' ? rewrite.match : JSON.stringify(rewrite.match)
        return `${rewrite.key}: replace ${match} → ${value}`
      }
      return `${rewrite.key}: ${operation} ${value}`
    })
    .join(', ')
}

function fallbackSummary(policy: RequestPolicy) {
  const fallback = policy.fallback
  if (!fallback || fallback.mode === 'off') return 'No fallback'
  if (fallback.mode === 'retry') return 'Retries the same target'
  return (fallback.models ?? []).join(' → ') || 'no fallback set'
}

function formatNumber(value: number) {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value)
}

function formatUsd(value: number) {
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

function tokenCount(entry: LogEntry) {
  if (!entry.tokens) return '—'
  return formatNumber(entry.tokens.input + entry.tokens.output)
}

function usageTone(utilization: number): Tone {
  if (utilization >= 1) return 'danger'
  if (utilization >= 0.8) return 'warning'
  return 'success'
}

function usagePercent(utilization: number) {
  return Math.round(Math.min(1, Math.max(0, utilization)) * 100)
}

function usageWindow(windowMs: number) {
  if (windowMs <= 60_000) return 'minute'
  if (windowMs <= 3_600_000) return 'hour'
  if (windowMs <= 86_400_000) return 'day'
  return `${Math.round(windowMs / 3_600_000)}h`
}

function usageField(field: string) {
  return field === 'maxRequests' ? 'requests' : field === 'maxTokens' ? 'tokens' : field
}

function formatUsageValue(value: number, unit?: string) {
  const normalized = unit?.toUpperCase()
  if (normalized === '%') return `${Number.isInteger(value) ? value : value.toFixed(1)}%`
  if (normalized === 'USD') return `$${value.toFixed(value < 0.01 ? 4 : 2)}`
  if (normalized === 'EUR') return `€${value.toFixed(value < 0.01 ? 4 : 2)}`
  if (normalized === 'CNY' || normalized === 'RMB') return `¥${value.toFixed(value < 0.01 ? 4 : 2)}`
  return unit ? `${formatNumber(value)} ${unit}` : formatNumber(value)
}

function providerMeterProgress(meter: ProviderUsageMeter) {
  const limit = typeof meter.limit === 'number' && Number.isFinite(meter.limit) && meter.limit > 0
    ? meter.limit
    : null
  if (limit == null) return null
  const used = typeof meter.used === 'number' && Number.isFinite(meter.used)
    ? meter.used
    : typeof meter.remaining === 'number' && Number.isFinite(meter.remaining)
      ? Math.max(0, limit - meter.remaining)
      : null
  if (used == null) return null
  return { used, limit, percent: usagePercent(used / limit) }
}

// Compact rate lines shown beside a key. The detailed bars stay below, but
// the header gets a single scan-friendly summary: local rolling usage first,
// then every provider window that has a usable used/limit pair. Returning them
// as a list keeps the header stacked when a provider reports several windows.
function keyRateLines(usage?: ProviderKeyUsage, quota?: KeyProviderUsage) {
  const lines: string[] = []
  if (usage) {
    const images = usage.images.day ? ` · ${formatNumber(usage.images.day)} img` : ''
    lines.push(`24h: ${formatNumber(usage.requests.day)} req · ${formatNumber(usage.tokens.day)} tok${images}`)
  }
  const meters = (quota?.meters ?? [])
    .map((meter) => ({ meter, progress: providerMeterProgress(meter) }))
    .filter((entry) => entry.progress)
    .sort((a, b) => (b.progress!.used / b.progress!.limit) - (a.progress!.used / a.progress!.limit))
  for (const { meter, progress } of meters) {
    if (!progress) continue
    const label = meter.label ?? meter.id ?? 'Quota'
    lines.push(`${label}: ${progress.percent}%`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('router.log', ({ entry }) => {
      if (read(logLive)) update(logs, (list) => [...list.slice(-99), entry])
      else update(pendingLogs, (list) => [...list.slice(-99), entry])
    })
  )
  // Poll status occasionally so a worker-side restart while the panel is open
  // doesn't leave the badge stale. Avoid heavy filesystem detection on every poll.
  let refreshInFlight = false
  const runRefresh = async () => {
    if (refreshInFlight) return
    refreshInFlight = true
    try { await refresh() } finally { refreshInFlight = false }
  }
  const poll = setInterval(() => void runRefresh(), 5000)
  ctx.subscriptions.push({ dispose: () => clearInterval(poll) })
  ctx.subscriptions.push({
    dispose: () => {
      for (const timer of webchatPollTimers.values()) clearTimeout(timer)
      webchatPollTimers.clear()
    }
  })
  lastKeyQuotaRefresh = 0
  void runRefresh()
  void refreshWebchat()
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------
function SectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <Stack gap="xs">
      <Heading level={2}>{title}</Heading>
      {description ? (
        <Text muted size="sm">
          {description}
        </Text>
      ) : null}
    </Stack>
  )
}

function EndpointTile({ label, value }: { label: string; value: string }) {
  return (
    <Box background="muted" radius="md" padding="sm">
      <Stack gap="xs">
        <Text muted size="xs">
          {label}
        </Text>
        <Text size="sm" weight="medium" truncate>
          {value}
        </Text>
      </Stack>
    </Box>
  )
}

// A quiet naming control: shows the value that will actually be saved, with an
// edit icon that reveals an input. Used for the optional provider name and key
// secret name, which default from the preset or provider name.
function InlineNameField({
  label,
  value,
  placeholder,
  editing,
  onEdit,
  onChange
}: {
  label: string
  value: string
  placeholder: string
  editing: boolean
  onEdit: () => void
  onChange: (value: string) => void
}) {
  if (editing) {
    return <Input label={label} placeholder={placeholder} value={value} onChange={onChange} />
  }
  return (
    <Row justify="between" align="center" gap="sm">
      <Text size="sm" muted truncate>
        {label}: {value}
      </Text>
      <IconButton size="xs" icon="edit" label={`Edit ${label.toLowerCase()}`} tooltip={`Edit ${label.toLowerCase()}`} onPress={onEdit} />
    </Row>
  )
}

// A repeatable key row for the add-provider forms. Mirrors the provider card's
// pool editor: paste a key, see what it will be saved as, and open Options to
// name it or set priority/limits.
function KeyDraftRows({
  drafts,
  taken,
  onChange,
  onRemove
}: {
  drafts: KeyDraft[]
  taken: Set<string>
  onChange: (index: number, patch: Partial<KeyDraft>) => void
  onRemove: (index: number) => void
}) {
  const names = draftKeyNames(drafts, taken)
  return (
    <>
      {drafts.map((draft, index) => (
        <Box key={index} background="muted" radius="md" padding="sm">
          <Stack gap="sm">
            <Input
              label="API key"
              type="password"
              placeholder="sk-..."
              value={draft.value}
              onChange={(value) => onChange(index, { value })}
            />
            <Row justify="between" align="center" gap="sm" wrap>
              <Text muted size="xs" truncate>
                Saved as: {names[index]}
              </Text>
              <Row gap="xs" align="center">
                <Button size="xs" variant="ghost" onPress={() => onChange(index, { open: !draft.open })}>
                  {draft.open ? 'Hide options' : 'Options'}
                </Button>
                {drafts.length > 1 ? (
                  <IconButton
                    size="xs"
                    icon="delete"
                    label={`Remove key ${index + 1}`}
                    tooltip="Remove this key"
                    onPress={() => onRemove(index)}
                  />
                ) : null}
              </Row>
            </Row>
            {draft.open ? (
              <Stack gap="sm">
                <Input
                  label="Key name"
                  placeholder={names[index]}
                  value={draft.name}
                  onChange={(value) => onChange(index, { name: value })}
                />
                <Input
                  label="Priority"
                  placeholder="0"
                  value={draft.priority}
                  onChange={(value) => onChange(index, { priority: value })}
                />
                <Input
                  label="Weight"
                  placeholder="1"
                  value={draft.weight}
                  onChange={(value) => onChange(index, { weight: value })}
                />
                <Input
                  label="Limits JSON"
                  placeholder='{"rpm":60,"rpd":1000}'
                  value={draft.limits}
                  onChange={(value) => onChange(index, { limits: value })}
                />
              </Stack>
            ) : null}
          </Stack>
        </Box>
      ))}
    </>
  )
}

// The fetched-model checklist: saved models start checked, new ones start
// unchecked, and the filter narrows a long list. Selected rows sort to the
// top so what is kept stays easy to scan. The bulk toggle acts on all
// rows, or only the rows currently shown when a filter is active.
function ModelPicker({
  token,
  saving = false,
  saveLabel = 'Add',
  onSave,
  onCancel
}: {
  token: string
  saving?: boolean
  saveLabel?: string
  onSave: () => void
  onCancel: () => void
}) {
  if (read(modelPickerFor) !== token) return null
  const choices = read(modelPickerChoices)
  const filter = read(modelPickerFilter)
  const needle = filter.trim().toLowerCase()
  const shown = (needle ? choices.filter((choice) => matchesFilter(choice.id, filter)) : choices).slice().sort(
    (a, b) => Number(b.checked) - Number(a.checked)
  )
  const shownIds = shown.map((choice) => choice.id)
  const allIds = choices.map((choice) => choice.id)
  const selected = choices.filter((choice) => choice.checked).length
  const added = choices.filter((choice) => choice.checked && !choice.existing).length
  const removed = choices.filter((choice) => !choice.checked && choice.existing).length
  const allShownChecked = shown.length > 0 && shown.every((choice) => choice.checked)
  const bulkIds = needle ? shownIds : allIds
  const bulkLabel = needle
    ? allShownChecked
      ? 'Deselect shown'
      : 'Select shown'
    : allShownChecked
      ? 'Deselect all'
      : 'Select all'
  const actionLabel =
    added && !removed
      ? `${saveLabel} ${added} model${added === 1 ? '' : 's'}`
      : removed && !added
        ? `Remove ${removed} model${removed === 1 ? '' : 's'}`
        : 'Apply changes'
  return (
    <Box background="muted" radius="md" padding="sm">
      <Stack gap="sm">
        <Row justify="between" align="center" gap="sm">
          <Text size="sm" weight="semibold">
            Select models
          </Text>
          <IconButton size="xs" icon="close" label="Close model picker" tooltip="Close" onPress={onCancel} />
        </Row>
        <Input
          label="Filter models"
          labelHidden
          type="search"
          placeholder="Filter models by name"
          value={filter}
          onChange={(value) => set(modelPickerFilter, value)}
        />
        <Row gap="xs" wrap align="center">
          <Button
            size="xs"
            variant="outline"
            disabled={!shown.length}
            onPress={() => setModelChoices(bulkIds, !allShownChecked)}
          >
            {bulkLabel}
          </Button>
        </Row>
        <Text muted size="xs">
          {choices.length ? (
            <>
              {selected} of {choices.length} selected
              {added ? ` · ${added} new` : ''}
              {removed ? ` · ${removed} will be removed` : ''}
              {needle ? ` · showing ${shown.length}` : ''}
            </>
          ) : (
            'The endpoint did not return any models.'
          )}
        </Text>
        {shown.length ? (
          <Box maxHeight={240} scroll="y">
            <Stack gap="xs">
              {shown.map((choice) => (
                <Checkbox
                  key={choice.id}
                  label={choice.id}
                  checked={choice.checked}
                  onChange={(checked) => toggleModelChoice(choice.id, checked)}
                />
              ))}
            </Stack>
          </Box>
        ) : (
          <Text muted size="xs">
            {needle ? 'No models match the filter.' : 'The endpoint did not return any models.'}
          </Text>
        )}
        <Row gap="xs" wrap>
          <Button
            size="xs"
            variant="solid"
            tone="accent"
            disabled={saving || (!added && !removed)}
            onPress={onSave}
          >
            {saving ? 'Saving…' : actionLabel}
          </Button>
          <Button size="xs" variant="ghost" onPress={onCancel}>
            Cancel
          </Button>
        </Row>
      </Stack>
    </Box>
  )
}

// Cross-provider model search. One provider-grouped, searchable checkbox list
// for every model the configured endpoints returned; saving writes the selection
// into each provider's model list.
function GlobalModelPicker() {
  if (!read(globalModelsOpen)) return null
  const choices = read(globalModelChoices)
  const filter = read(globalModelFilter)
  const saving = read(globalModelsSaving)
  const errors = read(globalModelErrors)
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? choices.filter((choice) => matchesFilter(`${choice.provider}/${choice.id}`, filter))
    : choices
  const providerNames = [...new Set(shown.map((choice) => choice.provider))]
  const shownKeys = shown.map((choice) => `${choice.provider}\u0000${choice.id}`)
  const allKeys = choices.map((choice) => `${choice.provider}\u0000${choice.id}`)
  const selected = choices.filter((choice) => choice.checked).length
  const added = choices.filter((choice) => choice.checked && !choice.existing).length
  const removed = choices.filter((choice) => !choice.checked && choice.existing).length
  const allShownChecked = shown.length > 0 && shown.every((choice) => choice.checked)
  const bulkLabel = needle
    ? allShownChecked
      ? 'Deselect shown'
      : 'Select shown'
    : allShownChecked
      ? 'Deselect all'
      : 'Select all'
  const actionLabel =
    added && !removed
      ? `Make ${added} model${added === 1 ? '' : 's'} available`
      : removed && !added
        ? `Remove ${removed} model${removed === 1 ? '' : 's'}`
        : 'Apply changes'
  return (
    <Box background="muted" radius="md" padding="sm">
      <Stack gap="sm">
        <Row justify="between" align="center" gap="sm">
          <Text size="sm" weight="semibold">
            Search all providers
          </Text>
          <Row gap="xs" align="center">
            <Button
              size="xs"
              variant="ghost"
              disabled={!shown.length}
              onPress={() => setGlobalModelChoices(needle ? shownKeys : allKeys, !allShownChecked)}
            >
              {bulkLabel}
            </Button>
            <IconButton
              size="xs"
              icon="close"
              label="Close model search"
              tooltip="Close"
              onPress={closeGlobalModels}
            />
          </Row>
        </Row>
        <Input
          label="Search models"
          labelHidden
          type="search"
          placeholder="Filter by provider or model"
          value={filter}
          onChange={(value) => set(globalModelFilter, value)}
        />
        <Text muted size="xs">
          {choices.length
            ? `${selected} of ${choices.length} selected${added ? ` · ${added} new` : ''}${
                removed ? ` · ${removed} will be removed` : ''
              }${needle ? ` · showing ${shown.length}` : ''}`
            : 'No provider returned any models.'}
        </Text>
        {shown.length ? (
          <Box maxHeight={280} scroll="y">
            <Stack gap="sm">
              {providerNames.map((name) => (
                <Stack key={name} gap="xs">
                  <Text size="xs" weight="semibold">
                    {name}
                  </Text>
                  {shown
                    .filter((choice) => choice.provider === name)
                    .map((choice) => (
                      <Checkbox
                        key={`${choice.provider}/${choice.id}`}
                        label={choice.id}
                        checked={choice.checked}
                        onChange={(checked) => toggleGlobalModel(choice.provider, choice.id, checked)}
                      />
                    ))}
                </Stack>
              ))}
            </Stack>
          </Box>
        ) : (
          <Text muted size="xs">
            {needle ? 'No models match the search.' : 'No provider returned any models.'}
          </Text>
        )}
        {errors.length ? (
          <Callout tone="warning">
            <Text size="xs">
              Couldn't reach {errors.map((entry) => entry.provider).join(', ')}. Their saved models are unchanged.
            </Text>
          </Callout>
        ) : null}
        <Row gap="xs" wrap>
          <Button
            size="xs"
            variant="solid"
            tone="accent"
            disabled={saving || (!added && !removed)}
            onPress={() => void saveGlobalModels()}
          >
            {saving ? 'Saving...' : actionLabel}
          </Button>
          <Button size="xs" variant="ghost" onPress={closeGlobalModels}>
            Cancel
          </Button>
        </Row>
      </Stack>
    </Box>
  )
}

// A danger confirmation shown inline in place of the action it guards. Orca has
// no dialog primitive, so destructive deletes expand a Callout here instead.
function ConfirmDelete({
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel
}: {
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Callout tone="danger">
      <Stack gap="sm">
        <Text size="sm">{message}</Text>
        <Row gap="xs" wrap>
          <Button size="xs" variant="solid" tone="danger" icon="delete" onPress={onConfirm}>
            {confirmLabel}
          </Button>
          <Button size="xs" variant="ghost" onPress={onCancel}>
            Cancel
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

// The primary "add" affordance for a tab: one full-width action pinned to the
// top that expands its form in a muted card. It stays a single line, so the old
// title-plus-subtitle pair is gone.
function AddSection({
  label,
  open,
  onOpenChange,
  extra,
  showToggle = true,
  children
}: WithChildren & {
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  extra?: WithChildren['children']
  /** Hide the built-in Add/Cancel toggle when the caller draws its own actions. */
  showToggle?: boolean
}) {
  return (
    <Stack gap="sm" align="stretch">
      {showToggle || extra ? (
        <Row gap="xs" wrap align="center">
          {showToggle ? (
            <Button
              variant={open ? 'ghost' : 'solid'}
              tone={open ? undefined : 'accent'}
              icon={open ? 'close' : 'add'}
              onPress={() => onOpenChange(!open)}
            >
              {open ? 'Cancel' : label}
            </Button>
          ) : null}
          {extra}
        </Row>
      ) : null}
      {open ? (
        <Box background="muted" radius="md" padding="sm">
          {children}
        </Box>
      ) : null}
    </Stack>
  )
}

// A compact blue explainer: the title stays visible and the body expands on
// demand. A Callout gives the thin blue rule and blue title without the boxy
// background. Tabs pass the "auto" state so an empty config starts open.
function InfoBanner({
  title,
  open,
  onOpenChange,
  children
}: WithChildren & {
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Row gap="xs" align="start">
      <Box grow>
        <Callout tone="neutral" title={title}>
          {open ? children : null}
        </Callout>
      </Box>
      <IconButton
        size="xs"
        variant="ghost"
        icon={open ? 'collapse' : 'expand'}
        label={open ? 'Collapse details' : 'Expand details'}
        tooltip={open ? 'Collapse' : 'Expand'}
        onPress={() => onOpenChange(!open)}
      />
    </Row>
  )
}

type DailyUsage = {
  day: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  cacheHits: number
  failovers: number
}

// Orca panels cannot render DOM/SVG, so charts use the same Box bar pattern
// Orca's own usage meters use. Boxes carry theme tones and scale with the panel.
function TrendBar({ label, value, max, display, tone = 'accent' }: { label: string; value: number; max: number; display: string; tone?: Tone }) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <Box direction="row" align="center" gap="xs">
      <Box width={52} shrink={false}>
        <Text size="xs" muted truncate>{label}</Text>
      </Box>
      <Box background="muted" radius="full" height={8} width="100%">
        <Box background={tone} radius="full" height={8} width={`${percent}%`} />
      </Box>
      <Box width={64} shrink={false}>
        <Text size="xs" muted truncate>{display}</Text>
      </Box>
    </Box>
  )
}

function StatChip({ label, value, tone, hint }: { label: string; value: string; tone?: Tone; hint?: string }) {
  return (
    <Box background="muted" radius="md" padding="xs">
      <Stack gap="xs">
        <Text size="xs" muted truncate>{label}</Text>
        <Text size="sm" weight="semibold" tone={tone} truncate>{value}</Text>
        {hint ? <Text size="xs" muted truncate>{hint}</Text> : null}
      </Stack>
    </Box>
  )
}

function UsageRankList({
  title,
  items,
  tone
}: {
  title: string
  items: { label: string; count: number }[]
  tone: Tone
}) {
  return (
    <Stack gap="xs">
      <Text size="xs" weight="semibold" muted>{title}</Text>
      {items.map((item) => (
        <Row key={item.label} justify="between" align="center" gap="sm">
          <Text size="xs" truncate>{item.label}</Text>
          <Badge tone={tone}>{formatNumber(item.count)}</Badge>
        </Row>
      ))}
    </Stack>
  )
}

function Metric({ label, value, tone, hint }: { label: string; value: string; tone?: Tone; hint?: string }) {
  return (
    <Stack gap="xs">
      <Text muted size="xs">
        {label}
      </Text>
      <Text size="md" weight="semibold" tone={tone} truncate>
        {value}
      </Text>
      {hint ? (
        <Text muted size="xs" truncate>
          {hint}
        </Text>
      ) : null}
    </Stack>
  )
}

// --- Request log building blocks ------------------------------------------
function formatLogTimestamp(at: number) {
  try { return new Date(at).toLocaleString() } catch { return String(at) }
}

function formatLatency(ms: number | null | undefined) {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

function tokenParts(entry: LogEntry) {
  if (!entry.tokens) return null
  const input = entry.tokens.input ?? 0
  const output = entry.tokens.output ?? 0
  return { input, output, total: input + output, cache: entry.tokens.cache ?? 0 }
}

function logTarget(entry: LogEntry) {
  const provider = entry.resolvedProvider ?? entry.upstream ?? '—'
  const model = entry.resolvedModel ?? entry.model ?? '—'
  return `${provider}/${model}`
}

function logStatusTone(entry: LogEntry): Tone {
  if (entry.status >= 500) return 'danger'
  if (entry.status >= 400) return 'warning'
  return 'success'
}

function logStatusLabel(entry: LogEntry) {
  if (entry.status < 400) return 'Success'
  if (entry.errorCode) return entry.errorCode.replaceAll('_', ' ')
  return `HTTP ${entry.status}`
}

function logSearchText(entry: LogEntry) {
  return [
    entry.route, entry.requestModel, entry.resolvedModel, entry.model,
    entry.resolvedProvider, entry.upstream, entry.credential,
    entry.protocol, entry.errorCode, entry.error, entry.policyId,
    entry.status ? String(entry.status) : null
  ].filter(Boolean).join(' ').toLowerCase()
}

// Search syntax: bare terms plus field filters (`provider=openai`, `error:429`,
// `status=4xx`, `error=` for "has an error"). Both `=` and `:` work; unknown
// `name:value` tokens stay as plain text since model ids contain colons.
// Boolean operators: AND / OR / NOT (or && / || / !), parentheses for grouping.
// AND binds tighter than OR, and adjacent terms imply AND. Quoted values allow
// spaces, e.g. error="all keys exhausted". Numeric fields accept >, >=, <, <=.
const LOG_QUERY_FIELDS = new Set([
  'provider', 'route', 'agent', 'model', 'request', 'requestmodel', 'target', 'resolved',
  'key', 'credential', 'status', 'error', 'code', 'errorcode', 'policy', 'protocol', 'stream',
  'latency', 'tokens', 'input', 'output', 'cost', 'bytes', 'attempts', 'cache'
])
const LOG_NUMERIC_FIELDS = new Set(['status', 'latency', 'tokens', 'input', 'output', 'cost', 'bytes', 'attempts'])

type LogQueryTerm = { fields: { field: string; value: string }[]; text: string[] }
type LogQueryNode =
  | { type: 'term'; term: LogQueryTerm }
  | { type: 'and' | 'or'; a: LogQueryNode; b: LogQueryNode }
  | { type: 'not'; a: LogQueryNode }

function tokenizeLogQuery(input: string) {
  const tokens: string[] = []
  const re = /\s*(\(|\)|&&|\|\||!|(?:[^\s"'()|&!]+|"[^"]*"|'[^']*')+)\s*/y
  let index = 0
  while (index < input.length) {
    re.lastIndex = index
    const match = re.exec(input)
    if (match) {
      tokens.push(match[1])
      index = re.lastIndex
    } else {
      index++
    }
  }
  return tokens
}

function isLogOperator(token: string) {
  return token === '&&' || token === '||' || token === '!' || token === '(' || token === ')'
    || ['and', 'or', 'not'].includes(token.toLowerCase())
}

function logQueryTerm(token: string): LogQueryTerm {
  const cmp = token.match(/^([a-z][a-z0-9_]*)\s*(>=|<=|>|<)\s*(.+)$/i)
  if (cmp && LOG_NUMERIC_FIELDS.has(cmp[1].toLowerCase())) {
    return { fields: [{ field: cmp[1].toLowerCase(), value: `${cmp[2]}${cmp[3].trim()}` }], text: [] }
  }
  const match = token.match(/^([a-z][a-z0-9_]*)\s*[:=]\s*(.*)$/i)
  const field = match?.[1].toLowerCase() ?? ''
  const raw = match?.[2] ?? token
  const value = raw.replace(/^['"]|['"]$/g, '').toLowerCase()
  if (match && LOG_QUERY_FIELDS.has(field)) return { fields: [{ field, value }], text: [] }
  if (value) return { fields: [], text: [value] }
  return { fields: [], text: [] }
}

function parseLogQuery(input: string): LogQueryNode | null {
  const tokens = tokenizeLogQuery(input)
  let pos = 0
  const peek = () => tokens[pos]
  const take = () => tokens[pos++]

  function primary(): LogQueryNode | null {
    const token = peek()
    if (token == null) return null
    if (token === '(') {
      take()
      const inner = orExpr()
      if (peek() === ')') take()
      return inner
    }
    if (token === '!' || token.toLowerCase() === 'not') {
      take()
      const inner = primary()
      return inner ? { type: 'not', a: inner } : null
    }
    if (isLogOperator(token)) return null
    return { type: 'term', term: logQueryTerm(take()) }
  }

  function andExpr(): LogQueryNode | null {
    let left = primary()
    while (left) {
      const token = peek()
      if (token && (token === '&&' || token.toLowerCase() === 'and')) take()
      else if (token && !isLogOperator(token) && token !== ')') { /* implicit AND */ }
      else break
      const right = primary()
      if (!right) break
      left = { type: 'and', a: left, b: right }
    }
    return left
  }

  function orExpr(): LogQueryNode | null {
    let left = andExpr()
    while (left) {
      const token = peek()
      if (!token || (token !== '||' && token.toLowerCase() !== 'or')) break
      take()
      const right = andExpr()
      if (!right) break
      left = { type: 'or', a: left, b: right }
    }
    return left
  }

  return orExpr()
}

function logFieldValue(entry: LogEntry, field: string) {
  switch (field) {
    case 'provider': return entry.resolvedProvider ?? entry.upstream ?? ''
    case 'route': return entry.route ?? ''
    case 'agent': return entry.agent ?? ''
    case 'model': return [entry.resolvedModel, entry.model, entry.requestModel].filter(Boolean).join(' ')
    case 'request':
    case 'requestmodel': return entry.requestModel ?? ''
    case 'target':
    case 'resolved': return logTarget(entry)
    case 'key':
    case 'credential': return entry.credential ?? ''
    case 'status': return String(entry.status)
    case 'error': return entry.error ?? ''
    case 'code':
    case 'errorcode': return entry.errorCode ?? ''
    case 'policy': return entry.policyId ?? ''
    case 'protocol': return entry.protocol ?? ''
    case 'stream': return entry.stream ? 'stream true yes' : 'buffered false no'
  }
  return ''
}

function numericLogFieldValue(entry: LogEntry, field: string) {
  switch (field) {
    case 'status': return entry.status
    case 'latency': return entry.latencyMs ?? 0
    case 'tokens': return (entry.tokens?.input ?? 0) + (entry.tokens?.output ?? 0)
    case 'input': return entry.tokens?.input ?? 0
    case 'output': return entry.tokens?.output ?? 0
    case 'cost': return entry.cost ?? 0
    case 'bytes': return entry.bytes ?? 0
    case 'attempts': return entry.attempts.length
  }
  return 0
}

function matchesLogQuery(entry: LogEntry, node: LogQueryNode | null): boolean {
  if (!node) return true
  if (node.type === 'and') return matchesLogQuery(entry, node.a) && matchesLogQuery(entry, node.b)
  if (node.type === 'or') return matchesLogQuery(entry, node.a) || matchesLogQuery(entry, node.b)
  if (node.type === 'not') return !matchesLogQuery(entry, node.a)
  for (const { field, value } of node.term.fields) {
    const comparison = value.match(/^(>=|<=|>|<)(-?\d+(?:\.\d+)?)$/)
    if (comparison && LOG_NUMERIC_FIELDS.has(field)) {
      const actual = numericLogFieldValue(entry, field)
      const expected = Number(comparison[2])
      const ok = comparison[1] === '>' ? actual > expected
        : comparison[1] === '>=' ? actual >= expected
          : comparison[1] === '<' ? actual < expected : actual <= expected
      if (!ok) return false
      continue
    }
    let haystack = logFieldValue(entry, field)
    if (field === 'status' && /^[1-5]xx$/.test(value)) haystack = `${Math.floor(entry.status / 100)}xx`
    if (!value) {
      if (!haystack) return false // `error=` means "has an error"
    } else if (!haystack.toLowerCase().includes(value)) {
      return false
    }
  }
  const text = logSearchText(entry)
  for (const term of node.term.text) {
    if (!text.includes(term)) return false
  }
  return true
}

function visibleLogs() {
  const query = parseLogQuery(read(logSearch))
  const errorsOnly = read(logErrorsOnly)
  return read(logs)
    .filter((entry) => {
      if (errorsOnly && entry.status < 400) return false
      return matchesLogQuery(entry, query)
    })
    .reverse()
}

function csvCell(value: unknown) {
  const text = value == null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function exportLogsCsv() {
  const rows = [...read(logs)].reverse()
  if (!rows.length) return
  const header = ['time', 'status', 'errorCode', 'route', 'agent', 'vpn', 'requestModel', 'provider', 'resolvedModel', 'credential', 'protocol', 'stream', 'latencyMs', 'tokensIn', 'tokensOut', 'cost', 'cache', 'policyId', 'error']
  const lines = [header.join(',')]
  for (const entry of rows) {
    const parts = tokenParts(entry)
    lines.push([
      new Date(entry.at).toISOString(), entry.status, entry.errorCode, entry.route, entry.agent, entry.vpn, entry.requestModel,
      entry.resolvedProvider ?? entry.upstream, entry.resolvedModel ?? entry.model, entry.credential,
      entry.protocol, entry.stream ? 'yes' : 'no', entry.latencyMs, parts?.input, parts?.output,
      entry.cost, entry.cache, entry.policyId, entry.error
    ].map(csvCell).join(','))
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `orca-router-requests-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

function toggleLogLive(checked: boolean) {
  set(logLive, checked)
  if (checked) {
    const pending = read(pendingLogs)
    if (pending.length) {
      update(logs, (list) => [...list, ...pending].slice(-100))
      set(pendingLogs, [])
    }
  }
}

function LogDetail({ entry }: { entry: LogEntry }) {
  const parts = tokenParts(entry)
  const summary = [
    { label: 'Time', value: formatLogTimestamp(entry.at) },
    { label: 'Requested', value: entry.requestModel ?? entry.model ?? '—' },
    { label: 'Route', value: entry.route ?? '—' },
    ...(entry.vpn ? [{ label: 'VPN', value: entry.vpn }] : []),
    { label: 'Selected target', value: logTarget(entry) },
    { label: 'Credential', value: entry.credential ?? '—' },
    { label: 'Protocol', value: `${entry.protocol}${entry.stream ? ' · stream' : ''}` },
    ...(entry.policyId ? [{ label: 'Policy', value: entry.policyId }] : []),
    { label: 'Status', value: `${entry.status} · ${logStatusLabel(entry)}` },
    ...(entry.failedOver ? [{ label: 'Recovered', value: 'a target failed before this response', tone: 'warning' as Tone }] : []),
    { label: 'Latency', value: formatLatency(entry.latencyMs) },
    { label: 'Tokens', value: parts
      ? `${formatNumber(parts.input)} in · ${formatNumber(parts.output)} out${parts.cache ? ` · ${formatNumber(parts.cache)} cached` : ''}`
      : '—' },
    ...(entry.cost != null ? [{ label: 'Cost', value: formatUsd(entry.cost) }] : []),
    ...(entry.bytes != null ? [{ label: 'Upstream bytes', value: formatNumber(entry.bytes) }] : []),
    ...(entry.cache ? [{ label: 'Cache', value: entry.cache }] : []),
    ...(entry.compression ? [{ label: 'Compression', value: `${entry.compression.mode} · saved ${entry.compression.saved} chars` }] : []),
    ...(entry.relay ? [{ label: 'Context relay', value: `${entry.relay.relayed} digests · saved ${entry.relay.before - entry.relay.after} chars` }] : []),
    ...(entry.delaysMs?.length ? [{ label: 'Retry delays', value: `${entry.delaysMs.join(', ')} ms` }] : [])
  ]
  return (
    <Stack gap="xs">
      <KeyValue items={summary} />
      {entry.attempts.length ? (
        <Stack gap="xs">
          <Text muted size="xs" weight="semibold">Failover trail</Text>
          {entry.attempts.map((hop, index) => {
            const split = hop.indexOf('#')
            const target = split >= 0 ? hop.slice(0, split) : hop
            const status = split >= 0 ? hop.slice(split + 1) : ''
            const failure = entry.failures?.[index]
            return (
              <Text key={index} size="xs" tone={status ? 'danger' : 'success'} truncate>
                {`${index + 1}. ${target}${status ? ` · ${status}` : ''}${failure?.error ? ` · ${failure.error}` : ''}`}
              </Text>
            )
          })}
        </Stack>
      ) : null}
      {entry.error ? <Text size="xs" tone="danger">{entry.error}</Text> : null}
    </Stack>
  )
}

function LogRow({ entry, compact = false }: { entry: LogEntry; compact?: boolean }) {
  const rowKey = `${entry.at}-${entry.credential ?? ''}-${entry.resolvedModel ?? entry.model ?? ''}`
  const expanded = !compact && read(logExpanded) === rowKey
  const target = logTarget(entry)
  const parts = tokenParts(entry)
  const failoverCount = entry.failures?.length ?? Math.max(0, entry.attempts.length - 1)
  const meta = [
    entry.credential ?? 'no key',
    parts ? `${tokenCount(entry)} tok${parts.output ? ` (${formatNumber(parts.output)} out)` : ''}` : null,
    entry.cost != null ? formatUsd(entry.cost) : null
  ].filter(Boolean).join(' · ')
  return (
    <Box background="muted" radius="md" padding="xs">
      <Row gap="xs" align="center">
        <Box width={52} shrink={false}>
          <Stack gap="xs" align="center">
            <Text muted size="xs" truncate><RelativeTime at={entry.at} format="duration" /></Text>
            <Text muted size="xs">ago</Text>
          </Stack>
        </Box>
        <Box width={84} shrink={false}>
          <Stack gap="xs" align="center">
            <Badge tone={logStatusTone(entry)}>{String(entry.status)}</Badge>
            {entry.failedOver ? (
              <Row gap="xs" align="center">
                <Text size="xs" weight="semibold" tone="warning">{failoverCount}</Text>
                <Text size="xs" muted>failovers</Text>
              </Row>
            ) : null}
          </Stack>
        </Box>
        <Box grow minWidth={0}>
          <Text size="sm" weight="medium" truncate>{entry.route ?? entry.requestModel ?? target}</Text>
          <Text muted size="xs" truncate>{entry.route ? `→ ${target}` : target}{compact && meta ? ` · ${meta}` : ''}</Text>
          {compact || !meta ? null : <Text muted size="xs" truncate>{meta}</Text>}
        </Box>
        <Box width={48} shrink={false}>
          <Text muted size="xs">{formatLatency(entry.latencyMs)}</Text>
        </Box>
        {compact ? null : (
          <IconButton
            size="xs"
            variant="ghost"
            icon={expanded ? 'collapse' : 'expand'}
            label={expanded ? 'Collapse request details' : 'Expand request details'}
            tooltip={expanded ? 'Collapse' : 'Details'}
            onPress={() => set(logExpanded, expanded ? '' : rowKey)}
          />
        )}
      </Row>
      {!compact && (entry.cache || entry.compression || entry.relay) ? (
        <Row gap="xs" wrap>
          {entry.cache ? (
            <Badge tone={entry.cache === 'hit' || entry.cache === 'semantic-hit' ? 'success' : 'neutral'}>{entry.cache}</Badge>
          ) : null}
          {entry.compression ? <Badge tone="neutral">{`compressed ${entry.compression.saved} chars`}</Badge> : null}
          {entry.relay ? <Badge tone="neutral">{`relay ${entry.relay.relayed} digests`}</Badge> : null}
        </Row>
      ) : null}
      {expanded ? (
        <Box padding="xs">
          <LogDetail entry={entry} />
        </Box>
      ) : null}
    </Box>
  )
}

function logSummary(entries: LogEntry[]) {
  if (!entries.length) return ''
  const errors = entries.filter((entry) => entry.status >= 400).length
  const latency = entries.map((entry) => entry.latencyMs).filter((value): value is number => value != null)
  const avg = latency.length ? latency.reduce((sum, value) => sum + value, 0) / latency.length : null
  const tokens = entries.reduce((sum, entry) => sum + (entry.tokens?.input ?? 0) + (entry.tokens?.output ?? 0), 0)
  const parts = [`${entries.length} requests`, `${errors} errors`, formatLatency(avg), `${formatNumber(tokens)} tokens`]
  return parts.join(' · ')
}

function Navigation() {
  const raw = read(tab)
  const active = raw === 'keys' ? 'overview' : raw === 'routes' ? 'routing' : raw
  return (
    <Box background="muted" radius="md" padding="xs">
      <Row gap="xs" wrap>
        {SECTIONS.map((section) => (
          <Button
            key={section.value}
            size="xs"
            variant={active === section.value ? 'solid' : 'ghost'}
            tone={active === section.value ? 'accent' : undefined}
            onPress={() => set(tab, section.value)}
          >
            {section.label}
          </Button>
        ))}
      </Row>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
function StatusBanner() {
  const isRunning = read(running)
  const providerCount = read(providers).length
  return (
    <Stack gap="sm">
      <Row justify="between" align="center" gap="sm" wrap>
        <Heading>Orca LLM Router</Heading>
        <Row gap="xs" align="center">
          <IconButton
            icon={isRunning ? 'stop' : 'play'}
            label={isRunning ? 'Stop gateway' : 'Start gateway'}
            tooltip={isRunning ? 'Stop gateway' : 'Start gateway'}
            variant={isRunning ? 'outline' : 'solid'}
            tone={isRunning ? undefined : 'accent'}
            onPress={() => void mutate(isRunning ? 'router.stop' : 'router.start')}
          />
          <IconButton
            icon="zap"
            label="Restart gateway"
            tooltip="Restart gateway"
            onPress={() => void mutate('router.restart')}
          />
          <IconButton
            icon="activity"
            label="Test providers"
            tooltip={providerCount ? 'Test every provider' : 'Add a provider first'}
            disabled={!providerCount}
            onPress={() => void testProviders()}
          />
          <IconButton icon="refresh" label="Refresh status" tooltip="Refresh status" onPress={() => void refresh()} />
        </Row>
      </Row>
      <Row gap="xs" align="center" wrap>
        <Badge tone={isRunning ? 'success' : 'warning'}>{isRunning ? 'Running' : 'Stopped'}</Badge>
        <Text muted size="xs" truncate>
          {isRunning ? `${read(host)}:${read(port)}` : 'Gateway is not listening'}
        </Text>
      </Row>

      {read(message) ? (
        <Callout tone="success" title="Done" icon="check">
          <Text size="sm">{read(message)}</Text>
        </Callout>
      ) : null}
      {read(error) ? (
        <Callout tone="danger" title="Something went wrong" icon="error">
          <Text size="sm">{read(error)}</Text>
        </Callout>
      ) : null}
    </Stack>
  )
}

function Loading() {
  return (
    <Stack gap="md">
      <Card title="Gateway">
        <Skeleton lines={4} label="Loading gateway status" />
      </Card>
      <Card title="Usage">
        <Skeleton lines={3} label="Loading usage" />
      </Card>
    </Stack>
  )
}

function Overview() {
  const ups = read(providers)
  const metric = read(usage)
  const mixInput = Math.max(0, (metric?.uncachedTokens ?? 0) - (metric?.outputTokens ?? 0))
  const mixOutput = metric?.outputTokens ?? 0
  const mixCached = metric?.cachedTokens ?? 0
  const mixTotal = mixInput + mixOutput + mixCached || 1
  const mixSegments: { key: string; label: string; value: number; tone: Tone }[] = [
    { key: 'input', label: 'Input', value: mixInput, tone: 'accent' },
    { key: 'output', label: 'Output', value: mixOutput, tone: 'success' },
    { key: 'cached', label: 'Cached', value: mixCached, tone: 'warning' }
  ]
  const hasTraffic = metric != null && metric.requests > 0
  const totalFailovers = (metric?.byRoute ?? []).reduce((sum, row) => sum + row.failovers, 0)
  const topProviders = [...(metric?.byProvider ?? [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((item) => ({ label: item.provider, count: item.count }))
  const topModels = [...(metric?.byModel ?? [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((item) => ({ label: item.model, count: item.count }))
  const successTone: Tone | undefined = metric && hasTraffic
    ? metric.successRate >= 0.95
      ? 'success'
      : metric.successRate >= 0.8
        ? 'warning'
        : 'danger'
    : undefined
  const gateway = `http://${read(host)}:${read(port)}`
  const routeCount = read(mergedRoutesView).length
  const routedAgents = read(agentList).filter((agent) => agent.enabled).length
  const policyCount = read(policies).length
  const modelCount = ups.reduce((total, provider) => total + (provider.models?.length ?? 0), 0)
  const recent = read(logs).slice(-4).reverse()

  return (
    <Stack gap="md">
      <InfoBanner
        title="What Orca LLM Router does"
        open={read(overviewInfoOpen) ?? ups.length === 0}
        onOpenChange={(open) => set(overviewInfoOpen, open)}
      >
        <Stack gap="sm">
          <Text size="sm">
            One local gateway for every coding agent in Orca. Point an agent at it and you can use any provider or
            subscription you've configured through a single OpenAI-, Anthropic- or Gemini-compatible address. Keys
            stay in Orca's secret store, are rotated across pools, and protocol and reasoning differences are handled
            for you — agent code doesn't change.
          </Text>
          <Text size="sm">
            Routes, policies and fallback chains decide where each request goes, and warm prompt caches are preserved.
            Add a provider under <Code>Providers</Code> to get started; this tab then shows the gateway addresses,
            usage, provider health and recent activity.
          </Text>
          <Row gap="xs" wrap>
            <Button
              variant="solid"
              tone="accent"
              onPress={() => {
                set(tab, 'providers')
                set(addMode, 'preset')
                set(addProviderOpen, true)
              }}
            >
              Add a provider
            </Button>
            <Button variant="ghost" onPress={() => set(tab, 'settings')}>
              Import config
            </Button>
          </Row>
        </Stack>
      </InfoBanner>

      <Card title="Overview">
        <Stack gap="sm">
          <Grid columns={3} gap="xs">
            <StatChip label="Providers" value={String(ups.length)} tone={ups.length ? 'success' : 'warning'} />
            <StatChip label="Models" value={String(modelCount)} tone={modelCount ? undefined : 'warning'} />
            <StatChip label="Agents" value={String(routedAgents)} />
            <StatChip label="Policies" value={String(policyCount)} />
            <StatChip label="Routes" value={String(routeCount)} />
          </Grid>

          <Grid columns={3} gap="xs">
            <StatChip label="Requests" value={metric ? formatNumber(metric.requests) : '—'} />
            <StatChip
              label="Success"
              value={metric && hasTraffic ? `${(metric.successRate * 100).toFixed(1)}%` : '—'}
              tone={successTone}
            />
            <StatChip
              label="Errors"
              value={metric ? formatNumber(metric.errors) : '—'}
              tone={metric && hasTraffic ? (metric.errors ? 'danger' : 'success') : undefined}
            />
            <StatChip
              label="Failovers"
              value={metric ? formatNumber(totalFailovers) : '—'}
              tone={totalFailovers ? 'warning' : undefined}
            />
            <StatChip label="Avg latency" value={metric && hasTraffic ? formatLatency(metric.avgLatencyMs) : '—'} />
          </Grid>
        </Stack>
      </Card>

      {metric ? (
        <Card>
          <Stack gap="sm">
            <Text size="sm" weight="semibold">Token usage</Text>
            <Grid columns={2} gap="xs">
              <StatChip label="Total tokens" value={formatNumber(metric.totalTokens)} />
              <StatChip label="Estimated cost" value={formatUsd(metric.cost)} tone="success" />
            </Grid>

            <Stack gap="xs">
              <Box direction="row" gap="md" wrap>
                {mixSegments.map((segment) => (
                  <Row key={segment.key} align="center" gap="xs">
                    <Box background={segment.tone} radius="full" height={6} width={6} />
                    <Text size="xs" muted>{segment.label}</Text>
                    <Text size="xs" weight="semibold">{formatNumber(segment.value)}</Text>
                    <Text size="xs" muted>{((segment.value / mixTotal) * 100).toFixed(0)}%</Text>
                  </Row>
                ))}
              </Box>
              <Box direction="row" height={8} width="100%" background="muted" radius="full">
                {mixSegments.map((segment) => segment.value > 0 ? (
                  <Box key={segment.key} background={segment.tone} height={8} width={`${(segment.value / mixTotal) * 100}%`} />
                ) : null)}
              </Box>
            </Stack>

            {topProviders.length || topModels.length ? (
              <Grid columns={2} gap="md">
                {topProviders.length ? <UsageRankList title="Top providers" items={topProviders} tone="accent" /> : null}
                {topModels.length ? <UsageRankList title="Top models" items={topModels} tone="success" /> : null}
              </Grid>
            ) : null}

            {(metric.unpricedRequests ?? 0) > 0 ? (
              <Text size="xs" muted>
                {formatNumber(metric.unpricedRequests ?? 0)} requests unpriced — cost is a lower bound.
              </Text>
            ) : null}
          </Stack>
        </Card>
      ) : null}

      {!metric ? (
        <Text muted size="sm">
          No usage recorded yet. Launch an agent and send a request.
        </Text>
      ) : null}

      <Card>
        <Stack gap="sm">
          <Row align="center" gap="xs">
            <Heading level={2}>Gateway</Heading>
            <Text muted size="xs">
              Port
            </Text>
            {!read(editingPort) ? (
              <>
                <Text size="sm" weight="semibold">
                  {read(port)}
                </Text>
                <IconButton
                  size="xs"
                  icon="edit"
                  label="Edit gateway port"
                  tooltip="Change port"
                  onPress={() => {
                    set(portDraft, String(read(port)))
                    set(editingPort, true)
                  }}
                />
              </>
            ) : null}
          </Row>
          <Text muted size="sm">
            Point agents at these addresses
          </Text>
          {read(editingPort) ? (
            <Stack gap="xs">
              <Row gap="xs" align="center">
                <Box grow>
                  <Input
                    label="Gateway port"
                    labelHidden
                    placeholder="18080"
                    value={read(portDraft)}
                    onChange={(value) => set(portDraft, value)}
                    onSubmit={() => void saveGatewayPort()}
                  />
                </Box>
                <Button
                  size="xs"
                  variant="solid"
                  tone="accent"
                  disabled={read(savingPort) || !read(portDraft).trim()}
                  onPress={() => void saveGatewayPort()}
                >
                  {read(savingPort) ? 'Saving…' : 'Save'}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onPress={() => {
                    set(portDraft, String(read(port)))
                    set(editingPort, false)
                  }}
                >
                  Cancel
                </Button>
              </Row>
              <Text muted size="xs">
                Changing the port restarts a running gateway; both base URLs above follow it.
              </Text>
            </Stack>
          ) : null}
          <EndpointTile label="OpenAI base URL" value={`${gateway}/v1`} />
          <EndpointTile label="Anthropic base URL" value={gateway} />
        </Stack>
      </Card>

      <Card title="Recent activity" description="The latest routed requests">
        {recent.length ? (
          <Stack gap="xs">
            {recent.map((entry, index) => (
              <LogRow key={`${entry.at}-${index}`} entry={entry} compact />
            ))}
          </Stack>
        ) : (
          <Text muted size="sm">
            No requests yet.
          </Text>
        )}
        <Button variant="ghost" onPress={() => set(tab, 'logs')}>
          Open request log
        </Button>
      </Card>

    </Stack>
  )
}

function QuotaBar({ caption, percent, tone }: { caption: string; percent: number; tone: Tone }) {
  return (
    <Stack gap="xs">
      <Box background="muted" radius="full" height={6} width="100%">
        <Box background={tone} radius="full" height={6} width={`${percent}%`} />
      </Box>
      <Row justify="between" align="center" gap="sm" wrap>
        <Text muted size="xs">
          {caption}
        </Text>
        <Text size="xs" tone={tone === 'success' ? undefined : tone} weight="medium">
          {percent}%
        </Text>
      </Row>
    </Stack>
  )
}

function QuotaValueRow({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <Row justify="between" align="center" gap="sm" wrap>
      <Text muted size="xs">
        {label}
      </Text>
      <Text size="xs">
        {value}
        {suffix ?? ''}
      </Text>
    </Row>
  )
}

function keyProviderItems(quota?: KeyProviderUsage) {
  return (quota?.meters ?? [])
    .map((meter) => ({ meter, progress: providerMeterProgress(meter) }))
    .filter(({ meter, progress }) => progress || meter.limit != null || meter.remaining != null || meter.used != null)
}

function KeyBadges({ usage, quota }: { usage?: ProviderKeyUsage; quota?: KeyProviderUsage }) {
  const cooling = (usage?.cooldownUntil ?? 0) > Date.now()
  const limited = !cooling && usage?.state === 'limited'
  const quotaUnavailable = Boolean(quota) && !keyProviderItems(quota).length
  if (!cooling && !limited && !quotaUnavailable) return null
  return (
    <Row gap="xs" align="center" wrap>
      {cooling ? (
        <Text size="xs" tone="warning">
          cooling
        </Text>
      ) : null}
      {limited ? (
        <Text size="xs" tone="danger">
          at limit
        </Text>
      ) : null}
      {quotaUnavailable ? (
        <Text size="xs" tone="warning">
          quota unavailable
        </Text>
      ) : null}
    </Row>
  )
}

function KeyUsageBar({ usage, quota }: { usage?: ProviderKeyUsage; quota?: KeyProviderUsage }) {
  if (!usage && !quota) return null
  const localMeters = usage ? [...usage.meters].sort((a, b) => b.utilization - a.utilization) : []
  const providerItems = keyProviderItems(quota)
  const providerBars = providerItems
    .flatMap(({ meter, progress }) => progress ? [{ meter, progress }] : [])
    .sort((a, b) => (b.progress.used / b.progress.limit) - (a.progress.used / a.progress.limit))
  const providerTexts = providerItems.filter(({ progress }) => !progress)
  return (
    <Stack gap="xs">
      {providerItems.length ? (
        <Stack gap="xs">
          <Text muted size="xs" weight="medium">
            Provider quota
          </Text>
          {providerBars.map(({ meter, progress }, index) => (
            <QuotaBar
              key={`bar-${meter.id ?? meter.label ?? index}`}
              caption={`${meter.label ?? meter.id ?? 'Quota'} · ${formatUsageValue(progress.used, meter.unit)} / ${formatUsageValue(progress.limit, meter.unit)}`}
              percent={progress.percent}
              tone={usageTone(progress.used / progress.limit)}
            />
          ))}
          {providerTexts.map(({ meter }, index) => {
            const value = meter.remaining ?? meter.limit ?? meter.used
            if (value == null) return null
            return (
              <QuotaValueRow
                key={`text-${meter.id ?? meter.label ?? index}`}
                label={meter.label ?? meter.id ?? 'Quota'}
                value={formatUsageValue(value, meter.unit)}
                suffix={meter.remaining != null ? ' left' : ''}
              />
            )
          })}
        </Stack>
      ) : null}
      {localMeters.length ? (
        <Stack gap="xs">
          {providerItems.length ? (
            <Text muted size="xs" weight="medium">
              Local limits
            </Text>
          ) : null}
          {localMeters.map((meter) => (
            <QuotaBar
              key={meter.field}
              caption={`${usageField(meter.field)} ${formatNumber(meter.used)} / ${formatNumber(meter.limit)} per ${usageWindow(meter.windowMs)}`}
              percent={usagePercent(meter.utilization)}
              tone={usageTone(meter.utilization)}
            />
          ))}
        </Stack>
      ) : null}
      {!providerItems.length && !localMeters.length ? (
        <Box background="muted" radius="full" height={6} width="100%" />
      ) : null}
    </Stack>
  )
}

function ProviderCard({ provider }: { provider: ProviderView }) {
  const cfg = configProvider(provider.name)
  const enabled = cfg?.enabled !== false
  const models = provider.models ?? []
  const health = provider.health
  const showHealthBadge = Boolean(health && health.state !== 'unknown')
  const showHealthMetrics = Boolean(health && health.samples > 0)
  // The trailing status should describe the most recent outcome. A success long
  // ago followed by a failure must not keep reading "ok" - show when it failed.
  const lastOutcomeFailed = Boolean(health?.lastFailureAt && health.lastFailureAt > (health.lastSuccessAt ?? 0))
  const lastOutcomeAt = lastOutcomeFailed ? health?.lastFailureAt : health?.lastSuccessAt
  const pool = cfg?.keys ?? []
  const keyCount = cfg ? pool.length : provider.keyCount
  const keyUsage = new Map((provider.keyUsage ?? []).map((entry) => [entry.secretKey, entry]))
  const quotaReport = read(keyQuotaReports).find((report) => report.provider === provider.name)
  const keyQuota = new Map((quotaReport?.keys ?? []).map((entry) => [entry.secretKey, entry]))
  const note = read(usageNote)
  const detected = read(usageDetected)
  const formOpen = read(keyFormFor) === provider.name
  const editing = read(providerEditFor) === provider.name
  const drafts = read(keyDrafts)
  const filledDrafts = drafts.filter((draft) => draft.value.trim()).length
  const draftNames = draftKeyNames(drafts, existingSecretNames())
  function addAnotherKey() {
    set(keyDrafts, [...drafts, blankKeyDraft()])
  }
  return (
    <Card>
      <Stack gap="md">
        <Stack gap="xs">
          <Row gap="xs" align="center" wrap>
            <Heading level={3}>{provider.displayName || provider.name}</Heading>
            <Badge tone="neutral">
              {enabled ? (keyCount ? `${keyCount} ${keyCount === 1 ? 'key' : 'keys'}` : 'no key') : 'disabled'}
            </Badge>
            <Badge tone={models.length ? 'neutral' : 'warning'}>
              {models.length ? `${models.length} ${models.length === 1 ? 'model' : 'models'}` : 'no models'}
            </Badge>
            {showHealthBadge ? (
              <Badge tone={healthTone(health?.state)}>{healthLabel(health?.state)}</Badge>
            ) : null}
          </Row>
          {editing ? null : (
            <Text muted size="xs">
              {provider.baseUrl}
            </Text>
          )}
          {showHealthMetrics && health?.latencyMs != null ? (
            <Row gap="xs" align="center" wrap>
              <Text muted size="xs">
                {`Response avg ${health.latencyMs} ms / ${health.samples} req${health.samples === 1 ? '' : 's'}`}
              </Text>
              {lastOutcomeAt ? (
                <>
                  <Text muted size="xs">
                    {' · '}
                  </Text>
                  {lastOutcomeFailed ? (
                    <Text tone="warning" size="xs">
                      {'failed '}
                      <RelativeTime at={lastOutcomeAt} format="short" />
                    </Text>
                  ) : (
                    <Text tone="success" size="xs">
                      {'ok '}
                      <RelativeTime at={lastOutcomeAt} format="short" />
                    </Text>
                  )}
                </>
              ) : null}
            </Row>
          ) : null}
        </Stack>

        {models.length && !editing ? (
          <Stack gap="xs">
            {read(modelsExpandedFor) === provider.name ? (
              <>
                <Box maxHeight={220} scroll="y">
                  <Stack gap="xs">
                    {models.map((model) => (
                      <Text key={model} size="xs">
                        {model}
                      </Text>
                    ))}
                  </Stack>
                </Box>
                <Button size="xs" variant="ghost" icon="collapse" onPress={() => set(modelsExpandedFor, '')}>
                  Show less
                </Button>
              </>
            ) : (
              <Row gap="xs" align="center">
                <Box grow minWidth={0}>
                  <Text muted size="xs" truncate>
                    {models.slice(0, 6).join(', ')}
                    {models.length > 6 ? ', ...' : ''}
                  </Text>
                </Box>
                {models.length > 4 ? (
                  <Box shrink={false}>
                    <Link onPress={() => set(modelsExpandedFor, provider.name)}>Show all</Link>
                  </Box>
                ) : null}
              </Row>
            )}
          </Stack>
        ) : editing ? null : (
          <Text muted size="xs">
            No models discovered
          </Text>
        )}

        {editing ? (
          <Stack gap="xs">
            <Row gap="xs" align="center">
              <Text size="xs" muted>
                Display name
              </Text>
              <Box grow>
                <Input
                  label="Display name"
                  labelHidden
                  placeholder={provider.name}
                  value={read(providerEditDisplayName)}
                  onChange={(value) => set(providerEditDisplayName, value)}
                />
              </Box>
            </Row>
            <FormGroup
              title={read(providerEditEndpoints).length > 1 ? 'Endpoints' : 'Endpoint'}
              description="Base URLs and the protocols each one serves."
            >
                {read(providerEditEndpoints).map((endpoint, index) => (
              <Stack key={index} gap="xs">
                <Row gap="xs" align="center">
                  <Text size="xs" muted>
                    {read(providerEditEndpoints).length > 1 ? `Base URL ${index + 1}` : 'Base URL'}
                  </Text>
                  <Box grow>
                    <Input
                      label={read(providerEditEndpoints).length > 1 ? `Base URL ${index + 1}` : 'Base URL'}
                      labelHidden
                      placeholder="https://api.example.com/v1"
                      value={endpoint.baseUrl}
                      onChange={(value) => updateEditEndpoint(index, { baseUrl: value })}
                    />
                  </Box>
                  {read(providerEditEndpoints).length > 1 ? (
                    <IconButton
                      size="xs"
                      icon="delete"
                      label={`Remove endpoint ${index + 1}`}
                      tooltip="Remove endpoint"
                      onPress={() =>
                        set(
                          providerEditEndpoints,
                          read(providerEditEndpoints).filter((_, position) => position !== index)
                        )
                      }
                    />
                  ) : null}
                </Row>
                <Text muted size="xs">
                  Protocol
                </Text>
                <ProtocolChips
                  active={(id) => endpoint.protocols.includes(id)}
                  onToggle={(id, next) => toggleEditEndpointProtocol(index, id, next)}
                />
                </Stack>
              ))}
                <Row gap="xs" wrap align="center">
                  <Button
                    size="xs"
                    variant="outline"
                    icon="add"
                    onPress={() =>
                      set(providerEditEndpoints, [
                        ...read(providerEditEndpoints),
                        { baseUrl: '', protocols: [] }
                      ])
                    }
                  >
                    Add endpoint
                  </Button>
                </Row>
              </FormGroup>
              <FormGroup title="Models" description="Model IDs, optionally `id | contextWindow | maxOutput`.">
                <Textarea
                label="Model IDs"
                labelHidden
                placeholder={'gpt-4o | 128000 | 16384\nclaude-sonnet-4-20250514'}
                rows={4}
                value={read(providerEditModels)}
                onChange={(value) => set(providerEditModels, value)}
              />
                <Row gap="xs" wrap align="center">
                  <Button
                    size="xs"
                    variant="outline"
                    icon="search"
                    disabled={read(fetchingModels)}
                    onPress={() => void fetchEditModels(provider.name)}
                  >
                    {read(fetchingModels) ? 'Fetching…' : 'Fetch models'}
                  </Button>
                </Row>
                <ModelPicker
                  token={`edit:${provider.name}`}
                  saveLabel="Use"
                  onSave={() => applyPickedModelsTo(providerEditModels, 'Updated the model list')}
                  onCancel={closeModelPicker}
                />
              </FormGroup>
              <Row gap="xs" wrap>
                <Button size="xs" variant="solid" tone="accent" onPress={() => void saveProviderEdit(provider.name)}>
                Save changes
              </Button>
              <Button size="xs" variant="ghost" onPress={() => set(providerEditFor, '')}>
                Cancel
              </Button>
            </Row>
            <FormGroup title="Usage source">
                <Input
                  label="Usage endpoint"
              placeholder="https://api.example.com/v1/credits"
              value={read(usageDraft).endpoint}
              onChange={(value) => set(usageDraft, { ...read(usageDraft), endpoint: value })}
            />
            <Select
              label="Auth"
              value={read(usageDraft).auth}
              options={[
                { value: 'provider-api-key', label: 'Bearer provider key' },
                { value: 'none', label: 'No auth' }
              ]}
              onChange={(value) => set(usageDraft, { ...read(usageDraft), auth: value })}
            />
            <Textarea
              label="Meters JSON"
              placeholder={'[{"id":"balance","kind":"balance","label":"Balance","remaining":"$.data.balance","unit":"USD"}]'}
              rows={5}
              value={read(usageDraft).meters}
              onChange={(value) => set(usageDraft, { ...read(usageDraft), meters: value })}
            />
            <Text muted size="xs">
              Map JSON fields with paths like $.data.balance. Set limit, used, or remaining; remaining is derived from limit minus used.
            </Text>
                <Row gap="xs" wrap>
                  <Button size="xs" variant="outline" onPress={() => void saveUsageSource(provider.name)}>
                    Save usage source
                  </Button>
                  {cfg?.usageFetch?.connectors?.length ? (
                    <Button size="xs" variant="ghost" onPress={() => void clearUsageSource(provider.name)}>
                      Remove usage source
                    </Button>
                  ) : null}
                </Row>
              </FormGroup>
          </Stack>
        ) : null}

        <Row gap="xs" wrap align="center">
          <Button size="xs" variant="outline" icon="activity" onPress={() => void testProvider(provider.name)}>
            Test
          </Button>
          <Button size="xs" variant="ghost" icon="search" disabled={read(fetchingModels)} onPress={() => void discover(provider.name)}>
            Fetch models
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon="edit"
            onPress={() => (editing ? set(providerEditFor, '') : startEditProvider(provider))}
          >
            {editing ? 'Close' : 'Edit'}
          </Button>
          <IconButton
            size="xs"
            icon="delete"
            label={`Remove provider ${provider.name}`}
            tooltip={`Remove ${provider.displayName || provider.name}`}
            onPress={() => set(confirmTarget, `provider:${provider.name}`)}
          />
        </Row>

        {note?.provider === provider.name ? (
          <Row gap="xs" align="center" wrap>
            <Text size="xs" tone={note.tone} muted={note.tone === 'neutral'}>
              {note.text}
            </Text>
            {detected?.provider === provider.name ? (
              <Button size="xs" variant="ghost" onPress={() => void saveDetectedUsage(provider.name)}>
                Save usage source
              </Button>
            ) : null}
            {note.action === 'configure' ? (
              <Button size="xs" variant="ghost" onPress={() => startEditProvider(provider)}>
                Set up
              </Button>
            ) : null}
          </Row>
        ) : null}

        <ModelPicker
          token={`provider:${provider.name}`}
          saving={read(modelPickerSaving)}
          onSave={() => void savePickedModels(provider.name)}
          onCancel={closeModelPicker}
        />

        {read(confirmTarget) === `provider:${provider.name}` ? (
          <ConfirmDelete
            confirmLabel="Delete provider"
            message={`Delete ${provider.displayName || provider.name}${
              keyCount ? ` and its ${keyCount} key${keyCount === 1 ? '' : 's'}` : ''
            }? This can't be undone.`}
            onConfirm={() => {
              set(confirmTarget, '')
              void removeProvider(provider.name)
            }}
            onCancel={() => set(confirmTarget, '')}
          />
        ) : null}

        <Stack gap="sm">
          <Row justify="between" align="center" gap="sm" wrap>
            <Text size="sm" weight="semibold">
              Keys
            </Text>
            <Row gap="xs" wrap align="center">
              <Button
                size="xs"
                variant="ghost"
                icon="bar-chart-3"
                disabled={read(usageBusy) === provider.name}
                tooltip={provider.usageSource ? 'Fetch the provider\'s reported usage' : 'Probe for a usage source'}
                onPress={() => void fetchUsage(provider.name)}
              >
                {read(usageBusy) === provider.name ? 'Checking...' : 'Fetch usage'}
              </Button>
              {formOpen ? null : (
                <Button
                  size="xs"
                  variant="outline"
                  icon="add"
                  onPress={() => {
                    set(keyDrafts, [blankKeyDraft()])
                    set(keyFormFor, provider.name)
                  }}
                >
                  Add key
                </Button>
              )}
            </Row>
          </Row>

          {formOpen ? (
            <Stack gap="sm">
              {drafts.map((draft, index) => (
                <Box key={index} background="muted" radius="md" padding="sm">
                  <Stack gap="sm">
                    <Row justify="between" align="center" gap="sm">
                      <Text size="sm" weight="semibold">
                        Key {index + 1}
                      </Text>
                      {drafts.length > 1 ? (
                        <IconButton
                          size="xs"
                          icon="delete"
                          label={`Remove key ${index + 1}`}
                          tooltip="Remove this key"
                          onPress={() => removeKeyDraft(index)}
                        />
                      ) : null}
                    </Row>
                    <Input
                      label="API key"
                      type="password"
                      placeholder="sk-..."
                      value={draft.value}
                      onChange={(value) => updateKeyDraft(index, { value })}
                    />
                    <Row justify="between" align="center" gap="sm" wrap>
                      <Text muted size="xs" truncate>
                        Saved as: {draftNames[index]}
                      </Text>
                      <Button size="xs" variant="ghost" onPress={() => updateKeyDraft(index, { open: !draft.open })}>
                        {draft.open ? 'Hide options' : 'Options'}
                      </Button>
                    </Row>
                    {draft.open ? (
                      <Stack gap="sm">
                        <Input
                          label="Key name"
                          placeholder={draftNames[index]}
                          value={draft.name}
                          onChange={(value) => updateKeyDraft(index, { name: value })}
                        />
                        <Input
                          label="Priority"
                          placeholder="0"
                          value={draft.priority}
                          onChange={(value) => updateKeyDraft(index, { priority: value })}
                        />
                        <Input
                          label="Weight"
                          placeholder="1"
                          value={draft.weight}
                          onChange={(value) => updateKeyDraft(index, { weight: value })}
                        />
                        <Input
                          label="Limits JSON"
                          placeholder='{"rpm":60,"rpd":1000}'
                          value={draft.limits}
                          onChange={(value) => updateKeyDraft(index, { limits: value })}
                        />
                      </Stack>
                    ) : null}
                  </Stack>
                </Box>
              ))}
              <Button size="xs" variant="outline" icon="add" onPress={addAnotherKey}>
                Add another key
              </Button>
              <Row gap="xs" wrap>
                <Button size="xs" variant="solid" tone="accent" onPress={() => void submitKeyDrafts(provider.name)}>
                  {filledDrafts > 1 ? `Add ${filledDrafts} keys` : 'Add key'}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onPress={() => {
                    set(keyFormFor, '')
                    set(keyDrafts, [])
                  }}
                >
                  Cancel
                </Button>
              </Row>
              <Text muted size="xs">
                Stored in Orca's secret store. Limits: rpm/rph/rpd, tpm/tph/tpd, ipm/iph/ipd.
              </Text>
            </Stack>
          ) : null}

          {pool.map((key) => {
            const token = `key:${provider.name}:${key.secretKey}`
            const editToken = `key-edit:${provider.name}:${key.secretKey || key.id || ''}`
            const editingKey = read(keyEditFor) === editToken
            const keyUsageEntry = keyUsage.get(key.secretKey)
            const keyQuotaEntry = keyQuota.get(key.secretKey)
            const rateLines = keyRateLines(keyUsageEntry, keyQuotaEntry)
            const keyMeta = [
              (key.priority ?? 0) !== 0 ? `Priority ${key.priority}` : '',
              (key.weight ?? 1) !== 1 ? `Weight ${key.weight}` : '',
              key.limits && Object.keys(key.limits).length ? `Limits ${JSON.stringify(key.limits)}` : ''
            ].filter(Boolean).join(' · ')
            return (
              <Stack key={key.secretKey || key.id} gap="sm">
                <Row justify="between" align="start" gap="sm">
                  <Box grow minWidth={120}>
                    <Row gap="xs" align="center">
                      <Box minWidth={0} maxWidth={160}>
                        <Text size="xs" weight="medium" truncate>
                          {key.id || key.secretKey}
                        </Text>
                      </Box>
                      <Box shrink={false}>
                        <Switch
                          label={'\u200B'}
                          checked={key.enabled !== false}
                          onChange={(checked) => void updateProviderKey(provider.name, key.secretKey, { enabled: checked })}
                        />
                      </Box>
                      <KeyBadges usage={keyUsageEntry} quota={keyQuotaEntry} />
                    </Row>
                  </Box>
                  {rateLines.length ? (
                    <Box shrink={false}>
                      <Stack gap="xs" align="end">
                        {rateLines.map((line, index) => (
                          <Text key={`${index}-${line}`} muted size="xs">
                            {line}
                          </Text>
                        ))}
                      </Stack>
                    </Box>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost"
                    icon="edit"
                    tooltip="Edit key options"
                    onPress={() => {
                      if (editingKey) closeKeyEdit()
                      else startKeyEdit(provider.name, key)
                    }}
                  >
                    {editingKey ? 'Close' : 'Options'}
                  </Button>
                </Row>
                <KeyUsageBar usage={keyUsageEntry} quota={keyQuotaEntry} />
                {!editingKey && keyMeta ? (
                  <Text muted size="xs">
                    {keyMeta}
                  </Text>
                ) : null}
                {editingKey ? (
                  <Stack gap="sm">
                    <Row justify="between" align="center" gap="sm" wrap>
                      <Row gap="xs" align="center" wrap>
                        {read(keyEditValueOpen) ? null : (
                          <Button
                            size="xs"
                            variant="ghost"
                            icon="edit"
                            disabled={read(keyEditValueLoading)}
                            onPress={() => void openKeyValueEdit(provider.name, key.secretKey)}
                          >
                            {read(keyEditValueLoading) ? 'Loading…' : 'Edit key'}
                          </Button>
                        )}
                        <Button size="xs" variant="ghost" icon="copy" onPress={() => void copyProviderKey(key.secretKey)}>
                          Copy key
                        </Button>
                      </Row>
                      <Button
                        size="xs"
                        variant="ghost"
                        icon="delete"
                        tone="danger"
                        onPress={() => {
                          closeKeyEdit()
                          set(confirmTarget, token)
                        }}
                      >
                        Remove key
                      </Button>
                    </Row>
                    {read(keyEditValueOpen) ? (
                      <Stack gap="sm">
                        <Input
                          label="API key"
                          type="text"
                          placeholder="Paste the replacement key"
                          value={read(keyEditValue)}
                          onChange={(value) => set(keyEditValue, value)}
                        />
                        <Row justify="end" gap="xs">
                          <Button
                            size="xs"
                            variant="ghost"
                            onPress={() => {
                              set(keyEditValue, '')
                              set(keyEditValueOpen, false)
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="xs"
                            variant="solid"
                            tone="accent"
                            onPress={() => void saveKeyValueEdit(provider.name, key.secretKey)}
                          >
                            Save key
                          </Button>
                        </Row>
                      </Stack>
                    ) : null}
                    <Separator />
                    <Input
                      label="Key name"
                      placeholder={key.secretKey}
                      value={read(keyEditName)}
                      onChange={(value) => set(keyEditName, value)}
                    />
                    <Row gap="sm" align="start">
                      <Input
                        label="Priority"
                        placeholder="0"
                        value={read(keyEditPriority)}
                        onChange={(value) => set(keyEditPriority, value)}
                      />
                      <Input
                        label="Weight"
                        placeholder="1"
                        value={read(keyEditWeight)}
                        onChange={(value) => set(keyEditWeight, value)}
                      />
                    </Row>
                    <Input
                      label="Limits JSON"
                      placeholder='{"rpm":60,"rpd":1000}'
                      value={read(keyEditLimits)}
                      onChange={(value) => set(keyEditLimits, value)}
                    />
                    <Row gap="xs">
                      <Button size="xs" variant="solid" tone="accent" onPress={() => void saveKeyEdit(provider.name, key.secretKey)}>
                        Save key options
                      </Button>
                      <Button size="xs" variant="ghost" onPress={closeKeyEdit}>
                        Cancel
                      </Button>
                    </Row>
                  </Stack>
                ) : null}
                {read(confirmTarget) === token ? (
                  <ConfirmDelete
                    message={`Remove key ${key.id || key.secretKey} from ${provider.name}?`}
                    onConfirm={() => {
                      set(confirmTarget, '')
                      void removeProviderKey(provider.name, key.secretKey)
                    }}
                    onCancel={() => set(confirmTarget, '')}
                  />
                ) : null}
              </Stack>
            )
          })}
        </Stack>
      </Stack>
    </Card>
  )
}

function vpnServers(): VpnServerConfig[] {
  return read(config)?.vpnServers ?? []
}

function resetVpnForm() {
  set(vpnFormOpen, false)
  set(vpnEditId, '')
  set(vpnName, '')
  set(vpnType, 'socks5')
  set(vpnHost, '')
  set(vpnPort, '')
  set(vpnUsername, '')
  set(vpnPassword, '')
}

function startEditVpn(server: VpnServerConfig) {
  set(vpnEditId, server.id)
  set(vpnName, server.name)
  set(vpnType, server.type)
  set(vpnHost, server.host)
  set(vpnPort, String(server.port))
  // Never prefill credentials from storage; leaving them blank keeps the
  // existing secret. The panel only reads secrets for an explicit edit.
  set(vpnUsername, '')
  set(vpnPassword, '')
  set(vpnFormOpen, true)
}

async function saveVpnServer() {
  const host = read(vpnHost).trim()
  const port = Number(read(vpnPort))
  if (!host) {
    set(error, 'VPN server needs a host')
    return
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    set(error, 'VPN port must be between 1 and 65535')
    return
  }
  try {
    const result = await plugin.request('router.vpn.save', {
      server: {
        ...(read(vpnEditId) ? { id: read(vpnEditId) } : {}),
        name: read(vpnName).trim() || host,
        type: read(vpnType),
        host,
        port
      },
      username: read(vpnUsername),
      password: read(vpnPassword)
    }) as { server: VpnServerConfig }
    resetVpnForm()
    set(message, `Saved VPN server ${result.server.name}`)
    await refresh()
  } catch (cause) {
    set(error, `Save failed: ${(cause as Error).message}`)
  }
}

async function removeVpnServer(id: string) {
  try {
    await plugin.request('router.vpn.remove', { id })
    resetVpnForm()
    set(message, 'VPN server removed')
    await refresh()
  } catch (cause) {
    set(error, `Remove failed: ${(cause as Error).message}`)
  }
}

function VpnServersCard() {
  const servers = vpnServers()
  const editing = Boolean(read(vpnEditId))
  return (
    <Card
      title="VPN / proxy servers"
      description="Reusable HTTP CONNECT or SOCKS5 servers. Add as many as you like, then attach one to a route under Routing to tunnel that route's traffic through it."
    >
      <Stack gap="sm">
        {servers.some((server) => server.id === 'sample-us-proxy' || server.name.includes('(sample)')) ? (
          <Callout tone="warning">
            <Text size="xs">
              The sample public proxy is untrusted: its operator can see your prompts and provider keys, and it may stop
              working at any time. Use it only for a quick test, then replace it with your own VPN.
            </Text>
          </Callout>
        ) : null}
        {servers.length ? (
          <Stack gap="xs">
            {servers.map((server) => (
              <Box key={server.id} direction="row" align="center" gap="sm" background="muted" radius="md" padding="sm" wrap>
                <Box grow minWidth={0}>
                  <Stack gap="xs">
                    <Row gap="xs" align="center" wrap>
                      <Text size="sm" weight="medium" truncate>{server.name}</Text>
                      <Badge tone="neutral">{server.type.toUpperCase()}</Badge>
                      {server.enabled === false ? <Badge tone="neutral">disabled</Badge> : null}
                      {server.secretKey ? <Badge tone="success">auth</Badge> : null}
                    </Row>
                    <Text muted size="xs" truncate>{server.host}:{server.port}</Text>
                  </Stack>
                </Box>
                <Row gap="xs" align="center">
                  <IconButton size="xs" icon="edit" label={`Edit VPN ${server.name}`} tooltip="Edit" onPress={() => startEditVpn(server)} />
                  <IconButton size="xs" icon="delete" label={`Remove VPN ${server.name}`} tooltip="Remove" onPress={() => void removeVpnServer(server.id)} />
                </Row>
              </Box>
            ))}
          </Stack>
        ) : (
          <Text muted size="xs">No servers yet. Add one below, then pick it on a route.</Text>
        )}

        <Button
          size="xs"
          variant="outline"
          icon={read(vpnFormOpen) ? 'close' : 'add'}
          onPress={() => { if (read(vpnFormOpen)) resetVpnForm(); else set(vpnFormOpen, true) }}
        >
          {read(vpnFormOpen) ? 'Cancel' : editing ? 'Edit VPN server' : 'Add VPN server'}
        </Button>

        {read(vpnFormOpen) ? (
          <Stack gap="sm">
            <Input label="Server name" placeholder="Home proxy" value={read(vpnName)} onChange={(value) => set(vpnName, value)} />
            <Select
              label="Protocol"
              value={read(vpnType)}
              options={[
                { value: 'socks5', label: 'SOCKS5' },
                { value: 'http', label: 'HTTP CONNECT proxy' }
              ]}
              onChange={(value) => set(vpnType, value as 'http' | 'socks5')}
            />
            <Row gap="sm" wrap>
              <Box grow minWidth={0}>
                <Input label="Server host" placeholder="127.0.0.1" value={read(vpnHost)} onChange={(value) => set(vpnHost, value)} />
              </Box>
              <Box width={120}>
                <Input label="Server port" placeholder={read(vpnType) === 'socks5' ? '1080' : '8080'} value={read(vpnPort)} onChange={(value) => set(vpnPort, value)} />
              </Box>
            </Row>
            <Text muted size="xs">
              {read(vpnType) === 'socks5'
                ? 'Hostnames are resolved by the proxy, so DNS queries do not leave locally.'
                : 'The proxy receives a CONNECT for each upstream endpoint.'}
            </Text>
            <Separator />
            <Text size="sm" weight="semibold">Credentials (optional)</Text>
            <Text muted size="xs">
              Stored in Orca's secret store. Leave blank when editing to keep the current credentials.
            </Text>
            <Input label="Proxy username" value={read(vpnUsername)} onChange={(value) => set(vpnUsername, value)} />
            <Input label="Proxy password" value={read(vpnPassword)} onChange={(value) => set(vpnPassword, value)} />
            <Row justify="end">
              <Button size="xs" variant="solid" tone="accent" onPress={() => void saveVpnServer()}>
                {editing ? 'Save VPN server' : 'Add VPN server'}
              </Button>
            </Row>
          </Stack>
        ) : null}
      </Stack>
    </Card>
  )
}

function SchedulerSettings() {
  const cfg = read(config)
  const scheduler = cfg?.scheduler ?? {}
  const circuit = cfg?.circuitBreaker ?? {}
  const saveScheduler = (patch: NonNullable<RouterConfig['scheduler']>) => {
    void saveConfig((next) => {
      next.scheduler = { ...(next.scheduler ?? {}), ...patch }
    })
  }
  const saveCircuit = (patch: NonNullable<RouterConfig['circuitBreaker']>) => {
    void saveConfig((next) => {
      next.circuitBreaker = { ...(next.circuitBreaker ?? {}), ...patch }
    })
  }
  return (
    <Card
      title="Key scheduling"
      description="How each provider's key pool is used, and when a provider is skipped after repeated failures."
    >
      <Stack gap="sm">
        <Heading level={3}>Key pool</Heading>
        <Switch
          label="Priority tiers"
          checked={scheduler.priorityTiers !== false}
          onChange={(checked) => saveScheduler({ priorityTiers: checked })}
        />
        <Text muted size="xs">
          Lower priority numbers go first. Higher tiers are used only when the preferred tier is cooling, exhausted,
          or has no headroom left.
        </Text>
        <Switch
          label="Prefer keys with headroom"
          checked={scheduler.utilizationAware !== false}
          onChange={(checked) => saveScheduler({ utilizationAware: checked })}
        />
        <Text muted size="xs">
          Skip keys that are close to a configured limit while another key has room. The Weight option controls that
          key's share of traffic.
        </Text>
        <Switch
          label="Keep sessions on one key"
          checked={scheduler.cacheAffinity !== false}
          onChange={(checked) => saveScheduler({ cacheAffinity: checked })}
        />
        <Text muted size="xs">
          Reuse the same key for a session header or an identical prompt prefix, keeping upstream prompt caches warm.
        </Text>

        <Separator />
        <Heading level={3}>Circuit breaker</Heading>
        <Switch
          label="Provider circuit breaker"
          checked={circuit.enabled !== false}
          onChange={(checked) => saveCircuit({ enabled: checked })}
        />
        <Text muted size="xs">
          Temporarily skip a provider after repeated 5xx or timeout failures, then let one probe through after the
          cooldown.
        </Text>
        <Text muted size="xs">
          When every key is cooling or over its limit, requests return HTTP 420 with code{' '}
          <Code>all_keys_exhausted</Code>.
        </Text>
      </Stack>
    </Card>
  )
}

function Usage() {
  const metric = read(usage)
  const dailyRows = metric?.daily?.slice(-7) ?? []
  const providerSpendRows = [...(metric?.byProviderSpend ?? [])].sort((a, b) => b.cost - a.cost).slice(0, 5)
  const maxDailyTokens = Math.max(1, ...dailyRows.map((day) => day.input + day.output + day.cacheRead + day.cacheWrite))
  const maxDailyCost = Math.max(0.000001, ...dailyRows.map((day) => day.cost))
  const maxProviderCost = Math.max(0.000001, ...providerSpendRows.map((row) => row.cost))
  const attribution: { label: string; value: string }[] = [
    ...(metric?.byRoute?.length ? [{ label: 'Route', value: metric.byRoute.slice(0, 3).map((item) => `${item.route} ${formatUsd(item.cost)}${item.failovers ? ` (${item.failovers} failovers)` : ''}`).join(' · ') }] : []),
    ...(metric?.byAgent?.length ? [{ label: 'Agent', value: metric.byAgent.slice(0, 3).map((item) => `${item.agent} ${formatUsd(item.cost)}`).join(' · ') }] : []),
    ...(metric?.byKey?.length ? [{ label: 'Key', value: metric.byKey.slice(0, 3).map((item) => `${item.credential} ${formatUsd(item.cost)}`).join(' · ') }] : [])
  ]
  if (!metric || (!dailyRows.length && !providerSpendRows.length && !attribution.length)) {
    return <EmptyState title="No usage recorded" description="Send a request through the gateway and refresh to see usage here." />
  }
  const modelRows = (metric.modelUsage ?? []).slice(0, 8).map((row) => ({
    key: row.model,
    model: row.model,
    input: formatNumber(row.input),
    output: formatNumber(row.output),
    cache: formatNumber(row.cacheRead + row.cacheWrite),
    cost: formatUsd(row.cost)
  }))
  return (
    <Stack gap="md">
      <Card title="Overview">
        <Grid columns={2} gap="md">
          <Metric
            label="Tokens"
            value={formatNumber(metric.totalTokens)}
            hint={`${formatNumber(metric.inputTokens)} in · ${formatNumber(metric.outputTokens)} out`}
          />
          <Metric label="Cost" value={formatUsd(metric.cost)} />
        </Grid>
      </Card>
      {modelRows.length ? (
        <Card title="Tokens by model">
          <Table
            label="Tokens by model"
            columns={[
              { key: 'model', label: 'Model' },
              { key: 'input', label: 'In' },
              { key: 'output', label: 'Out' },
              { key: 'cache', label: 'Cache' },
              { key: 'cost', label: 'Cost' }
            ]}
            rows={modelRows}
            emptyText="No model usage yet"
          />
        </Card>
      ) : null}
      {providerSpendRows.length ? (
        <Card title="Cost by provider" description="Estimated spend in this window">
          <Stack gap="xs">
            {providerSpendRows.map((row) => (
              <TrendBar key={row.provider} label={row.provider} value={row.cost} max={maxProviderCost} display={formatUsd(row.cost)} tone="warning" />
            ))}
          </Stack>
        </Card>
      ) : null}
      {attribution.length ? (
        <Card title="Spend attribution" description="Which route, agent and key spent it">
          <KeyValue items={attribution} />
        </Card>
      ) : null}
      {dailyRows.length ? (
        <Card title="Daily activity" description="Last 7 days with traffic">
          <Stack gap="md">
            <Stack gap="xs">
              <Text muted size="xs">Tokens by day</Text>
              {dailyRows.map((day) => {
                const total = day.input + day.output + day.cacheRead + day.cacheWrite
                return <TrendBar key={day.day} label={day.day.slice(5)} value={total} max={maxDailyTokens} display={formatNumber(total)} />
              })}
            </Stack>
            <Stack gap="xs">
              <Text muted size="xs">Cost by day</Text>
              {dailyRows.map((day) => (
                <TrendBar key={`cost-${day.day}`} label={day.day.slice(5)} value={day.cost} max={maxDailyCost} display={formatUsd(day.cost)} tone="success" />
              ))}
              {dailyRows.some((day) => day.failovers > 0) ? (
                <Text muted size="xs">
                  Failovers on {dailyRows.reduce((sum, day) => sum + day.failovers, 0)} requests in this window.
                </Text>
              ) : null}
            </Stack>
          </Stack>
        </Card>
      ) : null}
      {metric && (metric.unpricedRequests ?? 0) > 0 ? (
        <Text muted size="xs">
          {formatNumber(metric.unpricedRequests ?? 0)} requests used a model with no known price — cost is a lower bound.
        </Text>
      ) : null}
    </Stack>
  )
}

function Providers() {
  const ups = read(providers)
  const preset = findPreset(read(presetId))
  return (
    <Stack gap="md">
      <InfoBanner
        title="What providers are"
        open={read(providersInfoOpen) ?? ups.length === 0}
        onOpenChange={(open) => set(providersInfoOpen, open)}
      >
        <Text size="sm">
          Providers are the model services your agents reach through the gateway — OpenAI, Anthropic, Gemini, a local
          server, a free web-chat account, or any compatible endpoint. Each owns its endpoints, protocols, model list
          and key pool. Keys are rotated by priority and weight, stored only as names in Orca's secret store, and a
          provider is skipped while its circuit is open. Use <Code>Test all</Code> to check connectivity and{' '}
          <Code>Fetch all models</Code> to pick which models it offers.
        </Text>
      </InfoBanner>

      <AddSection
        label="Add provider"
        open={read(addProviderOpen)}
        onOpenChange={(open) => set(addProviderOpen, open)}
        extra={
          <Row gap="xs" wrap>
            <Button variant="outline" icon="search" disabled={read(globalModelsFetching)} onPress={() => void fetchAllModels()}>
              {read(globalModelsFetching) ? 'Fetching...' : 'Fetch all models'}
            </Button>
            <Button variant="outline" icon="refresh" onPress={() => void testProviders()}>
              Test all
            </Button>
          </Row>
        }
      >
        <Stack gap="sm">
          <Row gap="xs" wrap>
            <Button
              size="xs"
              variant={read(addMode) === 'preset' ? 'solid' : 'outline'}
              tone={read(addMode) === 'preset' ? 'accent' : undefined}
              onPress={() => {
                set(addMode, 'preset')
                set(customKeys, [blankKeyDraft()])
              }}
            >
              From preset
            </Button>
            <Button
              size="xs"
              variant={read(addMode) === 'custom' ? 'solid' : 'outline'}
              tone={read(addMode) === 'custom' ? 'accent' : undefined}
              onPress={() => {
                set(addMode, 'custom')
                set(presetNameEditing, false)
                set(presetKeys, [blankKeyDraft()])
              }}
            >
              Custom provider
            </Button>
            <Button
              size="xs"
              variant={read(addMode) === 'webchat' ? 'solid' : 'outline'}
              tone={read(addMode) === 'webchat' ? 'accent' : undefined}
              onPress={() => {
                set(addMode, 'webchat')
                void refreshWebchat()
              }}
            >
              Web chat
            </Button>
          </Row>

          {read(addMode) === 'preset' ? (
            <Stack gap="sm">
              <Select
                label="Preset"
                value={read(presetId)}
                placeholder="Choose a provider preset"
                options={read(presetList).map((item) => ({ value: item.id, label: `${item.name} — ${item.id}` }))}
                onChange={(value) => set(presetId, value)}
              />
              <Text muted size="xs">
                {presetDescription(preset)}
              </Text>
              {preset?.defaultModels.length ? (
                <Text muted size="xs">
                  Suggested models: {preset.defaultModels.join(', ')}
                </Text>
              ) : null}
              <InlineNameField
                label="Provider name"
                value={presetProviderName()}
                placeholder={presetProviderName()}
                editing={read(presetNameEditing)}
                onEdit={() => set(presetNameEditing, true)}
                onChange={(value) => set(presetName, value)}
              />
              <FormGroup title="Keys" description="Stored in Orca's secret store.">
                <KeyDraftRows
                  drafts={read(presetKeys)}
                  taken={existingSecretNames()}
                  onChange={(index, patch) => patchDraft(presetKeys, index, patch)}
                  onRemove={(index) => dropDraft(presetKeys, index)}
                />
                <Button size="xs" variant="outline" icon="add" onPress={() => appendDraft(presetKeys)}>
                  Add another key
                </Button>
              </FormGroup>
              <Row gap="xs" wrap>
                <Button variant="solid" tone="accent" disabled={!read(presetId)} onPress={() => void addPresetProvider()}>
                  Add provider
                </Button>
              </Row>
              <Text muted size="xs">
                Add as many keys as you like; they form the provider's pool. Names are filled in for you, and keys are
                stored in Orca's secret store.
              </Text>
            </Stack>
          ) : read(addMode) === 'webchat' ? (
            <WebChat />
          ) : (
            <Stack gap="sm">
              <Row gap="xs" align="center">
                <Text size="xs" muted>
                  Provider name
                </Text>
                <Box grow>
                  <Input label="Name" labelHidden placeholder="my-provider" value={read(customName)} onChange={(value) => set(customName, value)} />
                </Box>
              </Row>
              <FormGroup
                title={read(customEndpoints).length > 1 ? 'Endpoints' : 'Endpoint'}
                description="Base URLs and the protocols each one serves."
              >
                {read(customEndpoints).map((endpoint, index) => (
                  <Stack key={index} gap="xs">
                    <Row gap="xs" align="center">
                      <Text size="xs" muted>
                        {read(customEndpoints).length > 1 ? `Base URL ${index + 1}` : 'Base URL'}
                      </Text>
                      <Box grow>
                        <Input
                          label={read(customEndpoints).length > 1 ? `Base URL ${index + 1}` : 'Base URL'}
                          labelHidden
                          placeholder="https://api.example.com/v1 or http://127.0.0.1:11434/v1"
                          value={endpoint.baseUrl}
                          onChange={(value) => updateCustomEndpoint(index, { baseUrl: value })}
                        />
                      </Box>
                      {read(customEndpoints).length > 1 ? (
                        <IconButton
                          size="xs"
                          icon="delete"
                          label={`Remove endpoint ${index + 1}`}
                          tooltip="Remove endpoint"
                          onPress={() =>
                            set(customEndpoints, read(customEndpoints).filter((_, position) => position !== index))
                          }
                        />
                      ) : null}
                    </Row>
                    <Text muted size="xs">
                      Protocol
                    </Text>
                    <ProtocolChips
                      active={(id) => endpoint.protocols.includes(id)}
                      onToggle={(id, next) => toggleCustomEndpointProtocol(index, id, next)}
                    />
                  </Stack>
                ))}
                <Row gap="xs" wrap align="center">
                  <Button
                    size="xs"
                    variant="outline"
                    icon="add"
                    onPress={() => set(customEndpoints, [...read(customEndpoints), { baseUrl: '', protocols: [] }])}
                  >
                    Add endpoint
                  </Button>
                </Row>
              </FormGroup>
              <FormGroup title="Models" description="Model IDs, optionally `id | contextWindow | maxOutput`.">
                <Textarea
                  label="Model IDs"
                  labelHidden
                  placeholder={'gpt-4o | 128000 | 16384\nclaude-sonnet-4-20250514'}
                  rows={4}
                  value={read(customModels)}
                  onChange={(value) => set(customModels, value)}
                />
                <Row gap="xs" wrap align="center">
                  <Button
                    size="xs"
                    variant="outline"
                    icon="search"
                    disabled={read(fetchingModels) || !read(customEndpoints)[0]?.baseUrl.trim()}
                    onPress={() => void fetchCustomModels()}
                  >
                    {read(fetchingModels) ? 'Fetching…' : 'Fetch models'}
                  </Button>
                </Row>
                <ModelPicker
                  token="custom"
                  saveLabel="Use"
                  onSave={() => applyPickedModelsTo(customModels, 'Updated the model list')}
                  onCancel={closeModelPicker}
                />
              </FormGroup>
              <FormGroup title="Usage source">
                <Input
                  label="Usage endpoint"
                  placeholder="https://api.example.com/v1/credits"
                  value={read(customUsageDraft).endpoint}
                  onChange={(value) => set(customUsageDraft, { ...read(customUsageDraft), endpoint: value })}
                />
                <Select
                  label="Auth"
                  value={read(customUsageDraft).auth}
                  options={[
                    { value: 'provider-api-key', label: 'Bearer provider key' },
                    { value: 'none', label: 'No auth' }
                  ]}
                  onChange={(value) => set(customUsageDraft, { ...read(customUsageDraft), auth: value })}
                />
                <Textarea
                  label="Meters JSON"
                  placeholder={'[{"id":"balance","kind":"balance","label":"Balance","remaining":"$.data.balance","unit":"USD"}]'}
                  rows={5}
                  value={read(customUsageDraft).meters}
                  onChange={(value) => set(customUsageDraft, { ...read(customUsageDraft), meters: value })}
                />
                <Text muted size="xs">
                  Map JSON fields with paths like $.data.balance. Set limit, used, or remaining; remaining is derived from
                  limit minus used.
                </Text>
              </FormGroup>
              <FormGroup title="Keys" description="Stored in Orca's secret store.">
                <KeyDraftRows
                  drafts={read(customKeys)}
                  taken={existingSecretNames()}
                  onChange={(index, patch) => patchDraft(customKeys, index, patch)}
                  onRemove={(index) => dropDraft(customKeys, index)}
                />
                <Button size="xs" variant="outline" icon="add" onPress={() => appendDraft(customKeys)}>
                  Add another key
                </Button>
              </FormGroup>
              <Row gap="xs" wrap>
                <Button variant="solid" tone="accent" onPress={() => void addCustomProvider()}>
                  Add provider
                </Button>
              </Row>
            </Stack>
          )}
        </Stack>
      </AddSection>

      <GlobalModelPicker />

      {ups.length ? (
        <Stack gap="sm">
          {ups.map((provider) => (
            <ProviderCard key={provider.name} provider={provider} />
          ))}
        </Stack>
      ) : null}
    </Stack>
  )
}

function PolicyCard({ policy, index }: { policy: RequestPolicy; index: number }) {
  const summary = [
    { label: 'When', value: conditionSummary(policy) },
    ...(policy.model ? [{ label: 'Default model', value: policy.model }] : []),
    { label: 'Rewrite', value: rewriteSummary(policy) },
    { label: 'Fallback', value: fallbackSummary(policy) }
  ]
  return (
    <Card title={policy.name}>
      <Stack gap="sm">
        <KeyValue items={summary} />
        <Row justify="between" align="center" wrap gap="sm">
          <Switch
            label="Enabled"
            checked={policy.enabled !== false}
            onChange={(checked) => void togglePolicy(index, checked)}
          />
          <Row gap="xs" align="center">
            <Button size="xs" variant="ghost" icon="edit" onPress={() => startEditPolicy(index)}>
              Edit
            </Button>
            <IconButton size="xs" icon="delete" label={`Delete policy ${policy.name}`} onPress={() => set(confirmTarget, `policy:${index}`)} />
          </Row>
        </Row>
        {read(confirmTarget) === `policy:${index}` ? (
          <ConfirmDelete
            confirmLabel="Delete policy"
            message={`Delete policy ${policy.name}? Traffic it matched falls through to the next policy.`}
            onConfirm={() => {
              set(confirmTarget, '')
              void removePolicy(index)
            }}
            onCancel={() => set(confirmTarget, '')}
          />
        ) : null}
      </Stack>
    </Card>
  )
}

function PoliciesCard() {
  const policyList = read(policies)
  return (
    <Card
      title="Global Policies"
      description="Ordered request matchers. The first one that matches can rewrite the request, set a default model, or append a fallback chain."
    >
    <Stack gap="md">
      <Row justify="end">
        <Button
          variant="solid"
          tone="accent"
          icon="add"
          onPress={() => {
            resetPolicyForm()
            set(policyOpen, true)
          }}
        >
          New policy
        </Button>
      </Row>

      {read(policyOpen) || read(policyEditIndex) >= 0 ? (
        <AddSection
          label={read(policyEditIndex) >= 0 ? 'Edit policy' : 'Add a policy'}
          open={read(policyOpen)}
          onOpenChange={(open) => {
            if (open) set(policyOpen, true)
            else cancelPolicyEdit()
          }}
        >
        <Stack gap="sm">
          <Heading level={3}>Match</Heading>
          <Input label="Policy name" placeholder="Claude requests" value={read(policyName)} onChange={(value) => set(policyName, value)} />
          <Switch
            label="Match all requests"
            checked={read(policyMatchAll)}
            onChange={(checked) => set(policyMatchAll, checked)}
          />
          {read(policyMatchAll) ? (
            <Text muted size="xs">
              This policy applies to every request that reaches it.
            </Text>
          ) : (
            <>
              <Select label="Match source" value={read(policySource)} options={SOURCE_OPTIONS} onChange={(value) => set(policySource, value)} />
              <Input label="Field" placeholder="model" value={read(policyField)} onChange={(value) => set(policyField, value)} />
              <Select label="Operator" value={read(policyOperator)} options={operatorOptions()} onChange={(value) => set(policyOperator, value)} />
              <Input label="Value" placeholder="claude-" value={read(policyValue)} onChange={(value) => set(policyValue, value)} />
            </>
          )}

          <Separator />
          <Heading level={3}>Default model</Heading>
          <Input
            label="Default model (optional)"
            placeholder="anthropic/claude-sonnet-4-20250514"
            value={read(policyModel)}
            onChange={(value) => set(policyModel, value)}
          />
          <Text muted size="xs">
            Used only when the request has no model set; it is applied before rewrites. Leave blank to route the model the agent sent.
            A route name works here too.
          </Text>

          <Separator />
          <Heading level={3}>Rewrites</Heading>
          {read(policyRewrites).length ? (
            <Stack gap="sm">
              {read(policyRewrites).map((draft, index) => (
                <Box key={index} background="muted" radius="md" padding="sm">
                  <Stack gap="sm">
                    <Row justify="between" align="center" gap="sm">
                      <Text size="sm" weight="semibold">
                        Rewrite {index + 1}
                      </Text>
                      <IconButton
                        size="xs"
                        icon="delete"
                        label={`Remove rewrite ${index + 1}`}
                        tooltip="Remove this rewrite"
                        onPress={() => removeRewriteDraft(index)}
                      />
                    </Row>
                    <Input
                      label="Path"
                      placeholder="request.body.model"
                      value={draft.key}
                      onChange={(value) => updateRewriteDraft(index, { key: value })}
                    />
                    <Select
                      label="Operation"
                      value={draft.operation}
                      options={REWRITE_OPERATIONS}
                      onChange={(value) => updateRewriteDraft(index, { operation: value })}
                    />
                    {draft.operation !== 'delete' ? (
                      <Input
                        label="Value"
                        placeholder="anthropic/claude-sonnet-4-20250514"
                        value={draft.value}
                        onChange={(value) => updateRewriteDraft(index, { value })}
                      />
                    ) : null}
                    {draft.operation === 'array-replace' ? (
                      <Input
                        label="Match value"
                        placeholder="value to replace"
                        value={draft.match}
                        onChange={(value) => updateRewriteDraft(index, { match: value })}
                      />
                    ) : null}
                  </Stack>
                </Box>
              ))}
            </Stack>
          ) : (
            <Text muted size="xs">
              No rewrites. The policy can still select a model or attach a fallback.
            </Text>
          )}
          <Button size="xs" variant="outline" icon="add" onPress={addRewriteDraft}>
            Add rewrite
          </Button>
          <Text muted size="xs">
            Paths use dot notation. JSON values such as numbers, booleans and objects are parsed automatically.
          </Text>

          <Separator />
          <Heading level={3}>Failover</Heading>
          <Text muted size="xs">
            A policy fallback runs after the primary target fails. Add routes or raw provider/model
            targets in the order they should be tried.
          </Text>
          <Row justify="between" align="center" wrap gap="sm">
            <Text size="xs" weight="semibold">
              Fallback chain
            </Text>
            <Button
              size="xs"
              variant="ghost"
              icon="code"
              onPress={() => {
                if (read(policyFallbackRaw)) {
                  set(policyFallback, splitModelList(read(policyFallbackText)))
                  set(policyFallbackRaw, false)
                } else {
                  set(policyFallbackText, read(policyFallback).join(', '))
                  set(policyFallbackRaw, true)
                }
              }}
            >
              {read(policyFallbackRaw) ? 'Use target list' : 'Edit as text'}
            </Button>
          </Row>
          {read(policyFallbackRaw) ? (
            <Input
              label="Fallback entries"
              placeholder="fast-route, openai/gpt-5"
              value={read(policyFallbackText)}
              onChange={(value) => set(policyFallbackText, value)}
            />
          ) : (
            <PolicyFallbackPicker entries={read(policyFallback)} onChange={(entries) => set(policyFallback, entries)} />
          )}

          <Button variant="solid" tone="accent" onPress={() => void addPolicy()}>
            {read(policyEditIndex) >= 0 ? 'Save policy' : 'Add policy'}
          </Button>
        </Stack>
      </AddSection>
      ) : null}

      {policyList.length ? (
        <Stack gap="sm">
          {policyList.map((policy, index) => (
            <PolicyCard key={`${policy.id ?? policy.name}-${index}`} policy={policy} index={index} />
          ))}
        </Stack>
      ) : (
        <Text muted size="sm">
          No policies yet. Add one to rewrite a request, set a default model, or append a fallback chain.
        </Text>
      )}
    </Stack>
    </Card>
  )
}

function PolicyFallbackPicker({
  entries,
  onChange
}: {
  entries: string[]
  onChange: (entries: string[]) => void
}) {
  const list = read(providers)
  const routeChoices = read(mergedRoutesView)
    .filter((route) => route.enabled !== false)
    .map((route) => ({ value: route.name, label: route.name, kind: 'route' as const }))
  const targetChoices = list.flatMap((provider) =>
    (provider.models ?? []).map((model) => ({
      value: `${provider.name}/${model}`,
      label: `${provider.name}/${model}`,
      kind: 'target' as const
    }))
  )
  const choices = [...routeChoices, ...targetChoices]
  const filter = read(policyFallbackFilter)
  const needle = filter.trim().toLowerCase()
  const shown = (needle ? choices.filter((choice) => matchesFilter(choice.value, filter)) : choices)
    .slice()
    .sort((a, b) => Number(entries.includes(b.value)) - Number(entries.includes(a.value)))
  const selected = entries.filter((entry) => choices.some((choice) => choice.value === entry)).length
  const allShownChecked = shown.length > 0 && shown.every((choice) => entries.includes(choice.value))
  const toggle = (value: string, checked: boolean) => {
    if (checked) {
      if (entries.includes(value)) return
      onChange([...entries, value])
      return
    }
    onChange(entries.filter((entry) => entry !== value))
  }
  const bulkLabel = needle
    ? allShownChecked
      ? 'Deselect shown'
      : 'Select shown'
    : allShownChecked
      ? 'Deselect all'
      : 'Select all'
  const apply = (checked: boolean) => {
    if (checked) {
      const next = [...entries]
      for (const choice of shown) if (!next.includes(choice.value)) next.push(choice.value)
      onChange(next)
      return
    }
    const remove = new Set(shown.map((choice) => choice.value))
    onChange(entries.filter((entry) => !remove.has(entry)))
  }
  return (
    <Stack gap="sm">
      <Input
        label="Filter fallback targets"
        labelHidden
        type="search"
        placeholder="Filter by route or provider/model"
        value={filter}
        onChange={(value) => set(policyFallbackFilter, value)}
      />
      <Row gap="xs" wrap align="center">
        <Button size="xs" variant="outline" disabled={!shown.length} onPress={() => apply(!allShownChecked)}>
          {bulkLabel}
        </Button>
      </Row>
      <Text muted size="xs">
        {choices.length
          ? `${selected} selected${needle ? ` · showing ${shown.length}` : ''}`
          : 'Add providers and routes first, or use Edit as text.'}
      </Text>
      {entries.length ? (
        <Text size="xs">
          Order: {entries.join(' → ')}
        </Text>
      ) : null}
      {shown.length ? (
        <Box maxHeight={240} scroll="y">
          <Stack gap="xs">
            {shown.map((choice) => (
              <Checkbox
                key={choice.value}
                label={choice.kind === 'route' ? `${choice.label} (route)` : choice.label}
                checked={entries.includes(choice.value)}
                onChange={(checked) => toggle(choice.value, checked)}
              />
            ))}
          </Stack>
        </Box>
      ) : (
        <Text muted size="xs">
          {needle ? 'No targets match the filter.' : 'No routes or provider models yet.'}
        </Text>
      )}
    </Stack>
  )
}

function RouteTargetPicker({
  rows,
  fetched,
  onChange
}: {
  rows: ChainRow[]
  fetched: ModelTarget[]
  onChange: (rows: ChainRow[]) => void
}) {
  const list = read(providers)
  const filter = read(routeTargetFilter)
  const choices = routeTargetChoices(rows, list, fetched)
  const needle = filter.trim().toLowerCase()
  const shown = (
    needle
      ? choices.filter((choice) => matchesFilter(`${choice.target.provider}/${choice.target.model}`, filter))
      : choices
  )
    .slice()
    .sort((a, b) => Number(b.checked) - Number(a.checked))
  const selected = choices.filter((choice) => choice.checked).length
  const newCount = choices.filter((choice) => choice.fetched).length
  const allShownChecked = shown.length > 0 && shown.every((choice) => choice.checked)
  const toRow = (target: ModelTarget) =>
    target.provider ? newChainRow(target.provider, target.model) : newChainRow(ANY_PROVIDER, target.model)
  const apply = (checked: boolean) => {
    if (checked) {
      const keys = new Set(rows.map((row) => targetIdentity(chainRowTarget(row))))
      const next = [...rows]
      for (const choice of shown) {
        const key = targetIdentity(choice.target)
        if (keys.has(key)) continue
        keys.add(key)
        next.push(toRow(choice.target))
      }
      onChange(next)
      return
    }
    const remove = new Set(shown.map((choice) => targetIdentity(choice.target)))
    onChange(rows.filter((row) => !remove.has(targetIdentity(chainRowTarget(row)))))
  }
  const toggle = (choice: TargetChoice, checked: boolean) => {
    if (checked) {
      if (rows.some((row) => targetIdentity(chainRowTarget(row)) === targetIdentity(choice.target))) return
      onChange([...rows, toRow(choice.target)])
      return
    }
    onChange(rows.filter((row) => targetIdentity(chainRowTarget(row)) !== targetIdentity(choice.target)))
  }
  const moveRow = (index: number, delta: number) => {
    const next = [...rows]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const current = next[index]
    next[index] = next[target]
    next[target] = current
    onChange(next)
  }
  const ordered = !read(routeFastest)
  const bulkLabel = needle
    ? allShownChecked
      ? 'Deselect shown'
      : 'Select shown'
    : allShownChecked
      ? 'Deselect all'
      : 'Select all'
  return (
    <Stack gap="sm">
      <Row gap="xs" align="center" wrap>
        <Box grow>
          <Input
            label="Filter targets"
            labelHidden
            type="search"
            placeholder="Filter by provider or model"
            value={filter}
            onChange={(value) => set(routeTargetFilter, value)}
          />
        </Box>
        <Button size="xs" variant="ghost" disabled={!shown.length} onPress={() => apply(!allShownChecked)}>
          {bulkLabel}
        </Button>
      </Row>
      <Row justify="between" align="center" wrap gap="sm">
        <Text muted size="xs">
          {choices.length
            ? selected === 0
              ? ordered
                ? 'Tick targets to add them, then set their order below.'
                : 'Tick any number of targets. Their order is decided at request time.'
              : `${selected} of ${choices.length} selected${
                  newCount ? ` · fetched ${newCount} new model${newCount === 1 ? '' : 's'}` : ''
                }${needle ? ` · showing ${shown.length}` : ''}`
            : 'No provider models yet. Add models under Providers first.'}
        </Text>
      </Row>
      {shown.length ? (
        <Box maxHeight={240} scroll="y">
          <Stack gap="xs">
            {shown.map((choice) => (
              <Row key={targetIdentity(choice.target)} gap="sm" align="center">
                <Box grow>
                  <Checkbox
                    label={
                      choice.target.provider ? `${choice.target.provider}/${choice.target.model}` : choice.target.model
                    }
                    checked={choice.checked}
                    onChange={(checked) => toggle(choice, checked)}
                  />
                </Box>
                {choice.fetched ? <Badge tone="accent">new</Badge> : null}
              </Row>
            ))}
          </Stack>
        </Box>
      ) : (
        <Text muted size="xs">
          {needle ? 'No targets match the filter.' : 'No provider models yet.'}
        </Text>
      )}
      {choices.length ? (
        <Box>
          <Stack gap="xs">
            <Row justify="between" align="center" gap="sm" wrap>
              <Text size="xs" weight="semibold">
                Resolved order
              </Text>
              <Box width={240}>
                <Select
                  label="Try sequence"
                  labelHidden
                  value={ordered ? 'ordered' : 'fastest'}
                  options={[
                    { value: 'fastest', label: 'Fastest available first' },
                    { value: 'ordered', label: 'In the order selected' }
                  ]}
                  onChange={(value) => set(routeFastest, value === 'fastest')}
                />
              </Box>
            </Row>
            {ordered ? (
              <>
                <Text muted size="xs">
                  Targets are tried from top to bottom. Use the arrows to reorder.
                </Text>
                {rows.map((row, index) => {
                  const label = row.provider === ANY_PROVIDER ? row.model : `${row.provider}/${row.model || '…'}`
                  return (
                    <Row key={row.key} gap="xs" align="center">
                      <Box shrink={false}>
                        <Text muted size="xs">{`${index + 1}.`}</Text>
                      </Box>
                      <Box grow minWidth={0}>
                        <Text size="xs" truncate>
                          {label}
                        </Text>
                      </Box>
                      <Box shrink={false}>
                        <Button
                          size="xs"
                          variant="ghost"
                          tooltip="Move up"
                          disabled={index === 0}
                          onPress={() => moveRow(index, -1)}
                        >
                          ↑
                        </Button>
                      </Box>
                      <Box shrink={false}>
                        <Button
                          size="xs"
                          variant="ghost"
                          tooltip="Move down"
                          disabled={index === rows.length - 1}
                          onPress={() => moveRow(index, 1)}
                        >
                          ↓
                        </Button>
                      </Box>
                    </Row>
                  )
                })}
              </>
            ) : (
              <Text muted size="xs">
                Fastest first ranks targets at request time. Switch to ordered to set a fixed sequence.
              </Text>
            )}
          </Stack>
        </Box>
      ) : null}
    </Stack>
  )
}

function RoutesPane() {
  const routes = read(mergedRoutesView)
  const ups = read(providers)
  const routePreview = previewChain('', read(routeTargets), ups, read(aliases), disabledProviderNames())
  return (
    <Stack gap="md">
      {read(config)?.migration?.length ? (
        <Card title="Migrated failover chains">
          <Stack gap="sm">
            <Stack gap="xs">
              {(read(config)?.migration ?? []).map((entry, index) => (
                <Row key={`${entry.kind}-${entry.to}-${index}`} gap="xs" align="center" wrap>
                  <Badge tone={entry.kind === 'global-chain' ? 'warning' : 'neutral'}>
                    {entry.kind === 'global-chain' ? 'global' : 'policy'}
                  </Badge>
                  <Text size="xs">
                    {entry.from} → {entry.to}
                    {entry.targets?.length
                      ? ` (${entry.targets.map((target) => (target.provider ? `${target.provider}/${target.model}` : target.model)).join(', ')})`
                      : ''}
                  </Text>
                </Row>
              ))}
            </Stack>
            <Button size="xs" variant="outline" onPress={() => void dismissMigrationReport()}>
              Dismiss
            </Button>
          </Stack>
        </Card>
      ) : null}

      <Row justify="between" align="center" gap="sm" wrap>
        <Box grow>
          <SectionHeading title="Routes" />
        </Box>
        <Button
          variant="solid"
          tone="accent"
          icon="add"
          onPress={() => {
            resetRouteForm()
            set(routeOpen, true)
          }}
        >
          New route
        </Button>
      </Row>

      {read(routeOpen) || read(routeEditName) ? (
        <AddSection
          label={read(routeEditName) ? 'Edit route' : 'Add a route'}
          open={read(routeOpen)}
          showToggle={false}
          onOpenChange={(open) => {
            if (open) {
              set(routeOpen, true)
            } else {
              resetRouteForm()
            }
          }}
        >
        <Stack gap="sm">
          <Stack gap="xs">
            <Row gap="sm" align="center" wrap>
              <Text size="sm" weight="semibold">
                Model alias
              </Text>
              <Text muted size="xs">
                model name used by agents.
              </Text>
            </Row>
            <Input
              label="Model alias"
              labelHidden
              placeholder="fast"
              value={read(routeName)}
              onChange={(value) => set(routeName, value)}
            />
          </Stack>

          <Row justify="between" align="center" wrap gap="sm">
            <Text size="sm" weight="semibold">
              Targets
            </Text>
            <Button
              size="xs"
              variant="ghost"
              icon="search"
              disabled={read(globalModelsFetching)}
              onPress={() => void fetchRouteModels()}
            >
              {read(globalModelsFetching) ? 'Fetching...' : 'Fetch all models from all providers'}
            </Button>
          </Row>
          <RouteTargetPicker
            rows={read(routeTargets)}
            fetched={read(routeFetchedModels)}
            onChange={(rows) => set(routeTargets, rows)}
          />
          {routePreview.warnings.length ? (
            <Stack gap="xs">
              {routePreview.warnings.map((warning, index) => (
                <Text key={`${warning.entry}-${index}`} size="xs" tone="warning">
                  {warning.message}
                </Text>
              ))}
            </Stack>
          ) : null}

          <Separator />
          <Input
            label="Retries per target"
            placeholder="2"
            value={read(routeRetries)}
            onChange={(value) => set(routeRetries, value)}
          />
          <Text muted size="xs">
            Number of attempts on the same target before moving to the next.
          </Text>

          <Separator />
          <Select
            label="VPN / proxy"
            value={read(routeVpn) || 'direct'}
            options={[
              { value: 'direct', label: 'Direct (no VPN)' },
              ...vpnServers()
                .filter((server) => server.enabled !== false)
                .map((server) => ({ value: server.id, label: server.name }))
            ]}
            onChange={(value) => set(routeVpn, value === 'direct' ? '' : value)}
          />
          <Text muted size="xs">
            All upstream calls for this route — including streams — go through the selected server. Other routes stay
            direct. Add servers under Settings.
          </Text>

          {routeTargetWarnings(read(routeTargets)).length ? (
            <Text size="xs" tone="warning">
              {routeTargetWarnings(read(routeTargets)).join(' ')}
            </Text>
          ) : null}

          <Separator />
          <Row justify="end" gap="xs" wrap align="center">
            <Button variant="ghost" onPress={() => resetRouteForm()}>
              Cancel
            </Button>
            <Button variant="solid" tone="accent" onPress={() => void saveRoute()}>
              {read(routeEditName) ? 'Save route' : 'Add route'}
            </Button>
          </Row>
        </Stack>
      </AddSection>
      ) : null}

      {routes.length ? (
        <Stack gap="xs">
          {routes.map((route) => (
            <Stack key={route.name} gap="sm">
              <Box direction="row" align="center" gap="sm" background="muted" radius="md" padding="sm">
                <Box grow minWidth={0}>
                  <Stack gap="xs">
                    <Row gap="xs" align="center" wrap>
                      <Text size="sm" weight="medium" truncate>
                        {route.name}
                      </Text>
                      <Badge tone={route.strategy === 'ordered' ? 'neutral' : 'success'}>
                        {route.strategy === 'ordered' ? 'in order' : 'fastest'}
                      </Badge>
                      {route.vpn ? (
                        <Badge tone="accent">
                          {`VPN: ${vpnServers().find((server) => server.id === route.vpn)?.name ?? route.vpn}`}
                        </Badge>
                      ) : null}
                      {read(routeRequests)[route.name] ? (
                        <Badge tone="neutral">{`${read(routeRequests)[route.name]} requests`}</Badge>
                      ) : null}
                      {read(routeFailovers)[route.name] ? (
                        <Badge tone="warning">{`${read(routeFailovers)[route.name]} failovers`}</Badge>
                      ) : null}
                      {route.enabled === false ? <Badge tone="neutral">disabled</Badge> : null}
                    </Row>
                    <Text muted size="xs" truncate>
                      {routeTargetSummary(route)}
                    </Text>
                  </Stack>
                </Box>
                <Box shrink={false}>
                  <Row gap="xs" align="center">
                    <IconButton
                      size="xs"
                      icon="edit"
                      label={`Edit route ${route.name}`}
                      tooltip="Edit route"
                      onPress={() => startEditRoute(route)}
                    />
                    <IconButton
                      size="xs"
                      icon="delete"
                      label={`Delete route ${route.name}`}
                      onPress={() => set(confirmTarget, `route:${route.name}`)}
                    />
                  </Row>
                </Box>
              </Box>
              {read(confirmTarget) === `route:${route.name}` ? (
                <ConfirmDelete
                  confirmLabel="Delete route"
                  message={`Delete route ${route.name}? Agents sending this model name will no longer route.`}
                  onConfirm={() => {
                    set(confirmTarget, '')
                    void removeRoute(route.name)
                  }}
                  onCancel={() => set(confirmTarget, '')}
                />
              ) : null}
            </Stack>
          ))}
        </Stack>
      ) : null}
    </Stack>
  )
}

function healthTone(state?: ProviderHealthView['state']): Tone {
  if (state === 'healthy') return 'success'
  if (state === 'open') return 'danger'
  if (state === 'degraded' || state === 'stale') return 'warning'
  return 'neutral'
}

function healthLabel(state?: ProviderHealthView['state']) {
  if (state === 'healthy') return 'healthy'
  if (state === 'open') return 'circuit open'
  if (state === 'degraded') return 'degraded'
  if (state === 'stale') return 'stale'
  return 'no data'
}

function Routing() {
  const routeCount = read(mergedRoutesView).length
  return (
    <Stack gap="md">
      <InfoBanner
        title="How routing works"
        open={read(routingInfoOpen) ?? routeCount === 0}
        onOpenChange={(open) => set(routingInfoOpen, open)}
      >
        <Stack gap="sm">
          <Text size="sm">
            A route is the model name your agents send — like <Code>smart</Code> or <Code>fast</Code> — backed by one or
            more <Code>provider/model</Code> targets. Routes are the only way to fail over across providers: if a
            target fails or is rate-limited, the gateway moves to the next one.
          </Text>
          <Text size="sm">
            Try sequence picks fastest healthy first, by measured latency and circuit state, or the order you selected.
            A plain model name that isn't a route resolves to one provider/model and retries only that target. To add
            fallback after it, attach a <Code>Global Policy</Code> under Settings.
          </Text>
        </Stack>
      </InfoBanner>

      <RoutesPane />
    </Stack>
  )
}

function Settings() {
  const ups = read(providers)
  return (
    <Stack gap="md">
      <InfoBanner
        title="How settings work"
        open={read(settingsInfoOpen) ?? ups.length === 0}
        onOpenChange={(open) => set(settingsInfoOpen, open)}
      >
        <Stack gap="sm">
          <Text size="sm">
            Everything here is global: it applies to every provider and route. Global Policies are matched in order and
            can rewrite a request or append a fallback chain. The other cards control request optimization, key
            scheduling and circuit breaking, client API keys for tools outside Orca, and config import/export.
          </Text>
          <Text size="sm">
            Per-provider endpoints, models and keys live under <Code>Providers</Code>; the model names your agents send
            live under <Code>Routing</Code>.
          </Text>
        </Stack>
      </InfoBanner>

      <PoliciesCard />
      <VpnServersCard />
      <RequestOptimization />
      <SchedulerSettings />
      <Card
        title="Client access"
        description="Bearer keys for tools outside Orca — scripts, other editors, or shared machines."
      >
        <Stack gap="sm">
          <Text muted size="xs">
            Orca-launched agents use the internal launch token and need none of these.
          </Text>
          <ClientAccess />
        </Stack>
      </Card>
      <Card
        title="Configuration"
        description="Import a Claude Code Router or OmniRoute config, export this one, or detect local router data."
      >
        <Import />
      </Card>
    </Stack>
  )
}

function RequestOptimization() {
  const cfg = read(config)
  const compression = cfg?.compression ?? {}
  const relay = cfg?.contextRelay ?? {}
  const cache = cfg?.responseCache ?? {}
  const providerOptions = read(providers).map((provider) => ({ value: provider.name, label: provider.name }))
  const saveCompression = (patch: NonNullable<RouterConfig['compression']>) => {
    void saveConfig((next) => {
      next.compression = { ...(next.compression ?? {}), ...patch }
    })
  }
  const saveRelay = (patch: NonNullable<RouterConfig['contextRelay']>) => {
    void saveConfig((next) => {
      next.contextRelay = { ...(next.contextRelay ?? {}), ...patch }
    })
  }
  const saveCache = (patch: NonNullable<RouterConfig['responseCache']>) => {
    void saveConfig((next) => {
      next.responseCache = { ...(next.responseCache ?? {}), ...patch }
    })
  }
  const numberFrom = (value: string, fallback: number | undefined) => {
    if (!value.trim()) return fallback ?? 0
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : (fallback ?? 0)
  }
  return (
    <Card
      title="Request optimization"
      description="Opt-in prompt compression, failover context relay, and a response cache. When off, the gateway forwards your payload unchanged."
    >
      <Stack gap="sm">
        <Heading level={3}>Prompt compression</Heading>
        <Switch
          label="Compress prompts"
          checked={compression.enabled === true}
          onChange={(checked) => saveCompression({ enabled: checked })}
        />
        <Text muted size="xs">
          Trims whitespace, ANSI codes and old tool output before forwarding. Code fences, inline code, URLs, whole JSON
          payloads and recent turns are left intact. Send <Code>x-router-compression: off</Code> on a request to skip it.
        </Text>

        {compression.enabled ? (
          <>
            <Select
              label="Compression mode"
              value={compression.mode ?? 'lite'}
              options={[
                { value: 'lite', label: 'Lite — whitespace and ANSI only' },
                { value: 'standard', label: 'Standard — also caps old plain-text tool output' },
                { value: 'aggressive', label: 'Aggressive — also shortens old turns' }
              ]}
              onChange={(value) => saveCompression({ mode: value as NonNullable<RouterConfig['compression']>['mode'] })}
            />
            <Input
              label="Minimum request size (characters)"
              placeholder="2000"
              value={String(compression.minChars ?? 2000)}
              onChange={(value) => saveCompression({ minChars: numberFrom(value, compression.minChars) })}
            />
            <Input
              label="Recent turns to leave untouched"
              placeholder="4"
              value={String(compression.keepRecentMessages ?? 4)}
              onChange={(value) => saveCompression({ keepRecentMessages: numberFrom(value, compression.keepRecentMessages) })}
            />
            <Switch
              label="Compress old tool output"
              checked={compression.toolResults !== false}
              onChange={(checked) => saveCompression({ toolResults: checked })}
            />
          </>
        ) : null}

        <Separator />
        <Heading level={3}>Context relay</Heading>
        <Switch
          label="Context relay on failover"
          checked={relay.enabled === true}
          onChange={(checked) => saveRelay({ enabled: checked })}
        />
        <Text muted size="xs">
          When a request moves to another target, replace older turns with deterministic one-line handoff digests. No
          extra model call; the next provider sees the same recent turns and a compact history.
        </Text>

        {relay.enabled ? (
          <>
            <Select
              label="When to relay"
              value={relay.trigger ?? 'failover'}
              options={[
                { value: 'failover', label: 'Only after moving to another target' },
                { value: 'always', label: 'Every request' },
                { value: 'both', label: 'Failover or when the prompt is large' }
              ]}
              onChange={(value) => saveRelay({ trigger: value as NonNullable<RouterConfig['contextRelay']>['trigger'] })}
            />
            <Input
              label="Large-prompt threshold (characters)"
              placeholder="24000"
              value={String(relay.maxChars ?? 24_000)}
              onChange={(value) => saveRelay({ maxChars: numberFrom(value, relay.maxChars) })}
            />
            <Input
              label="Digest length per turn"
              placeholder="200"
              value={String(relay.digestChars ?? 200)}
              onChange={(value) => saveRelay({ digestChars: numberFrom(value, relay.digestChars) })}
            />
          </>
        ) : null}

        <Separator />
        <Heading level={3}>Response cache</Heading>
        <Switch
          label="Response cache"
          checked={cache.enabled === true}
          onChange={(checked) => saveCache({ enabled: checked })}
        />
        <Text muted size="xs">
          Replay an identical successful response without calling upstream. The cache is scoped by client protocol,
          stream mode and resolved provider/model. Tools, images and requests above the temperature limit are skipped.
          Send <Code>x-router-cache: off</Code> to bypass it.
        </Text>

        {cache.enabled ? (
          <>
            <Select
              label="Match mode"
              value={cache.mode ?? 'exact'}
              options={[
                { value: 'exact', label: 'Exact — canonical request hash' },
                { value: 'semantic', label: 'Semantic — also use embeddings' }
              ]}
              onChange={(value) => saveCache({ mode: value as NonNullable<RouterConfig['responseCache']>['mode'] })}
            />
            <Input
              label="Cache lifetime (seconds)"
              placeholder="300"
              value={String(Math.round((cache.ttlMs ?? 300_000) / 1000))}
              onChange={(value) => saveCache({ ttlMs: Math.max(10, numberFrom(value, (cache.ttlMs ?? 300_000) / 1000)) * 1000 })}
            />
            {cache.mode === 'semantic' ? (
              <>
                <Select
                  label="Embedding provider"
                  value={cache.embeddingProvider ?? ''}
                  placeholder="Choose an OpenAI-compatible provider"
                  options={providerOptions}
                  onChange={(value) => saveCache({ embeddingProvider: value })}
                />
                <Input
                  label="Embedding model"
                  placeholder="text-embedding-3-small"
                  value={cache.embeddingModel ?? ''}
                  onChange={(value) => saveCache({ embeddingModel: value })}
                />
                <Input
                  label="Similarity threshold (0–1)"
                  placeholder="0.95"
                  value={String(cache.threshold ?? 0.95)}
                  onChange={(value) => saveCache({ threshold: numberFrom(value, cache.threshold) })}
                />
                <Text muted size="xs">
                  Semantic mode calls the embedding model on a cache miss, then compares against stored prompts for the
                  same target. Higher thresholds mean fewer, safer hits.
                </Text>
              </>
            ) : null}
            <Switch
              label="Skip requests with tools"
              checked={cache.skipTools !== false}
              onChange={(checked) => saveCache({ skipTools: checked })}
            />
            <Input
              label="Only cache up to temperature"
              placeholder="0"
              value={String(cache.maxTemperature ?? 0)}
              onChange={(value) => saveCache({ maxTemperature: numberFrom(value, cache.maxTemperature) })}
            />
            <Text muted size="xs">
              Requests above this temperature are treated as non-deterministic and are not cached. Default 0.
            </Text>
          </>
        ) : null}
      </Stack>
    </Card>
  )
}

function AgentRow({ route }: { route: AgentRoute }) {
  return (
    <Row justify="between" align="center" gap="sm">
      <Box grow>
        <Text size="sm" weight="medium" truncate>
          {route.name}
        </Text>
      </Box>
      {/* Orca's Switch requires a label; a zero-width space hides it. */}
      <Switch label={'\u200B'} checked={route.enabled} onChange={(checked) => void toggleAgent(route, checked)} />
    </Row>
  )
}

function Profiles() {
  const agents = read(agentList)
  const installed = agents.filter((agent) => agent.installed)
  const others = agents.filter((agent) => !agent.installed)
  const enabledCount = agents.filter((agent) => agent.enabled).length
  return (
    <Stack gap="md">
      <InfoBanner
        title="What agents it works with"
        open={read(profilesInfoOpen) ?? agents.length === 0}
        onOpenChange={(open) => set(profilesInfoOpen, open)}
      >
        <Text size="sm">
          This is the list of coding agents Orca can launch. While the gateway is running, each enabled agent is pointed
          at it at launch: env-based agents get the gateway address and auth, and OpenCode and Codex also get a
          generated list of your providers and models. Turn an agent off to leave it on its own settings.
        </Text>
      </InfoBanner>

      {agents.length ? (
        <Stack gap="md">
          {installed.length ? (
            <Stack gap="xs">
              {installed.map((route) => (
                <Box key={route.agent} background="muted" radius="md" padding="sm">
                  <AgentRow route={route} />
                </Box>
              ))}
            </Stack>
          ) : (
            <Callout tone="neutral" title="No agents detected">
              <Text size="sm">
                Orca did not find any coding agents on PATH. Install one, restart Orca, and it appears here.
              </Text>
            </Callout>
          )}

          {others.length ? (
            <Collapsible
              title="Other Orca agents"
              description={`${others.length} not detected on this machine`}
              open={read(agentsOtherOpen)}
              onChange={(open) => set(agentsOtherOpen, open)}
            >
              <Stack gap="xs">
                {others.map((route) => (
                  <Box key={route.agent} background="muted" radius="md" padding="sm">
                    <AgentRow route={route} />
                  </Box>
                ))}
              </Stack>
            </Collapsible>
          ) : null}
        </Stack>
      ) : null}

      {agents.length ? (
        <Text muted size="xs">
          {enabledCount} of {agents.length} agents routed through the gateway.
        </Text>
      ) : null}
    </Stack>
  )
}

function ClientAccess() {
  return (
    <Stack gap="sm">
      <AddSection
        label="Create client key"
        open={read(clientKeyOpen)}
        onOpenChange={(open) => set(clientKeyOpen, open)}
      >
        <Stack gap="sm">
          <Input label="Key name" placeholder="Claude Code - laptop" value={read(clientKeyName)} onChange={(value) => set(clientKeyName, value)} />
          <Input
            label="Expires at"
            placeholder="2026-12-31T00:00:00Z"
            value={read(clientKeyExpires)}
            onChange={(value) => set(clientKeyExpires, value)}
          />
          <Input
            label="Limits JSON"
            placeholder='{"rpm":60,"tpm":200000,"ipd":500}'
            value={read(clientKeyLimits)}
            onChange={(value) => set(clientKeyLimits, value)}
          />
          <Text muted size="xs">
            Optional. Requests rpm/rph/rpd, tokens tpm/tph/tpd, images ipm/iph/ipd, or quotas maxRequests / maxTokens.
          </Text>
          <Button variant="solid" tone="accent" onPress={() => void createClientKey()}>
            Create key
          </Button>
        </Stack>
      </AddSection>

      {read(clientKeys).length === 0 ? (
        <Text muted size="sm">
          No client keys yet. These are bearer keys for tools outside Orca — scripts, other editors, shared machines.
          Orca-launched agents use the internal launch token and need none.
        </Text>
      ) : (
        <Stack gap="xs">
          {read(clientKeys).map((key) => (
            <Box key={key.id} background="muted" radius="md" padding="sm">
              <Stack gap="xs">
                <Row justify="between" align="center" gap="sm">
                  <Box grow>
                    <Row gap="xs" align="center" wrap>
                      <Text size="sm" weight="medium" truncate>
                        {key.name}
                      </Text>
                      <Badge tone={key.enabled ? 'success' : 'neutral'}>{key.enabled ? 'active' : 'disabled'}</Badge>
                    </Row>
                  </Box>
                  <IconButton size="xs" icon="delete" label={`Revoke key ${key.id}`} onPress={() => set(confirmTarget, `clientKey:${key.id}`)} />
                </Row>
                {read(confirmTarget) === `clientKey:${key.id}` ? (
                  <ConfirmDelete
                    confirmLabel="Revoke key"
                    message={`Revoke ${key.name}? Tools using it lose access immediately.`}
                    onConfirm={() => {
                      set(confirmTarget, '')
                      void revokeClientKey(key.id)
                    }}
                    onCancel={() => set(confirmTarget, '')}
                  />
                ) : null}
                <Text muted size="xs" truncate>
                  {key.id}
                </Text>
                <Text muted size="xs">
                  {key.expiresAt ? `Expires ${key.expiresAt}` : 'No expiry'}
                  {key.limits && Object.keys(key.limits).length ? ` · Limits ${JSON.stringify(key.limits)}` : ''}
                </Text>
              </Stack>
            </Box>
          ))}
        </Stack>
      )}

      {read(createdKey) ? (
        <Callout tone="accent" title="Copy this key now">
          <Stack gap="xs">
            <Code block>{read(createdKey)}</Code>
            <Text muted size="xs">
              Stored only as an Orca secret. Revoke it here if it leaks.
            </Text>
          </Stack>
        </Callout>
      ) : null}
    </Stack>
  )
}

function Logs() {
  const entries = read(logs)
  const shown = visibleLogs()
  const summary = logSummary(entries)
  return (
    <Stack gap="md">
      <InfoBanner
        title="How to search the request log"
        open={read(logsInfoOpen) ?? false}
        onOpenChange={(open) => set(logsInfoOpen, open)}
      >
        <Stack gap="xs">
          <Text size="sm">
            Each line is one request: the model sent, the provider/model that served it, the key used, status, latency
            and any failover. Search that text directly, or narrow it with <Code>field=value</Code> or{' '}
            <Code>field:value</Code>.
          </Text>
          <Stack gap="xs">
            <Code>provider=openai</Code>
            <Text muted size="xs">Requests sent to that provider.</Text>
          </Stack>
          <Stack gap="xs">
            <Code>route=fast status=4xx</Code>
            <Text muted size="xs">Two terms with no operator mean AND.</Text>
          </Stack>
          <Stack gap="xs">
            <Code>provider=openai OR status=429</Code>
            <Text muted size="xs">Either condition. Also AND, NOT, &amp;&amp;, || and !.</Text>
          </Stack>
          <Stack gap="xs">
            <Code>(provider=openai OR key=key-1) AND status=4xx</Code>
            <Text muted size="xs">Group with parentheses. <Code>NOT error=</Code> finds requests without an error.</Text>
          </Stack>
          <Stack gap="xs">
            <Code>latency&gt;2000 tokens&gt;10000</Code>
            <Text muted size="xs">Numeric fields take &gt;, &gt;=, &lt; and &lt;=.</Text>
          </Stack>
          <Text muted size="xs">
            Fields: provider, route, agent, model, request, target, key, status, error, code, policy, protocol, stream,
            latency, tokens, input, output, cost, bytes, attempts, cache. Quote values with spaces, e.g.{' '}
            <Code>error="all keys exhausted"</Code>.
          </Text>
        </Stack>
      </InfoBanner>

      <Stack gap="xs">
        <Row justify="between" align="center" gap="xs">
          <Row gap="sm" align="center">
            <Heading level={2}>Request log</Heading>
            {summary ? <Text muted size="xs" truncate>{summary}</Text> : null}
          </Row>
          <Row gap="xs" align="center">
            <IconButton size="xs" variant="ghost" icon="download" label="Export request log" tooltip="Export CSV" disabled={!entries.length} onPress={exportLogsCsv} />
            <IconButton size="xs" variant="ghost" icon="delete" label="Clear request log" tooltip="Clear" disabled={!entries.length} onPress={() => void clearLogs()} />
          </Row>
        </Row>
        <Row gap="xs" wrap align="center">
          <Button
            size="xs"
            variant={read(logErrorsOnly) ? 'solid' : 'outline'}
            tone={read(logErrorsOnly) ? 'accent' : 'neutral'}
            onPress={() => set(logErrorsOnly, !read(logErrorsOnly))}
          >
            Errors only
          </Button>
          <Button
            size="xs"
            variant={read(logLive) ? 'solid' : 'outline'}
            tone={read(logLive) ? 'accent' : 'neutral'}
            onPress={() => toggleLogLive(!read(logLive))}
          >
            Live
          </Button>
          <Button
            size="xs"
            variant={read(config)?.persistLogs ? 'solid' : 'outline'}
            tone={read(config)?.persistLogs ? 'accent' : 'neutral'}
            onPress={() => void saveConfig((next) => { next.persistLogs = next.persistLogs !== true })}
          >
            Save logs
          </Button>
        </Row>
      </Stack>

      {entries.length ? (
        <Input
          label="Search request log"
          labelHidden
          type="search"
          placeholder="Search logs .. provider=openrouter AND status=529"
          value={read(logSearch)}
          onChange={(value) => set(logSearch, value)}
        />
      ) : null}

      {entries.length === 0 ? (
        <EmptyState
          title="No requests yet"
          description="Every request the gateway handles shows up here with its route, selected model, status, latency and tokens. Launch an agent to see traffic."
          icon="activity"
        />
      ) : shown.length === 0 ? (
        <EmptyState
          title="No matching requests"
          description="Fields: provider, route, agent, model, request, target, key, status, error, code, policy, protocol, stream, latency, tokens, input, output, cost, bytes, attempts, cache. Combine with AND / OR / NOT, parentheses and numeric comparisons."
          icon="search"
        >
          <Button variant="outline" onPress={() => {
            set(logSearch, '')
            set(logErrorsOnly, false)
          }}>
            Reset
          </Button>
        </EmptyState>
      ) : (
        <Stack gap="xs">
          {shown.map((entry, index) => (
            <LogRow key={`${entry.at}-${index}`} entry={entry} />
          ))}
        </Stack>
      )}
    </Stack>
  )
}

function Import() {
  const local = read(detectedLocal)
  const hasBoth = Boolean(local?.ccr && local?.omniroute)
  const hasAny = Boolean(local?.ccr || local?.omniroute)
  const isDetecting = read(detectingLocal)

  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="sm" wrap>
        <Button variant="outline" icon="download" onPress={() => void exportConfig()}>
          Export config
        </Button>
        <Button variant="outline" icon="refresh" onPress={() => void checkLocalRouters()} disabled={isDetecting}>
          {isDetecting ? 'Detecting…' : 'Detect local routers'}
        </Button>
      </Row>

      <Row justify="between" align="center" wrap gap="sm">
        <Text size="sm">Merge with current config</Text>
        <Switch
          label="Merge"
          checked={read(importMerge)}
          onChange={(checked) => set(importMerge, checked)}
        />
      </Row>

      <Stack gap="sm">
        <Textarea
          label="Config JSON"
          placeholder="Paste config JSON (Claude Code Router, OmniRoute, or native format)"
          rows={6}
          value={read(importJsonText)}
          onChange={(value) => set(importJsonText, value)}
        />

        <Row gap="xs" wrap>
          <Button
            variant="solid"
            tone="accent"
            disabled={!read(importJsonText).trim()}
            onPress={() => void importJson()}
          >
            Import JSON
          </Button>
          <Button variant="ghost" disabled={!read(importJsonText)} onPress={() => set(importJsonText, '')}>
            Clear
          </Button>
        </Row>

        <Separator />

        <Row gap="xs" align="end">
          <Box grow>
            <Input
              label="Or import from file path"
              placeholder="Path to .sqlite or .json file"
              value={read(importPathText)}
              onChange={(value) => set(importPathText, value)}
            />
          </Box>
          <Button
            variant="outline"
            disabled={!read(importPathText).trim()}
            onPress={() => void importPath()}
          >
            Load file
          </Button>
        </Row>
      </Stack>

      {hasAny && (
        <Card title="Detected local routers">
          <Stack gap="sm">
            {hasBoth && (
              <Button variant="solid" tone="accent" onPress={() => void importLocal('both')}>
                Import both (CCR + OmniRoute)
              </Button>
            )}

            {local?.ccr && (
              <Row justify="between" align="center" wrap gap="xs">
                <Stack gap="xs">
                  <Text weight="medium">Claude Code Router</Text>
                  <Text size="xs" muted>
                    {local.ccr.providers ?? 0} providers · {local.ccr.keys ?? 0} keys · {local.ccr.profiles ?? 0} profiles
                  </Text>
                </Stack>
                <Button variant={hasBoth ? 'outline' : 'solid'} tone="accent" size="sm" onPress={() => void importLocal('ccr')}>
                  Import CCR
                </Button>
              </Row>
            )}

            {local?.omniroute && (
              <Row justify="between" align="center" wrap gap="xs">
                <Stack gap="xs">
                  <Text weight="medium">OmniRoute</Text>
                  <Text size="xs" muted>
                    {local.omniroute.connections ?? 0} connections · {local.omniroute.aliases ?? 0} aliases
                  </Text>
                </Stack>
                <Button variant={hasBoth ? 'outline' : 'solid'} tone="accent" size="sm" onPress={() => void importLocal('omni')}>
                  Import OmniRoute
                </Button>
              </Row>
            )}
          </Stack>
        </Card>
      )}
    </Stack>
  )
}

// ---------------------------------------------------------------------------
// Web chat mode inside the Add provider dialog — free web subscriptions.
// ---------------------------------------------------------------------------
const WEBCHAT_SERVICES = [
  { transport: 'deepseek-web' as const, name: 'DeepSeek Web', detail: 'chat.deepseek.com · V4 Flash / Expert · thinking & search', website: 'https://chat.deepseek.com/', logo: 'assets/deepseek-web.png' },
  { transport: 'qwen-web' as const, name: 'Qwen Web', detail: 'chat.qwen.ai · Qwen3.7 Max / Plus · thinking', website: 'https://chat.qwen.ai/', logo: 'assets/qwen-web.png' }
]
type WebChatStatus = { configured: boolean; secretKey: string; headersCaptured: boolean; session: { mode: string; port: number; startedAt: number } | null }

async function refreshWebchat() {
  const next: Record<string, WebChatStatus> = {}
  for (const service of WEBCHAT_SERVICES) {
    try {
      next[service.transport] = await plugin.request('router.webchat.auth.status', { provider: service.transport })
    } catch {
      // A missing/stale worker simply shows the service as not configured.
    }
  }
  set(webchatStatus, next)
}

async function withWebchatBusy(transport: string, key: string, fn: () => Promise<void>) {
  const token = `${transport}:${key}`
  if (read(webchatBusy)) return
  set(webchatBusy, token)
  set(error, '')
  set(message, '')
  try {
    await fn()
    await refresh()
    await refreshWebchat()
  } catch (cause) {
    set(error, (cause as Error).message)
  } finally {
    set(webchatBusy, '')
  }
}

// Timers for the automatic "add provider → login → capture" flow. The user only
// has to sign in in the opened Chrome window; the panel polls until the browser
// session is available and the credentials are saved.
const webchatPollTimers = new Map<string, ReturnType<typeof setTimeout>>()
function stopWebchatPoll(transport: string) {
  const timer = webchatPollTimers.get(transport)
  if (timer) clearTimeout(timer)
  webchatPollTimers.delete(transport)
}

async function webchatAutoCapture(transport: 'deepseek-web' | 'qwen-web') {
  stopWebchatPoll(transport)
  const startedAt = Date.now()
  const tick = async () => {
    if (!read(webchatLogins)[transport]) return // cancelled / already captured
    if (Date.now() - startedAt > 180_000) {
      set(message, 'Login timed out. Sign in in the browser and press Capture credentials, or use Paste auth JSON.')
      stopWebchatPoll(transport)
      return
    }
    try {
      const result = await plugin.request('router.webchat.auth.capture', {
        provider: transport,
        silent: true,
        attempts: 1
      })
      if (result.ok) {
        // Keep the browser window open: the person may still be typing or
        // logging in. Mark the session captured so the UI offers "Done", and
        // keep polling so credentials/headers refresh as they finish.
        update(webchatLogins, (current) => current[transport]
          ? { ...current, [transport]: { ...current[transport], captured: true } }
          : current)
        set(message, `Credentials captured (${result.summary?.token ?? 'OK'}). Finish in the browser, then press Done.`)
        await refreshWebchat()
        // Do not return here — keep the poll alive to refresh the credentials.
      }
    } catch {
      // Transient failure (e.g. the browser is still starting); keep polling.
    }
    if (read(webchatLogins)[transport]) {
      webchatPollTimers.set(transport, setTimeout(() => void tick(), 2500))
    }
  }
  webchatPollTimers.set(transport, setTimeout(() => void tick(), 2500))
}

async function webchatSetup(transport: 'deepseek-web' | 'qwen-web') {
  await withWebchatBusy(transport, 'setup', async () => {
    // Do NOT add the provider yet: it is created by the worker only after the
    // credentials are captured AND verified with a real upstream request.
    try {
      const login = await plugin.request('router.webchat.auth.start', { provider: transport })
      update(webchatLogins, (current) => ({
        ...current,
        [transport]: { mode: login.mode, port: login.port, secretKey: login.secretKey }
      }))
      set(message, 'Chrome is ready — sign in and send a short message. The provider is added once the credentials are verified.')
      void webchatAutoCapture(transport)
    } catch (cause) {
      // No browser means no login session to attach to, so show the paste form
      // right away instead of pointing at a control that was never rendered.
      set(webchatPasteFor, transport)
      set(message, `The browser could not start: ${(cause as Error).message}. Paste your auth JSON below.`)
    }
  })
}

async function webchatStart(transport: 'deepseek-web' | 'qwen-web') {
  await withWebchatBusy(transport, 'login', async () => {
    const result = await plugin.request('router.webchat.auth.start', { provider: transport })
    update(webchatLogins, (current) => ({
      ...current,
      [transport]: { mode: result.mode, port: result.port, secretKey: result.secretKey }
    }))
    set(message, 'Chrome is ready — sign in and send a short message; credentials are captured automatically.')
    void webchatAutoCapture(transport)
  })
}

async function webchatCapture(transport: 'deepseek-web' | 'qwen-web') {
  await withWebchatBusy(transport, 'capture', async () => {
    stopWebchatPoll(transport)
    const result = await plugin.request('router.webchat.auth.capture', { provider: transport })
    update(webchatLogins, (current) => {
      const next = { ...current }
      delete next[transport]
      return next
    })
    set(message, `Credentials saved (${result.summary.token}, ${result.summary.cookie}).`)
  })
}

async function webchatCancel(transport: 'deepseek-web' | 'qwen-web') {
  await withWebchatBusy(transport, 'cancel', async () => {
    stopWebchatPoll(transport)
    await plugin.request('router.webchat.auth.cancel', { provider: transport })
    update(webchatLogins, (current) => {
      const next = { ...current }
      delete next[transport]
      return next
    })
    set(message, 'Web login cancelled.')
  })
}

// "Done" after an automatic capture: close the browser and keep the saved creds.
async function webchatDone(transport: 'deepseek-web' | 'qwen-web') {
  await withWebchatBusy(transport, 'done', async () => {
    stopWebchatPoll(transport)
    await plugin.request('router.webchat.auth.cancel', { provider: transport })
    update(webchatLogins, (current) => {
      const next = { ...current }
      delete next[transport]
      return next
    })
    set(message, 'Done — browser closed. Credentials are saved.')
    await refreshWebchat()
  })
}

async function webchatPaste(transport: 'deepseek-web' | 'qwen-web') {
  const json = read(webchatPasteText).trim()
  if (!json) { set(error, 'Paste the credentials JSON first.'); return }
  await withWebchatBusy(transport, 'paste', async () => {
    stopWebchatPoll(transport)
    const result = await plugin.request('router.webchat.auth.paste', { provider: transport, json })
    set(webchatPasteFor, '')
    set(webchatPasteText, '')
    set(message, `Credentials saved (${result.summary.token}).`)
  })
}

function WebChatService({ service }: { service: typeof WEBCHAT_SERVICES[number] }) {
  const transport = service.transport
  const provider = read(providers).find((item) => item.transport === transport)
  const status = read(webchatStatus)[transport]
  const login = read(webchatLogins)[transport]
  const busy = read(webchatBusy)
  const isBusy = (key: string) => busy === `${transport}:${key}`
  const connected = Boolean(provider && status?.configured)
  const reconnecting = read(webchatReconnectFor) === transport

  return (
    <Box background="muted" radius="md" padding="sm">
      <Stack gap="xs" align="center">
        <Text weight="semibold">{service.name}</Text>
        <Image src={service.logo} alt="" size="sm" rounded />
        {provider ? (
          <Badge tone={status?.configured ? 'success' : 'warning'}>
            {status?.configured ? 'Connected' : 'Not signed in'}
          </Badge>
        ) : null}
        {provider && status?.configured && status.headersCaptured === false ? (
          <Text size="xs" muted>Anti-bot headers were not captured — reconnect and send a test message in the browser.</Text>
        ) : null}
        {!provider && !login ? (
          <Button
            size="xs"
            variant="solid"
            tone="accent"
            disabled={Boolean(busy)}
            onPress={() => void webchatSetup(transport)}
          >
            {isBusy('setup') ? 'Opening…' : 'Add as a provider'}
          </Button>
        ) : null}

        {(provider || login || read(webchatPasteFor) === transport) ? (
          <>
            {login ? (
              <Callout tone={login.captured ? 'success' : 'accent'} title={login.captured ? 'Connected' : 'Login in progress'}>
                <Stack gap="xs">
                  <Text size="sm">
                    {login.captured
                      ? 'Credentials captured. The Chrome window stays open — finish logging in or send your test message, then press Done to close it.'
                      : `Chrome ${login.mode === 'attach' ? 'attached' : 'opened'} on port ${login.port}. Log in to ${service.website} and send one short message (for example “ok”) — credentials are captured automatically.`}
                  </Text>
                  <Row gap="xs" wrap>
                    {login.captured ? (
                      <Button size="xs" variant="solid" tone="accent" disabled={Boolean(busy)} onPress={() => void webchatDone(transport)}>
                        {isBusy('done') ? 'Closing…' : 'Done'}
                      </Button>
                    ) : (
                      <>
                        <Button size="xs" variant="solid" tone="accent" disabled={Boolean(busy)} onPress={() => void webchatCapture(transport)}>
                          {isBusy('capture') ? 'Capturing…' : 'Capture credentials'}
                        </Button>
                        <Button size="xs" variant="ghost" disabled={Boolean(busy)} onPress={() => void webchatCancel(transport)}>
                          Cancel login
                        </Button>
                      </>
                    )}
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={Boolean(busy)}
                      onPress={() => set(webchatPasteFor, read(webchatPasteFor) === transport ? '' : transport)}
                    >
                      {read(webchatPasteFor) === transport ? 'Hide paste form' : 'Paste auth JSON'}
                    </Button>
                  </Row>
                </Stack>
              </Callout>
            ) : connected && !reconnecting ? (
              <Button
                size="xs"
                variant="outline"
                disabled={Boolean(busy)}
                onPress={() => set(webchatReconnectFor, transport)}
              >
                Reconnect
              </Button>
            ) : connected && reconnecting ? (
              <Callout tone="accent" title="Reconnect account">
                <Stack gap="xs">
                  <Text size="sm">
                    Choose how to reconnect {service.name}. The current credentials stay saved until new ones are verified.
                  </Text>
                  <Row gap="xs" wrap>
                    <Button size="xs" variant="solid" tone="accent" disabled={Boolean(busy)} onPress={() => {
                      set(webchatReconnectFor, '')
                      void webchatStart(transport)
                    }}>
                      Web login
                    </Button>
                    <Button size="xs" variant="outline" disabled={Boolean(busy)} onPress={() => {
                      set(webchatReconnectFor, '')
                      set(webchatPasteFor, transport)
                    }}>
                      Paste auth JSON
                    </Button>
                    <Button size="xs" variant="ghost" onPress={() => set(webchatReconnectFor, '')}>
                      Cancel
                    </Button>
                  </Row>
                </Stack>
              </Callout>
            ) : (
              <Row gap="xs" wrap>
                <Button size="xs" variant="outline" disabled={Boolean(busy)} onPress={() => void webchatStart(transport)}>
                  {isBusy('login') ? 'Opening Chrome…' : 'Web login'}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={Boolean(busy)}
                  onPress={() => set(webchatPasteFor, read(webchatPasteFor) === transport ? '' : transport)}
                >
                  {read(webchatPasteFor) === transport ? 'Hide paste form' : 'Paste auth JSON'}
                </Button>
              </Row>
            )}

            {read(webchatPasteFor) === transport ? (
              <Stack gap="xs">
                <Textarea
                  label="Credentials JSON"
                  placeholder={'{"token":"...","cookie":"..."}'}
                  rows={4}
                  value={read(webchatPasteText)}
                  onChange={(value) => set(webchatPasteText, value)}
                />
                <Row gap="xs" wrap>
                  <Button
                    size="xs"
                    variant="solid"
                    tone="accent"
                    disabled={Boolean(busy) || !read(webchatPasteText).trim()}
                    onPress={() => void webchatPaste(transport)}
                  >
                    {isBusy('paste') ? 'Saving…' : 'Save credentials'}
                  </Button>
                  <Button size="xs" variant="ghost" onPress={() => set(webchatPasteFor, '')}>Cancel</Button>
                </Row>
              </Stack>
            ) : null}
          </>
        ) : null}
      </Stack>
    </Box>
  )
}

function WebChat() {
  const connected = WEBCHAT_SERVICES.filter((service) => read(webchatStatus)[service.transport]?.configured).length
  return (
    <Stack gap="sm">
      <Callout tone="neutral" title="Free web subscriptions, routed natively">
        <Text size="sm">
          Add a web account once and every agent can use it through the gateway like any other provider. The router
          keeps the remote chat per conversation and recovers from empty replies, context overflow and stale sessions.
          Login opens a private Chrome window in Orca; credentials go straight to Orca's secret vault.
        </Text>
      </Callout>
      <Text size="xs" muted>{connected} of {WEBCHAT_SERVICES.length} connected</Text>
      <Grid columns={2} gap="sm">
        {WEBCHAT_SERVICES.map((service) => <WebChatService key={service.transport} service={service} />)}
      </Grid>
      {/* Status and messages are shown once by StatusBanner — don't duplicate here. */}
    </Stack>
  )
}

function Section() {
  if (!read(loaded)) return <Loading />
  const active = read(tab)
  if (active === 'providers') return <Providers />
  if (active === 'routing') return <Routing />
  if (active === 'profiles') return <Profiles />
  if (active === 'usage') return <Usage />
  if (active === 'logs') return <Logs />
  if (active === 'settings') return <Settings />
  return <Overview />
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
export default function Panel() {
  return (
    <Stack gap="md">
      <StatusBanner />
      <Navigation />
      <Section />
    </Stack>
  )
}
