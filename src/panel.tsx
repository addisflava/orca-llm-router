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
  Code,
  Collapsible,
  EmptyState,
  Grid,
  Heading,
  IconButton,
  Input,
  KeyValue,
  List,
  ListItem,
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
  Text,
  Textarea,
  update,
  type Atom,
  type PanelContext,
  type Tone,
  type WithChildren
} from 'orca'
import type { AgentRoute, DetectedRouterInfo, LogEntry, ProviderPreset, ProviderView, RouterConfig, RouteRule } from './protocol'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
type KeyDraft = { name: string; value: string; priority: string; limits: string; open: boolean }

function blankKeyDraft(): KeyDraft {
  return { name: '', value: '', priority: '', limits: '', open: false }
}

const running = atom(false)
const host = atom('127.0.0.1')
const port = atom(18080)
const portDraft = atom('')
const editingPort = atom(false)
const savingPort = atom(false)
const defaultProvider = atom('')
const tab = atom('tab', 'overview', { persist: 'plugin' })
const config = atom<RouterConfig | null>(null)
const providers = atom<ProviderView[]>([])
const routes = atom<RouteRule[]>([])
const aliases = atom<Record<string, string>>({})
const clientKeys = atom<{ id: string; name: string; expiresAt?: string; limits?: Record<string, unknown>; enabled: boolean }[]>([])
const agentList = atom<AgentRoute[]>([])
const presetList = atom<ProviderPreset[]>([])
const logs = atom<LogEntry[]>([])
const loaded = atom(false)
const usage = atom<{
  requests: number
  successRate: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cost: number
  avgLatencyMs: number
  byProvider: { provider: string; count: number }[]
  byModel: { model: string; count: number }[]
} | null>(null)
const message = atom('')
const error = atom('')
const createdKey = atom('')

// Add provider forms. Preset and custom are kept apart so switching between
// them never leaves one form's values in the other's fields.
const addProviderOpen = atom(false)
const addMode = atom<'preset' | 'custom'>('preset')
const presetId = atom('')
const presetName = atom('')
const presetKeys = atom<KeyDraft[]>([blankKeyDraft()])

const customName = atom('')
const customBaseUrl = atom('')
const customOpenAI = atom(true)
const customAnthropic = atom(false)
const customResponses = atom(false)
const customModels = atom('')
const customKeys = atom<KeyDraft[]>([blankKeyDraft()])

// Naming fields stay quiet: the effective provider name is shown inline and
// only becomes an input when its edit icon is pressed. `fetchingModels`
// disables the model-pull buttons while a list is in flight.
const presetNameEditing = atom(false)
const fetchingModels = atom(false)

const ruleOpen = atom(false)
const ruleName = atom('')
const ruleSource = atom('request.body')
const ruleField = atom('model')
const ruleOperator = atom('starts-with')
const ruleValue = atom('claude-')
const rewriteKey = atom('request.body.model')
const rewriteOperation = atom('set')
const rewriteValue = atom('')
const fallbackMode = atom('model-chain')
const fallbackRetry = atom('0')
const fallbackModels = atom('')

const aliasOpen = atom(false)
const aliasName = atom('')
const aliasTarget = atom('')

const agentsOtherOpen = atom(false)

const keyProvider = atom('')
const keyFormFor = atom('')
// The add-key form is a list of rows so a provider can take several pool
// entries at once; each row carries its own optional name, priority and limits.
const keyDrafts = atom<KeyDraft[]>([])
// Which destructive action is awaiting confirmation, as a target token
// (`provider:<name>` or `key:<provider>:<secretKey>`).
const confirmTarget = atom('')
// Provider key values come from Orca's secret store only when the person asks
// to see or copy one; the panel keeps them nowhere else.
const revealedKeyName = atom('')
const revealedKeyValue = atom('')
const clientKeyName = atom('')
const clientKeyExpires = atom('')
const clientKeyLimits = atom('')
const clientKeyOpen = atom(false)
const clientKeysOpen = atom(false)

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
const routesInfoOpen = atom<boolean | null>(null)
const profilesInfoOpen = atom<boolean | null>(null)
const logsInfoOpen = atom<boolean | null>(null)

// Inline edit state. Each list card swaps its summary for an editor when it
// owns the edit slot; the shared add forms double as editors for rules/aliases.
const providerEditFor = atom('')
const providerEditDisplayName = atom('')
const providerEditBaseUrl = atom('')
const providerEditModels = atom('')

const ruleEditIndex = atom(-1)
const aliasEditName = atom('')

const SECTIONS = [
  { value: 'overview', label: 'Home' },
  { value: 'providers', label: 'Providers' },
  { value: 'routes', label: 'Rules' },
  { value: 'profiles', label: 'Agents' },
  { value: 'logs', label: 'Logs' }
]

const SOURCE_OPTIONS = [
  { value: 'request.body', label: 'Request body' },
  { value: 'request.header', label: 'Request header' },
  { value: 'request.headers', label: 'Request headers' }
]
const OPERATOR_OPTIONS = [
  { value: 'equals', label: 'equals' },
  { value: 'not-equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'starts-with', label: 'starts with' },
  { value: 'ends-with', label: 'ends with' },
  { value: 'regex', label: 'matches regex' }
]
const FALLBACK_OPTIONS = [
  { value: 'off', label: 'No fallback' },
  { value: 'retry', label: 'Retry the same model' },
  { value: 'model-chain', label: 'Try a model chain' }
]

function providerOptions() {
  return read(providers).map((provider) => ({ value: provider.name, label: provider.displayName || provider.name }))
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

// Resolve the name every draft row will be saved under. Typed names win; blank
// rows get `<provider>-key`, `<provider>-key-2`, ... skipping anything already
// taken and any name typed in another row.
function draftKeyNames(providerName: string, drafts: KeyDraft[], taken: Set<string>) {
  const base = `${providerName || 'provider'}-key`
  const used = new Set(taken)
  const blocked = new Set(taken)
  for (const draft of drafts) {
    const typed = draft.name.trim()
    if (typed) blocked.add(typed)
  }
  return drafts.map((draft) => {
    const typed = draft.name.trim()
    if (typed) return reserveName(typed, used)
    let candidate = base
    let index = 2
    while (used.has(candidate) || blocked.has(candidate)) {
      candidate = `${base}-${index}`
      index += 1
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
    set(defaultProvider, status.defaultProvider ?? '')
    set(providers, status.providers)
    set(routes, status.routes)
    set(aliases, status.aliases)
    set(clientKeys, status.clientKeys)
    set(agentList, status.agents ?? [])
    set(logs, status.logs)
    set(config, loadedConfig.config)
    set(usage, metrics)
    set(presetList, presets.presets)
    if (!read(keyProvider) && status.providers.length) set(keyProvider, status.providers[0].name)
  } catch (cause) {
    set(error, `Status failed: ${(cause as Error).message}`)
  } finally {
    set(loaded, true)
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
    const down = results.filter((result) => !result.ok)
    set(
      message,
      down.length
        ? `Unreachable: ${down.map((result) => `${result.provider}${result.message ? ` (${result.message})` : ''}`).join(', ')}`
        : `${results.length} provider${results.length === 1 ? '' : 's'} reachable`
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

async function saveConfig(mutator: (next: RouterConfig) => void) {
  const current = read(config)
  if (!current) {
    set(error, 'Config not loaded yet')
    return false
  }
  const next = structuredClone(current)
  mutator(next)
  try {
    await plugin.request('router.config.save', { config: next })
    set(config, next)
    await refresh()
    return true
  } catch (cause) {
    set(error, `Save failed: ${(cause as Error).message}`)
    return false
  }
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
    set(keyProvider, result.provider)
    await refresh()
  } catch (cause) {
    set(error, `Add provider failed: ${(cause as Error).message}`)
  }
}

async function addCustomProvider() {
  const name = read(customName).trim()
  const baseUrl = read(customBaseUrl).trim()
  if (!name || !baseUrl) {
    set(error, 'Custom provider needs a name and base URL')
    return
  }
  const protocols: string[] = []
  if (read(customOpenAI)) protocols.push('openai')
  if (read(customAnthropic)) protocols.push('anthropic')
  if (read(customResponses)) protocols.push('responses')
  if (!protocols.length) {
    set(error, 'Enable at least one protocol')
    return
  }
  const models = read(customModels)
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((id) => ({ id }))
  set(error, '')
  set(message, '')
  const saved = await saveConfig((next) => {
    next.providers.push({ name, baseUrl, protocols, models, keys: [] })
    if (!next.defaultProvider) next.defaultProvider = name
  })
  if (!saved) return
  let added = 0
  try {
    added = await addDraftKeys(name, read(customKeys), existingSecretNames())
  } catch (cause) {
    set(error, `Provider saved, but a key failed: ${(cause as Error).message}`)
  }
  set(message, `Added provider ${name}${added ? ` with ${added} key${added === 1 ? '' : 's'}` : ''}`)
  set(customName, '')
  set(customBaseUrl, '')
  set(customModels, '')
  set(customKeys, [blankKeyDraft()])
  set(addProviderOpen, false)
  set(keyProvider, name)
  await refresh()
}

async function removeProvider(name: string) {
  await saveConfig((next) => {
    next.providers = next.providers.filter((provider) => provider.name !== name)
    if (next.defaultProvider === name) next.defaultProvider = next.providers[0]?.name ?? ''
  })
}

async function makeDefault(name: string) {
  await saveConfig((next) => {
    next.defaultProvider = name
  })
}

// Add every filled draft row to a provider's key pool. Limits are validated up
// front so a bad row does not leave a partial batch behind. Returns how many
// keys were added.
async function addDraftKeys(providerName: string, drafts: KeyDraft[], taken: Set<string>) {
  const names = draftKeyNames(providerName, drafts, taken)
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
  patch: { enabled?: boolean; priority?: number; weight?: number; limits?: Record<string, unknown> }
) {
  set(error, '')
  set(message, '')
  try {
    await plugin.request('router.key.update', { provider: providerName, secretKey, ...patch })
    await refresh()
  } catch (cause) {
    set(error, `Key update failed: ${(cause as Error).message}`)
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

// Key values never live in the config (which stores secret names only), so
// reveal and copy read the encrypted value from Orca's secret store on demand.
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

async function toggleProviderKeyView(secretKey: string) {
  set(error, '')
  set(message, '')
  if (read(revealedKeyName) === secretKey) {
    set(revealedKeyName, '')
    set(revealedKeyValue, '')
    return
  }
  try {
    const value = await providerKeyValue(secretKey)
    set(revealedKeyValue, value)
    set(revealedKeyName, secretKey)
  } catch (cause) {
    set(revealedKeyName, '')
    set(revealedKeyValue, '')
    set(error, `View key failed: ${(cause as Error).message}`)
  }
}

async function discover(name: string) {
  set(error, '')
  set(message, '')
  set(fetchingModels, true)
  try {
    const result = await plugin.request('router.discoverModels', { provider: name })
    const cfg = configProvider(name)
    const known = new Map((cfg?.models ?? []).map((model) => [model.id, model]))
    const ids = mergeModelText((cfg?.models ?? []).map((model) => model.id).join('\n'), result.models)
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)
    const added = ids.filter((id) => !known.has(id))
    const saved = await saveConfig((next) => {
      const provider = next.providers.find((item) => item.name === name)
      if (!provider) return
      provider.models = ids.map((id) => known.get(id) ?? { id })
    })
    if (saved) {
      set(message, `Fetched ${result.models.length} models for ${name}${added.length ? `; added ${added.length} new` : ''}`)
    }
  } catch (cause) {
    set(error, `Fetch models failed: ${(cause as Error).message}`)
  } finally {
    set(fetchingModels, false)
  }
}

// Merge a fetched model list into the text the user already typed, keeping
// their order and adding only ids that are new.
function mergeModelText(existing: string, fetched: string[]) {
  const current = existing
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
  const seen = new Set(current)
  const merged = [...current]
  for (const id of fetched) {
    if (!seen.has(id)) {
      seen.add(id)
      merged.push(id)
    }
  }
  return merged.join('\n')
}

// Fill the custom provider's model textarea from its endpoint. The form is not
// saved yet, so the base URL, protocols and (optional) key come straight from
// the fields.
async function fetchCustomModels() {
  const baseUrl = read(customBaseUrl).trim()
  if (!baseUrl) {
    set(error, 'Add a base URL before fetching models')
    return
  }
  const protocols: string[] = []
  if (read(customOpenAI)) protocols.push('openai')
  if (read(customAnthropic)) protocols.push('anthropic')
  if (read(customResponses)) protocols.push('responses')
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
    set(customModels, mergeModelText(read(customModels), result.models))
    set(message, `Fetched ${result.models.length} model${result.models.length === 1 ? '' : 's'}`)
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
    set(providerEditModels, mergeModelText(read(providerEditModels), result.models))
    set(message, `Fetched ${result.models.length} model${result.models.length === 1 ? '' : 's'} for ${name}`)
  } catch (cause) {
    set(error, `Fetch models failed: ${(cause as Error).message}`)
  } finally {
    set(fetchingModels, false)
  }
}

async function fetchUsage(name: string) {
  set(error, '')
  set(message, '')
  try {
    const result = await plugin.request('router.testUsage', { provider: name })
    const summary = result.meters
      .map((meter) => {
        const item = meter as { id?: string; remaining?: unknown; used?: unknown; unit?: string }
        return `${item.id ?? 'meter'}: ${item.remaining ?? item.used ?? 'n/a'} ${item.unit ?? ''}`.trim()
      })
      .join('; ')
    set(message, result.errors.length && !result.meters.length ? `Usage failed: ${result.errors[0].message}` : summary || 'Usage: no meters returned')
  } catch (cause) {
    set(error, `Usage failed: ${(cause as Error).message}`)
  }
}

function startEditProvider(provider: ProviderView) {
  const cfg = configProvider(provider.name)
  set(providerEditFor, provider.name)
  set(providerEditDisplayName, cfg?.displayName ?? provider.displayName ?? '')
  set(providerEditBaseUrl, cfg?.baseUrl ?? provider.baseUrl)
  set(providerEditModels, (cfg?.models ?? []).map((model) => model.id).join('\n'))
}

async function saveProviderEdit(name: string) {
  const cfg = configProvider(name)
  // Providers that route each protocol to its own base URL keep their endpoint
  // URLs; this editor only manages the name and model list for them.
  const perProtocol = (cfg?.endpoints?.length ?? 0) > 1
  const baseUrl = read(providerEditBaseUrl).trim()
  if (!perProtocol && !baseUrl) {
    set(error, 'Provider needs a base URL')
    return
  }
  // Keep description/pricing on models that survive the edit.
  const known = new Map((cfg?.models ?? []).map((model) => [model.id, model]))
  const models = read(providerEditModels)
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((id) => known.get(id) ?? { id })
  const displayName = read(providerEditDisplayName).trim()
  set(error, '')
  set(message, '')
  const saved = await saveConfig((next) => {
    const provider = next.providers.find((item) => item.name === name)
    if (!provider) return
    if (!perProtocol) {
      const protocols = provider.protocols ?? cfg?.protocols ?? []
      provider.baseUrl = baseUrl
      provider.endpoints = [{ baseUrl, protocols }]
    }
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
async function addRule() {
  const name = read(ruleName).trim()
  const field = read(ruleField).trim()
  const value = read(ruleValue)
  const key = read(rewriteKey).trim()
  if (!field || !value || !key) {
    set(error, 'Rule needs a condition field, a value and a rewrite key')
    return
  }
  const mode = read(fallbackMode) as 'off' | 'retry' | 'model-chain'
  const models = read(fallbackModels)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const retryCount = Number(read(fallbackRetry) || 0)
  const editIndex = read(ruleEditIndex)
  const existing = editIndex >= 0 ? read(routes)[editIndex] : undefined
  const rule: RouteRule = {
    id: existing?.id ?? `rule-${Date.now().toString(36)}`,
    name: name || existing?.name || `Rule ${read(routes).length + 1}`,
    enabled: existing?.enabled ?? true,
    condition: { source: read(ruleSource) as 'request.body', field, operator: read(ruleOperator), value },
    rewrites: [{ key, operation: read(rewriteOperation) as 'set', value: parseMaybe(read(rewriteValue)) }],
    fallback:
      mode === 'off'
        ? { mode: 'off' }
        : mode === 'retry'
          ? { mode: 'retry', models, retryCount }
          : { mode: 'model-chain', models, retryCount }
  }
  const saved = await saveConfig((next) => {
    if (editIndex >= 0) next.routes[editIndex] = rule
    else next.routes.push(rule)
  })
  if (saved) {
    set(ruleName, '')
    set(rewriteValue, '')
    set(fallbackModels, '')
    set(ruleOpen, false)
    set(ruleEditIndex, -1)
  }
}

function startEditRule(index: number) {
  const rule = read(routes)[index]
  if (!rule) return
  const rewrite = rule.rewrites?.[0]
  set(ruleEditIndex, index)
  set(ruleName, rule.name)
  set(ruleSource, rule.condition?.source ?? 'request.body')
  set(ruleField, rule.condition?.field ?? 'model')
  set(ruleOperator, rule.condition?.operator ?? 'starts-with')
  set(ruleValue, rule.condition?.value ?? '')
  set(rewriteKey, rewrite?.key ?? 'request.body.model')
  set(rewriteOperation, (rewrite?.operation as string | undefined) ?? 'set')
  set(
    rewriteValue,
    rewrite?.value === undefined ? '' : typeof rewrite.value === 'string' ? rewrite.value : JSON.stringify(rewrite.value)
  )
  set(fallbackMode, rule.fallback?.mode ?? 'off')
  set(fallbackRetry, String(rule.fallback?.retryCount ?? 0))
  set(fallbackModels, (rule.fallback?.models ?? []).join(', '))
  set(ruleOpen, true)
}

function cancelRuleEdit() {
  set(ruleEditIndex, -1)
  set(ruleName, '')
  set(rewriteValue, '')
  set(fallbackModels, '')
  set(ruleOpen, false)
}

async function removeRule(index: number) {
  const saved = await saveConfig((next) => {
    next.routes.splice(index, 1)
  })
  if (!saved) return
  const editing = read(ruleEditIndex)
  if (editing === index) set(ruleEditIndex, -1)
  else if (editing > index) set(ruleEditIndex, editing - 1)
}

async function toggleRule(index: number, enabled: boolean) {
  await saveConfig((next) => {
    const rule = next.routes[index]
    if (rule) rule.enabled = enabled
  })
}

async function addAlias() {
  const name = read(aliasName).trim()
  const target = read(aliasTarget).trim()
  if (!name || !target) {
    set(error, 'Alias needs a name and a target model')
    return
  }
  const previous = read(aliasEditName)
  const saved = await saveConfig((next) => {
    if (previous && previous !== name) delete next.aliases[previous]
    next.aliases[name] = target
  })
  if (saved) {
    set(aliasName, '')
    set(aliasTarget, '')
    set(aliasOpen, false)
    set(aliasEditName, '')
  }
}

function startEditAlias(name: string, target: string) {
  set(aliasEditName, name)
  set(aliasName, name)
  set(aliasTarget, target)
  set(aliasOpen, true)
}

async function removeAlias(name: string) {
  const saved = await saveConfig((next) => {
    delete next.aliases[name]
  })
  if (!saved) return
  if (read(aliasEditName) === name) {
    set(aliasEditName, '')
    set(aliasName, '')
    set(aliasTarget, '')
    set(aliasOpen, false)
  }
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
function conditionSummary(rule: RouteRule) {
  const condition = rule.condition
  if (!condition) return 'Always matches'
  return `${condition.source.replace('request.', '')} · ${condition.field} ${condition.operator.replace(/-/g, ' ')} ${condition.value}`
}

function rewriteSummary(rule: RouteRule) {
  const rewrites = rule.rewrites ?? []
  if (!rewrites.length) return 'Pass through'
  return rewrites.map((rewrite) => `${rewrite.key} = ${String(rewrite.value ?? '(empty)')}`).join(', ')
}

function fallbackSummary(rule: RouteRule) {
  const fallback = rule.fallback
  if (!fallback || fallback.mode === 'off') return 'No fallback'
  if (fallback.mode === 'retry') return `Retry ×${fallback.retryCount ?? 0}`
  return `Chain: ${(fallback.models ?? []).join(' → ') || 'no models set'}`
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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('router.log', ({ entry }) => update(logs, (list) => [...list.slice(-99), entry]))
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
  void runRefresh()
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
  providerName,
  taken,
  onChange,
  onRemove
}: {
  drafts: KeyDraft[]
  providerName: string
  taken: Set<string>
  onChange: (index: number, patch: Partial<KeyDraft>) => void
  onRemove: (index: number) => void
}) {
  const names = draftKeyNames(providerName, drafts, taken)
  return (
    <>
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
                  onPress={() => onRemove(index)}
                />
              ) : null}
            </Row>
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
              <Button size="xs" variant="ghost" onPress={() => onChange(index, { open: !draft.open })}>
                {draft.open ? 'Hide options' : 'Options'}
              </Button>
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
  children
}: WithChildren & {
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  extra?: WithChildren['children']
}) {
  return (
    <Stack gap="sm" align="stretch">
      <Row gap="xs" wrap align="center">
        <Button
          variant={open ? 'ghost' : 'solid'}
          tone={open ? undefined : 'accent'}
          icon={open ? 'close' : 'add'}
          onPress={() => onOpenChange(!open)}
        >
          {open ? 'Cancel' : label}
        </Button>
        {extra}
      </Row>
      {open ? (
        <Box background="muted" radius="md" padding="sm">
          {children}
        </Box>
      ) : null}
    </Stack>
  )
}

// An always-visible explainer banner: the title line stays put, and the body
// expands on demand. Tabs pass the "auto" state so an empty configuration
// starts open while a configured one starts collapsed.
function InfoBanner({
  title,
  tone = 'neutral',
  open,
  onOpenChange,
  children
}: WithChildren & {
  title: string
  tone?: Tone
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Box background="muted" border={tone} radius="md" paddingX="xs">
      <Stack gap="xs">
        <Row gap="xs" align="center">
          <Box grow>
            <List label={title}>
              <ListItem icon="info" onPress={() => onOpenChange(!open)}>
                <Text size="sm" weight="semibold">
                  {title}
                </Text>
              </ListItem>
            </List>
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
        {open ? (
          <Box paddingX="xs" paddingY="xs">
            {children}
          </Box>
        ) : null}
      </Stack>
    </Box>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <Stack gap="xs">
      <Text muted size="xs">
        {label}
      </Text>
      <Text size="md" weight="semibold" tone={tone} truncate>
        {value}
      </Text>
    </Stack>
  )
}

function LogRow({ entry }: { entry: LogEntry }) {
  const model = entry.resolvedModel ?? entry.model ?? '(no model)'
  const provider = entry.resolvedProvider ?? entry.upstream ?? '—'
  const success = entry.status < 400
  return (
    <Box background="muted" radius="md" padding="sm">
      <Stack gap="xs">
        <Row justify="between" align="start" gap="sm">
          <Box grow>
            <Text size="sm" weight="medium" truncate>
              {model}
            </Text>
          </Box>
          <Badge tone={success ? 'success' : 'danger'}>{String(entry.status)}</Badge>
        </Row>
        <Text muted size="xs" truncate>
          {provider} · {entry.protocol}
        </Text>
        <Row justify="between" align="center" gap="sm" wrap>
          <Text muted size="xs">
            <RelativeTime at={entry.at} format="short" />
          </Text>
          <Text muted size="xs">
            {entry.latencyMs == null ? '—' : `${entry.latencyMs} ms`} · {tokenCount(entry)} tokens
          </Text>
        </Row>
      </Stack>
    </Box>
  )
}

function Navigation() {
  const raw = read(tab)
  const active = raw === 'keys' ? 'overview' : raw
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
  const defaultName = read(defaultProvider)
  return (
    <Stack gap="sm">
      <Row justify="between" align="start" gap="sm">
        <Stack gap="xs">
          <Heading>Orca LLM Router</Heading>
          <Row gap="xs" align="center" wrap>
            <Badge tone={isRunning ? 'success' : 'warning'}>{isRunning ? 'Running' : 'Stopped'}</Badge>
            <Text muted size="xs" truncate>
              {isRunning ? `${read(host)}:${read(port)}` : 'Gateway is not listening'}
              {defaultName ? ` · ${defaultName}` : ''}
            </Text>
          </Row>
        </Stack>
        <IconButton icon="refresh" label="Refresh status" tooltip="Refresh status" onPress={() => void refresh()} />
      </Row>

      <Row gap="xs" wrap>
        <Button
          variant={isRunning ? 'outline' : 'solid'}
          tone={isRunning ? undefined : 'accent'}
          icon={isRunning ? 'stop' : 'play'}
          onPress={() => void mutate(isRunning ? 'router.stop' : 'router.start')}
        >
          {isRunning ? 'Stop' : 'Start gateway'}
        </Button>
        <Button variant="ghost" icon="refresh" onPress={() => void mutate('router.restart')}>
          Restart
        </Button>
        <Button
          variant="ghost"
          icon="activity"
          tooltip={providerCount ? 'Test every provider' : 'Add a provider first'}
          disabled={!providerCount}
          onPress={() => void testProviders()}
        >
          Test
        </Button>
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
  const gateway = `http://${read(host)}:${read(port)}`
  const aliasCount = Object.keys(read(aliases)).length
  const keyCount = read(clientKeys).length
  const routedAgents = read(agentList).filter((agent) => agent.enabled).length
  const ruleCount = read(routes).length
  const recent = read(logs).slice(-4).reverse()
  const hasTraffic = metric != null && metric.requests > 0

  return (
    <Stack gap="md">
      <InfoBanner
        tone="accent"
        title="Welcome to Orca LLM Router"
        open={read(overviewInfoOpen) ?? ups.length === 0}
        onOpenChange={(open) => set(overviewInfoOpen, open)}
      >
        <Stack gap="sm">
          <Text size="sm">
            This panel runs a local gateway between your agents and model providers. It speaks the OpenAI and
            Anthropic APIs, then routes each request to a provider you configure — applying aliases, rules and
            fallback along the way.
          </Text>
          <Text size="sm">
            There are no providers yet, so nothing can be routed. Add one from a preset, create a custom endpoint, or
            import your existing config. Once traffic flows, this tab shows status, usage, the gateway addresses and
            recent activity.
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
            <Button variant="ghost" onPress={() => set(tab, 'import')}>
              Import config
            </Button>
          </Row>
        </Stack>
      </InfoBanner>

      <Box background="muted" radius="lg" padding="md">
        <Stack gap="md">
          <Grid columns={3} gap="md">
            <Metric label="Providers" value={String(ups.length)} tone={ups.length ? 'success' : 'warning'} />
            <Metric label="Requests" value={metric ? String(metric.requests) : '—'} />
            <Metric
              label="Success"
              value={metric && hasTraffic ? `${(metric.successRate * 100).toFixed(1)}%` : '—'}
              tone={
                metric && hasTraffic
                  ? metric.successRate >= 0.95
                    ? 'success'
                    : metric.successRate >= 0.8
                      ? 'warning'
                      : 'danger'
                  : undefined
              }
            />
            <Metric label="Tokens" value={metric ? formatNumber(metric.totalTokens) : '—'} />
            <Metric label="Cost" value={metric ? formatUsd(metric.cost) : '—'} />
            <Metric label="Avg latency" value={metric ? `${metric.avgLatencyMs.toFixed(0)} ms` : '—'} />
          </Grid>

          <Separator />

          <Row gap="xs" wrap align="center">
            <Badge tone="neutral">{routedAgents} agents</Badge>
            <Badge tone="neutral">{ruleCount} rules</Badge>
            <Badge tone="neutral">{aliasCount} aliases</Badge>
            <Badge tone="neutral">{keyCount} client keys</Badge>
          </Row>
        </Stack>
      </Box>

      {metric && (metric.byProvider.length || metric.byModel.length) ? (
        <Stack gap="xs">
          {metric.byProvider.length ? (
            <Text muted size="xs">
              Top providers: {metric.byProvider.slice(0, 3).map((item) => `${item.provider} ${item.count}`).join(' · ')}
            </Text>
          ) : null}
          {metric.byModel.length ? (
            <Text muted size="xs">
              Top models: {metric.byModel.slice(0, 3).map((item) => `${item.model} ${item.count}`).join(' · ')}
            </Text>
          ) : null}
        </Stack>
      ) : null}

      {!metric ? (
        <Text muted size="sm">
          No usage recorded yet. Launch an agent and send a request.
        </Text>
      ) : null}

      <Card>
        <Stack gap="sm">
          <Row justify="between" align="center" wrap gap="xs">
            <Heading level={2}>Gateway</Heading>
            <Row gap="xs" align="center">
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
          <Separator />
          <EndpointTile label="OpenAI base URL" value={`${gateway}/v1`} />
          <EndpointTile label="Anthropic base URL" value={gateway} />
          <Separator />
          <Select
            label="Default provider"
            value={read(defaultProvider)}
            placeholder={ups.length ? 'Choose a provider' : 'No providers yet'}
            options={providerOptions()}
            disabled={!ups.length}
            onChange={(value) => void makeDefault(value)}
          />
          <Text muted size="xs">
            Agents receive these URLs plus the launch token when Orca starts them. The default provider handles
            requests that do not name a provider.
          </Text>
          <Collapsible
            title="Client access keys"
            description={keyCount ? `${keyCount} ${keyCount === 1 ? 'key' : 'keys'}` : 'Keys for tools outside Orca'}
            open={read(clientKeysOpen)}
            onChange={(open) => set(clientKeysOpen, open)}
          >
            <ClientAccess />
          </Collapsible>
        </Stack>
      </Card>

      <Card title="Recent activity" description="The latest routed requests">
        {recent.length ? (
          <Stack gap="xs">
            {recent.map((entry, index) => (
              <LogRow key={`${entry.at}-${index}`} entry={entry} />
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

function ProviderCard({ provider }: { provider: ProviderView }) {
  const cfg = configProvider(provider.name)
  const enabled = cfg?.enabled !== false
  const isDefault = read(defaultProvider) === provider.name
  const models = provider.models ?? []
  const pool = cfg?.keys ?? []
  const keyCount = cfg ? pool.length : provider.keyCount
  const formOpen = read(keyFormFor) === provider.name
  const editing = read(providerEditFor) === provider.name
  const perProtocol = (cfg?.endpoints?.length ?? 0) > 1
  const drafts = read(keyDrafts)
  const filledDrafts = drafts.filter((draft) => draft.value.trim()).length
  const draftNames = draftKeyNames(provider.name, drafts, existingSecretNames())
  function addAnotherKey() {
    set(keyDrafts, [...drafts, blankKeyDraft()])
  }
  return (
    <Card>
      <Stack gap="md">
        <Stack gap="xs">
          <Row gap="xs" align="center" wrap>
            <Heading level={3}>{provider.displayName || provider.name}</Heading>
            <Badge tone={enabled ? (keyCount ? 'success' : 'warning') : 'neutral'}>
              {enabled ? (keyCount ? `${keyCount} ${keyCount === 1 ? 'key' : 'keys'}` : 'no key') : 'disabled'}
            </Badge>
            {isDefault ? <Badge tone="accent">default</Badge> : null}
          </Row>
          <Text muted size="xs">
            {provider.baseUrl}
          </Text>
        </Stack>

        <KeyValue
          items={[
            {
              label: 'Models',
              value: models.length ? `${models.length} · ${models.slice(0, 4).join(', ')}` : 'Not discovered'
            }
          ]}
        />

        {editing ? (
          <Stack gap="sm">
            <Input
              label="Display name (optional)"
              placeholder={provider.name}
              value={read(providerEditDisplayName)}
              onChange={(value) => set(providerEditDisplayName, value)}
            />
            {perProtocol ? null : (
              <Input
                label="Base URL"
                placeholder="https://api.example.com/v1"
                value={read(providerEditBaseUrl)}
                onChange={(value) => set(providerEditBaseUrl, value)}
              />
            )}
            <Textarea
              label="Model IDs"
              placeholder={'gpt-4o\nclaude-sonnet-4-20250514'}
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
              <Text muted size="xs">
                Merges the endpoint's list into these IDs.
              </Text>
            </Row>
            <Row gap="xs" wrap>
              <Button size="xs" variant="solid" tone="accent" onPress={() => void saveProviderEdit(provider.name)}>
                Save changes
              </Button>
              <Button size="xs" variant="ghost" onPress={() => set(providerEditFor, '')}>
                Cancel
              </Button>
            </Row>
          </Stack>
        ) : null}

        <Row gap="xs" wrap align="center">
          <Button size="xs" variant="outline" icon="activity" onPress={() => void testProvider(provider.name)}>
            Test
          </Button>
          <Button size="xs" variant="ghost" icon="search" disabled={read(fetchingModels)} onPress={() => void discover(provider.name)}>
            Fetch models
          </Button>
          <Button size="xs" variant="ghost" icon="bar-chart-3" onPress={() => void fetchUsage(provider.name)}>
            Usage
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
          <Row justify="between" align="center" gap="sm">
            <Text size="sm" weight="semibold">
              Keys
            </Text>
            {formOpen ? null : (
              <Button
                size="xs"
                variant="outline"
                icon="add"
                onPress={() => {
                  set(keyProvider, provider.name)
                  set(keyDrafts, [blankKeyDraft()])
                  set(keyFormFor, provider.name)
                }}
              >
                Add key
              </Button>
            )}
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
            const revealed = read(revealedKeyName) === key.secretKey
            const keyLabel = key.id || key.secretKey
            return (
              <Stack key={key.secretKey || key.id} gap="sm">
                <Row justify="between" align="center" gap="sm">
                  <Box grow>
                    <Switch
                      label={key.id || key.secretKey}
                      checked={key.enabled !== false}
                      onChange={(checked) => void updateProviderKey(provider.name, key.secretKey, { enabled: checked })}
                    />
                  </Box>
                  <Row gap="xs" align="center">
                    <Button
                      size="xs"
                      variant="ghost"
                      icon="copy"
                      tooltip="Copy key value"
                      onPress={() => void copyProviderKey(key.secretKey)}
                    >
                      Copy
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={revealed ? 'collapse' : 'search'}
                      tooltip={revealed ? 'Hide key' : 'View key'}
                      onPress={() => void toggleProviderKeyView(key.secretKey)}
                    >
                      {revealed ? 'Hide' : 'View'}
                    </Button>
                    <IconButton
                      size="xs"
                      icon="delete"
                      label={`Remove key ${keyLabel}`}
                      tooltip="Remove key"
                      onPress={() => set(confirmTarget, token)}
                    />
                  </Row>
                </Row>
                {revealed ? <Code block>{read(revealedKeyValue)}</Code> : null}
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

function Providers() {
  const ups = read(providers)
  const preset = findPreset(read(presetId))
  return (
    <Stack gap="md">
      <AddSection
        label="Add provider"
        open={read(addProviderOpen)}
        onOpenChange={(open) => set(addProviderOpen, open)}
        extra={
          <Button variant="outline" icon="download" onPress={() => set(tab, 'import')}>
            Import config
          </Button>
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
              <Stack gap="sm">
                <Text size="sm" weight="semibold">
                  Keys
                </Text>
                <KeyDraftRows
                  drafts={read(presetKeys)}
                  providerName={presetProviderName()}
                  taken={existingSecretNames()}
                  onChange={(index, patch) => patchDraft(presetKeys, index, patch)}
                  onRemove={(index) => dropDraft(presetKeys, index)}
                />
                <Button size="xs" variant="outline" icon="add" onPress={() => appendDraft(presetKeys)}>
                  Add another key
                </Button>
              </Stack>
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
          ) : (
            <Stack gap="sm">
              <Heading level={3}>Endpoint</Heading>
              <Input label="Name" placeholder="my-provider" value={read(customName)} onChange={(value) => set(customName, value)} />
              <Input
                label="Base URL"
                placeholder="https://api.example.com/v1 or http://127.0.0.1:11434/v1"
                value={read(customBaseUrl)}
                onChange={(value) => set(customBaseUrl, value)}
              />
              <Heading level={3}>Protocols</Heading>
              <Switch label="OpenAI Chat Completions" checked={read(customOpenAI)} onChange={(checked) => set(customOpenAI, checked)} />
              <Switch label="Anthropic Messages" checked={read(customAnthropic)} onChange={(checked) => set(customAnthropic, checked)} />
              <Switch label="OpenAI Responses" checked={read(customResponses)} onChange={(checked) => set(customResponses, checked)} />
              <Heading level={3}>Models</Heading>
              <Textarea
                label="Model IDs"
                placeholder={'gpt-4o\nclaude-sonnet-4-20250514'}
                rows={4}
                value={read(customModels)}
                onChange={(value) => set(customModels, value)}
              />
              <Row gap="xs" wrap align="center">
                <Button
                  size="xs"
                  variant="outline"
                  icon="search"
                  disabled={read(fetchingModels) || !read(customBaseUrl).trim()}
                  onPress={() => void fetchCustomModels()}
                >
                  {read(fetchingModels) ? 'Fetching…' : 'Fetch models'}
                </Button>
                <Text muted size="xs">
                  Asks the endpoint for its model list.
                </Text>
              </Row>
              <Stack gap="sm">
                <Text size="sm" weight="semibold">
                  Keys
                </Text>
                <KeyDraftRows
                  drafts={read(customKeys)}
                  providerName={read(customName).trim() || 'provider'}
                  taken={existingSecretNames()}
                  onChange={(index, patch) => patchDraft(customKeys, index, patch)}
                  onRemove={(index) => dropDraft(customKeys, index)}
                />
                <Button size="xs" variant="outline" icon="add" onPress={() => appendDraft(customKeys)}>
                  Add another key
                </Button>
              </Stack>
              <Row gap="xs" wrap>
                <Button variant="solid" tone="accent" onPress={() => void addCustomProvider()}>
                  Add provider
                </Button>
              </Row>
              <Text muted size="xs">
                Use Fetch models to fill the list. Add as many keys as you like; they form the provider's pool and are
                stored in Orca's secret store.
              </Text>
            </Stack>
          )}
        </Stack>
      </AddSection>

      <InfoBanner
        title="What providers are"
        open={read(providersInfoOpen) ?? ups.length === 0}
        onOpenChange={(open) => set(providersInfoOpen, open)}
      >
        <Text size="sm">
          A provider is an upstream model service the gateway forwards to — OpenAI, Anthropic, a local server, or any
          OpenAI- or Anthropic-compatible endpoint. Each one has a base URL, one or more protocols, the models it
          serves, and a pool of API keys used round-robin. Add a preset provider, or define a custom endpoint above.
        </Text>
      </InfoBanner>

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

function RouteCard({ rule, index }: { rule: RouteRule; index: number }) {
  return (
    <Card title={rule.name}>
      <Stack gap="sm">
        <KeyValue
          items={[
            { label: 'When', value: conditionSummary(rule) },
            { label: 'Rewrite', value: rewriteSummary(rule) },
            { label: 'Fallback', value: fallbackSummary(rule) }
          ]}
        />
        <Row justify="between" align="center" wrap gap="sm">
          <Switch
            label="Enabled"
            checked={rule.enabled !== false}
            onChange={(checked) => void toggleRule(index, checked)}
          />
          <Row gap="xs" align="center">
            <Button size="xs" variant="ghost" icon="edit" onPress={() => startEditRule(index)}>
              Edit
            </Button>
            <IconButton size="xs" icon="delete" label={`Delete rule ${rule.name}`} onPress={() => set(confirmTarget, `rule:${index}`)} />
          </Row>
        </Row>
        {read(confirmTarget) === `rule:${index}` ? (
          <ConfirmDelete
            confirmLabel="Delete rule"
            message={`Delete rule ${rule.name}? Traffic it matched falls through to the next rule.`}
            onConfirm={() => {
              set(confirmTarget, '')
              void removeRule(index)
            }}
            onCancel={() => set(confirmTarget, '')}
          />
        ) : null}
      </Stack>
    </Card>
  )
}

function Routes() {
  const rts = read(routes)
  const aliasesMap = read(aliases)
  const aliasCount = Object.keys(aliasesMap).length
  const ups = read(providers)
  const exampleProvider = ups[0]
  const exampleModel = exampleProvider?.models?.[0]
  const exampleTarget = exampleProvider && exampleModel ? `${exampleProvider.name}/${exampleModel}` : ''
  return (
    <Stack gap="md">
      <AddSection
        label={read(ruleEditIndex) >= 0 ? 'Edit routing rule' : 'Add a routing rule'}
        open={read(ruleOpen)}
        onOpenChange={(open) => {
          if (open) set(ruleOpen, true)
          else cancelRuleEdit()
        }}
      >
        <Stack gap="sm">
          <Heading level={3}>Match</Heading>
          <Input label="Rule name" placeholder="Claude requests" value={read(ruleName)} onChange={(value) => set(ruleName, value)} />
          <Select label="Match source" value={read(ruleSource)} options={SOURCE_OPTIONS} onChange={(value) => set(ruleSource, value)} />
          <Input label="Field" placeholder="model" value={read(ruleField)} onChange={(value) => set(ruleField, value)} />
          <Select label="Operator" value={read(ruleOperator)} options={OPERATOR_OPTIONS} onChange={(value) => set(ruleOperator, value)} />
          <Input label="Value" placeholder="claude-" value={read(ruleValue)} onChange={(value) => set(ruleValue, value)} />

          <Separator />
          <Heading level={3}>Rewrite</Heading>
          <Input
            label="Rewrite key"
            placeholder="request.body.model"
            value={read(rewriteKey)}
            onChange={(value) => set(rewriteKey, value)}
          />
          <Input
            label="Rewrite value"
            placeholder="anthropic/claude-sonnet-4-20250514"
            value={read(rewriteValue)}
            onChange={(value) => set(rewriteValue, value)}
          />
          <Text muted size="xs">
            Rewrites use dot paths. JSON values such as numbers or objects are parsed automatically.
          </Text>

          <Separator />
          <Heading level={3}>Fallback</Heading>
          <Select label="Fallback" value={read(fallbackMode)} options={FALLBACK_OPTIONS} onChange={(value) => set(fallbackMode, value)} />
          {read(fallbackMode) !== 'off' ? (
            <Input label="Retries" placeholder="0" value={read(fallbackRetry)} onChange={(value) => set(fallbackRetry, value)} />
          ) : null}
          {read(fallbackMode) === 'model-chain' ? (
            <Input
              label="Fallback models"
              placeholder="openai/gpt-4o, openrouter/anthropic/claude-3.7-sonnet"
              value={read(fallbackModels)}
              onChange={(value) => set(fallbackModels, value)}
            />
          ) : null}

          <Button variant="solid" tone="accent" onPress={() => void addRule()}>
            {read(ruleEditIndex) >= 0 ? 'Save rule' : 'Add rule'}
          </Button>
        </Stack>
      </AddSection>

      <InfoBanner
        title="What rules and aliases do"
        open={read(routesInfoOpen) ?? (rts.length === 0 && aliasCount === 0)}
        onOpenChange={(open) => set(routesInfoOpen, open)}
      >
        <Text size="sm">
          Rules decide how requests are routed. Each rule matches a request field (usually the model name), then
          rewrites the model or attaches a retry and fallback chain. Aliases give a model a short, stable name — for
          example <Code>fast</Code> → <Code>{exampleTarget || 'openai/gpt-4o-mini'}</Code> — so you can swap
          providers without editing your agent setup.
        </Text>
      </InfoBanner>

      {rts.length === 0 ? (
        aliasCount > 0 ? (
          <Text muted size="sm">
            No rules yet. Requests are routed by model name. Add a rule to rewrite models or to attach a fallback chain.
          </Text>
        ) : null
      ) : (
        <Stack gap="sm">
          {rts.map((rule, index) => (
            <RouteCard key={`${rule.id ?? rule.name}-${index}`} rule={rule} index={index} />
          ))}
        </Stack>
      )}

      <Separator />

      <Card title="Model aliases">
        <AddSection
          label={read(aliasEditName) ? 'Edit alias' : 'Add an alias'}
          open={read(aliasOpen)}
          onOpenChange={(open) => {
            set(aliasOpen, open)
            if (!open) {
              set(aliasEditName, '')
              set(aliasName, '')
              set(aliasTarget, '')
            }
          }}
        >
          <Stack gap="sm">
            <Input
              label="Alias"
              placeholder="fast"
              value={read(aliasName)}
              onChange={(value) => set(aliasName, value)}
            />
            <Text muted size="xs">
              The short model name tools send — for example <Code>fast</Code>.
            </Text>
            <Input
              label="Target"
              placeholder={exampleTarget || 'openai/gpt-4o-mini'}
              value={read(aliasTarget)}
              onChange={(value) => set(aliasTarget, value)}
            />
            <Text muted size="xs">
              The provider/model it expands to, for example <Code>{exampleTarget || 'openai/gpt-4o-mini'}</Code>.
            </Text>
            <Button variant="solid" tone="accent" onPress={() => void addAlias()}>
              {read(aliasEditName) ? 'Save alias' : 'Add alias'}
            </Button>
          </Stack>
        </AddSection>

        {aliasCount === 0 ? (
          <Text muted size="sm">
            No aliases yet.
          </Text>
        ) : (
          <Stack gap="xs">
            {Object.entries(aliasesMap).map(([name, target]) => (
              <Stack key={name} gap="sm">
                <Box direction="row" align="center" gap="sm" background="muted" radius="md" padding="sm">
                  <Box grow>
                    <Stack gap="xs">
                      <Text size="sm" weight="medium" truncate>
                        {name}
                      </Text>
                      <Text muted size="xs" truncate>
                        → {target}
                      </Text>
                    </Stack>
                  </Box>
                  <Row gap="xs" align="center">
                    <IconButton
                      size="xs"
                      icon="edit"
                      label={`Edit alias ${name}`}
                      tooltip="Edit alias"
                      onPress={() => startEditAlias(name, target)}
                    />
                    <IconButton size="xs" icon="delete" label={`Delete alias ${name}`} onPress={() => set(confirmTarget, `alias:${name}`)} />
                  </Row>
                </Box>
                {read(confirmTarget) === `alias:${name}` ? (
                  <ConfirmDelete
                    confirmLabel="Delete alias"
                    message={`Delete alias ${name} → ${target}?`}
                    onConfirm={() => {
                      set(confirmTarget, '')
                      void removeAlias(name)
                    }}
                    onCancel={() => set(confirmTarget, '')}
                  />
                ) : null}
              </Stack>
            ))}
          </Stack>
        )}
      </Card>
    </Stack>
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
        title="Agent routing"
        open={read(profilesInfoOpen) ?? agents.length === 0}
        onOpenChange={(open) => set(profilesInfoOpen, open)}
      >
        <Text size="sm">
          Orca launches these agents. While the gateway is running, every enabled agent is pointed at it; turn one off
          to let it use its own provider settings.
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
  return (
    <Stack gap="md">
      <Row justify="between" align="start" gap="sm" wrap>
        <Box grow>
          <SectionHeading
            title="Request log"
            description={`${entries.length ? `${entries.length} of the last 100 requests` : 'Every request the gateway handles'}`}
          />
        </Box>
        <Button variant="ghost" icon="delete" disabled={!entries.length} onPress={() => void clearLogs()}>
          Clear
        </Button>
      </Row>

      {entries.length === 0 ? (
        <EmptyState
          title="No requests yet"
          description="Every request the gateway handles shows up here with its provider, model, status, latency and tokens. Launch an agent to see traffic."
          icon="activity"
        />
      ) : (
        <Stack gap="xs">
          {entries
            .slice(-100)
            .reverse()
            .map((entry, index) => (
              <LogRow key={`${entry.at}-${index}`} entry={entry} />
            ))}
        </Stack>
      )}

      <InfoBanner
        title="How requests flow"
        open={read(logsInfoOpen) ?? false}
        onOpenChange={(open) => set(logsInfoOpen, open)}
      >
        <Text size="sm">
          The launch hook sets <Code>ANTHROPIC_BASE_URL</Code> and <Code>OPENAI_BASE_URL</Code> to this gateway. The
          gateway resolves aliases and rules, then calls the provider directly.
        </Text>
      </InfoBanner>
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
        <Button variant="ghost" onPress={() => set(tab, 'providers')}>
          Back to providers
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

function Section() {
  if (!read(loaded)) return <Loading />
  const active = read(tab)
  if (active === 'providers') return <Providers />
  if (active === 'routes') return <Routes />
  if (active === 'profiles') return <Profiles />
  if (active === 'logs') return <Logs />
  if (active === 'import') return <Import />
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
