// Native, dependency-free injection of the router provider into agents that
// build their model picker from their own config file. Mirrors what CCR and
// OmniRoute do with per-agent setup commands. Only URLs, model ids and the local
// gateway token are written — never a provider secret. Every write is atomic and
// backed up so disabling the agent restores the user's original file.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const BEGIN = '# BEGIN Orca LLM Router agent provider'
const END = '# END Orca LLM Router agent provider'
const BACKUP_DIR = join(tmpdir(), 'orca-llm-router', 'agent-config-backups')

const home = (...parts) => join(process.env.HOME || homedir(), ...parts)
const xdgConfig = (name) => join(process.env.XDG_CONFIG_HOME || home('.config'), name)

export const AGENT_CONFIG_TARGETS = {
  codebuddy: {
    settings: home('.codebuddy', 'settings.json'),
    models: home('.codebuddy', 'models.json')
  },
  gemini: { env: home('.gemini', '.env'), settings: home('.gemini', 'settings.json') },
  'qwen-code': { env: home('.qwen', '.env'), settings: home('.qwen', 'settings.json') },
  aider: { yaml: home('.aider.conf.yml') },
  goose: { yaml: xdgConfig('goose', 'config.yaml') },
  continue: { yaml: home('.continue', 'config.yaml') },
  kimi: { toml: home('.kimi', 'config.toml') },
  jcode: { toml: home('.jcode', 'config.toml') },
  crush: { json: xdgConfig('crush', 'crush.json') },
  droid: { json: home('.factory', 'settings.json') },
  openclaw: { json: home('.openclaw', 'openclaw.json') },
  ompModels: { yaml: home('.omp', 'agent', 'models.yml') },
  ompConfig: { yaml: home('.omp', 'agent', 'config.yml') },
  hermes: { yaml: home('.hermes', 'config.yaml'), env: home('.hermes', '.env') },
  kilo: { json: home('.local', 'share', 'kilo', 'auth.json') },
  kiloConfig: { json: xdgConfig('kilo', 'kilo.jsonc') },
  cline: { state: home('.cline', 'data', 'globalState.json'), secrets: home('.cline', 'data', 'secrets.json') }
}

// Pi reads its provider/model catalog from a "coding agent dir". CCR uses the
// same trick: write models.json there and point PI_CODING_AGENT_DIR at it at
// launch, so every router model appears in `pi --list-models` and /model picker.
export const PI_AGENT_DIR = join(tmpdir(), 'orca-llm-router', 'pi-agent')
export const PI_SESSION_DIR = join(PI_AGENT_DIR, 'sessions')

// Kilo is an OpenCode fork and honours KILO_CONFIG like OpenCode honours
// OPENCODE_CONFIG, so the full provider list can live in a generated file
// instead of the user's ~/.config/kilo/kilo.jsonc.
export const KILO_CONFIG_FILE = join(tmpdir(), 'orca-llm-router', 'kilo.json')

// Some agents leave a directory where we expect a config file (or a symlink to
// one). Never try to read/write through it — skip that agent instead of
// aborting the whole publish.
function isFile(path) {
  try { return existsSync(path) && statSync(path).isFile() } catch { return false }
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text)
  renameSync(temporary, path)
}

const MANIFEST = join(BACKUP_DIR, 'created.json')

function backupPath(path) {
  return join(BACKUP_DIR, Buffer.from(path, 'utf8').toString('hex'))
}

function readManifest() {
  try { return JSON.parse(readFileSync(MANIFEST, 'utf8')) } catch { return [] }
}

function remember(path) {
  mkdirSync(BACKUP_DIR, { recursive: true })
  const backup = backupPath(path)
  if (!existsSync(backup) && existsSync(path)) writeFileSync(backup, readFileSync(path))
  if (!existsSync(path)) {
    const created = readManifest()
    if (!created.includes(path)) writeFileSync(MANIFEST, JSON.stringify([...created, path]))
  }
}

function stripManaged(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let inside = false
  for (const line of lines) {
    if (line.trim() === BEGIN) { inside = true; continue }
    if (line.trim() === END) { inside = false; continue }
    if (!inside) out.push(line)
  }
  return out.join('\n').replace(/\n+$/, '')
}

function managed(lines) {
  return ['', BEGIN, ...lines, END, ''].join('\n')
}

function applyEnvFile(path, assignments) {
  if (existsSync(path) && !isFile(path)) return
  const original = isFile(path) ? readFileSync(path, 'utf8') : ''
  const next = `${stripManaged(original)}${managed(assignments.map(([key, value]) => `${key}=${JSON.stringify(String(value))}`))}\n`
  if (next !== original) { remember(path); atomicWrite(path, next) }
}

function applyYaml(path, lines) {
  if (existsSync(path) && !isFile(path)) return
  const original = isFile(path) ? readFileSync(path, 'utf8') : ''
  const next = `${stripManaged(original)}${managed(lines)}\n`
  if (next !== original) { remember(path); atomicWrite(path, next) }
}

function applyJsonEnv(path, assignments) {
  if (existsSync(path) && !isFile(path)) return
  let existing = {}
  if (isFile(path)) {
    try { existing = JSON.parse(readFileSync(path, 'utf8')) } catch { return }
  }
  const env = { ...(existing.env && typeof existing.env === 'object' ? existing.env : {}) }
  for (const [key, value] of assignments) env[key] = String(value)
  const next = `${JSON.stringify({ ...existing, env }, null, 2)}\n`
  const original = isFile(path) ? readFileSync(path, 'utf8') : ''
  if (next !== original) { remember(path); atomicWrite(path, next) }
}

function applyJson(path, change) {
  if (existsSync(path) && !isFile(path)) return
  let existing = {}
  if (isFile(path)) {
    try { existing = JSON.parse(readFileSync(path, 'utf8')) } catch { return }
  }
  const original = isFile(path) ? readFileSync(path, 'utf8') : ''
  const next = `${JSON.stringify(change(existing), null, 2)}\n`
  if (next !== original) { remember(path); atomicWrite(path, next) }
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Publish the gateway to agents that read their provider from a config file.
 * `modelIds` are real router ids from /v1/models; the list is refreshed on every
 * config change so adding/removing models in the Providers tab propagates here.
 */
export function writeAgentConfigs(config, { base, token, modelIds = [] } = {}) {
  const root = String(base).replace(/\/+$/, '')
  const v1 = `${root}/v1`
  const first = modelIds[0] ?? ''
  const targets = AGENT_CONFIG_TARGETS
  const written = []

  // CodeBuddy is a Claude Code fork with its own env keys in settings.json.
  applyJsonEnv(targets.codebuddy.settings, [
    ['CODEBUDDY_BASE_URL', root],
    ['CODEBUDDY_API_KEY', token],
    ...(first ? [['CODEBUDDY_MODEL', first]] : [])
  ])
  // Its product config enables the CustomModelsJSON feature, so a models.json
  // adds every router model to the picker (url is the /v1 base, like CCR's
  // WorkBuddy writer).
  applyJson(targets.codebuddy.models, () => ({
    models: modelIds.map((id) => ({
      id,
      name: id,
      url: v1,
      apiKey: token,
      vendor: 'openai',
      supportsImages: true,
      maxInputTokens: 128000,
      tags: ['chat', 'custom']
    })),
    availableModels: modelIds
  }))
  written.push('codebuddy')

  // Gemini CLI and Qwen Code read an OpenAI-compatible provider from their
  // .env plus a settings.json env block (OmniRoute's setup-gemini / setup-qwen).
  for (const agent of ['gemini', 'qwen-code']) {
    const target = targets[agent]
    const assignments = agent === 'gemini'
      ? [
          ['GOOGLE_GEMINI_BASE_URL', root],
          ['GEMINI_DEFAULT_AUTH_TYPE', 'openai'],
          ['GEMINI_API_KEY', token],
          ...(first ? [['GEMINI_MODEL', first]] : [])
        ]
      : [
          ['OPENAI_BASE_URL', v1],
          ['OPENAI_API_KEY', token],
          ...(first ? [['OPENAI_MODEL', first]] : [])
        ]
    applyEnvFile(target.env, assignments)
    applyJsonEnv(target.settings, assignments)
    written.push(agent)
  }

  // Qwen Code's `modelProviders` setting is what its /model picker reads, so
  // publish the whole router catalog there. Keep any provider entries the user
  // already pointed somewhere else; only replace ones aimed at our gateway.
  applyJson(targets['qwen-code'].settings, (existing) => {
    const providers = { ...(existing.modelProviders ?? {}) }
    const prior = Array.isArray(providers.openai) ? providers.openai : []
    const kept = prior.filter((model) => model?.baseUrl !== v1)
    const security = { ...(existing.security ?? {}) }
    return {
      ...existing,
      modelProviders: {
        ...providers,
        openai: [
          ...modelIds.map((id) => ({ id, name: id, baseUrl: v1, envKey: 'OPENAI_API_KEY' })),
          ...kept
        ]
      },
      security: { ...security, auth: { ...(security.auth ?? {}), selectedType: 'openai' } },
      ...(first ? {
        model: {
          ...(existing.model && typeof existing.model === 'object' ? existing.model : {}),
          name: first
        }
      } : {})
    }
  })

  // Aider (LiteLLM) and Goose take a ROOT url — they append /v1 themselves.
  applyYaml(targets.aider.yaml, [
    `openai-api-base: ${root}`,
    `openai-api-key: ${token}`,
    ...(first ? [`model: openai/${first}`] : [])
  ])
  applyYaml(targets.goose.yaml, [
    `OPENAI_HOST: ${root}`,
    `OPENAI_API_KEY: ${token}`,
    ...(first ? ['GOOSE_DEFAULT_MODEL: openai/' + first] : [])
  ])
  written.push('aider', 'goose')

  // Continue has a real model list, so its picker can show the whole catalog.
  const models = modelIds.map((id) => [
    `  - name: ${id}`,
    '    provider: openai',
    `    model: ${id}`,
    `    apiBase: ${v1}`,
    `    apiKey: ${token}`
  ].join('\n')).join('\n')
  applyYaml(targets.continue.yaml, [
    'models:',
    ...(models ? [models] : ['  []'])
  ])
  written.push('continue')

  // Kimi keeps a full model map in config.toml (schema verified from kimi_cli).
  const kimiLines = [
    '[providers.orca-router]',
    'type = "openai_responses"',
    `base_url = ${tomlString(v1)}`,
    `api_key = ${tomlString(token)}`,
    ...modelIds.flatMap((id) => [
      '',
      `[models.${tomlString(id)}]`,
      'provider = "orca-router"',
      `model = ${tomlString(id)}`,
      'max_context_size = 128000',
      `display_name = ${tomlString(id)}`
    ])
  ]
  applyYaml(targets.kimi.toml, kimiLines)
  written.push('kimi')

  // Kilo CLI and Cline CLI keep an OpenAI-compatible provider in JSON configs.
  applyJson(targets.kilo.json, (existing) => ({
    ...existing,
    'openai-compatible': {
      ...(existing['openai-compatible'] ?? {}),
      apiKey: token,
      baseUrl: v1,
      ...(first ? { model: first } : {})
    }
  }))
  // Kilo's config schema has a real provider block with a model map (the same
  // shape OpenCode uses). Write it to a generated file for launches and to the
  // user config for structured sessions.
  const kiloProvider = {
    npm: '@ai-sdk/openai-compatible',
    package: '@ai-sdk/openai-compatible',
    name: 'Orca LLM Router',
    options: { baseURL: v1, apiKey: token },
    models: Object.fromEntries(modelIds.map((id) => [id, { name: id }]))
  }
  remember(KILO_CONFIG_FILE)
  atomicWrite(KILO_CONFIG_FILE, `${JSON.stringify({ provider: { 'orca-router': kiloProvider } }, null, 2)}\n`)
  applyJson(targets.kiloConfig.json, (existing) => ({
    ...existing,
    provider: { ...(existing.provider ?? {}), 'orca-router': kiloProvider }
  }))
  applyJson(targets.cline.state, (existing) => ({
    ...existing,
    actModeApiProvider: 'openai',
    planModeApiProvider: 'openai',
    openAiBaseUrl: root,
    ...(first ? { openAiModelId: first, planModeOpenAiModelId: first } : {})
  }))
  applyJson(targets.cline.secrets, (existing) => ({ ...existing, openAiApiKey: token }))
  written.push('kilo', 'cline')

  // Pi: a coding-agent dir with providers/models.json, exactly CCR's approach.
  const piModels = { providers: { 'orca-router': {
    api: 'openai-responses',
    apiKey: token,
    authHeader: true,
    baseUrl: v1,
    models: modelIds.map((id) => ({ id, name: id }))
  } } }
  remember(join(PI_AGENT_DIR, 'models.json'))
  remember(join(PI_AGENT_DIR, 'settings.json'))
  remember(join(PI_AGENT_DIR, 'auth.json'))
  atomicWrite(join(PI_AGENT_DIR, 'models.json'), `${JSON.stringify(piModels, null, 2)}\n`)
  const originalSettings = home('.pi', 'agent', 'settings.json')
  let piSettings = {}
  if (existsSync(originalSettings)) {
    try { piSettings = JSON.parse(readFileSync(originalSettings, 'utf8')) } catch { /* ignore */ }
  }
  // Keep the user's look-and-feel prefs but not their package list: Pi would
  // otherwise re-download every package into our throwaway agent dir.
  const { packages: _packages, ...piPrefs } = piSettings
  atomicWrite(join(PI_AGENT_DIR, 'settings.json'), `${JSON.stringify({
    ...piPrefs,
    defaultProvider: 'orca-router',
    ...(first ? { defaultModel: `orca-router/${first}` } : {})
  }, null, 2)}\n`)
  atomicWrite(join(PI_AGENT_DIR, 'auth.json'), '{}\n')
  mkdirSync(PI_SESSION_DIR, { recursive: true })
  written.push('pi')

  // The rest are OmniRoute's config-writer agents, adapted to our provider id.
  // Crush enumerates every advertised model from /v1/models.
  applyJson(targets.crush.json, (existing) => ({
    ...existing,
    providers: {
      ...(existing.providers ?? {}),
      'orca-router': {
        type: 'openai-compat',
        base_url: v1,
        api_key: '$LLM_ROUTER_API_KEY',
        models: modelIds.map((id) => ({ id, name: id }))
      }
    }
  }))
  // Droid CLI reads a customModels array and shows all of them in its picker.
  applyJson(targets.droid.json, (existing) => ({
    ...existing,
    customModels: modelIds.map((id, index) => ({
      model: id,
      id: `custom:orca-router-${index}`,
      index,
      baseUrl: v1,
      apiKey: token,
      displayName: id,
      provider: 'openai'
    }))
  }))
  // OpenClaw's provider map carries the model list; pin the first as default.
  applyJson(targets.openclaw.json, (existing) => {
    const next = {
      ...existing,
      models: {
        ...(existing.models ?? {}),
        providers: {
          ...(existing.models?.providers ?? {}),
          'orca-router': {
            baseUrl: v1,
            apiKey: token,
            api: 'openai-completions',
            models: modelIds.map((id) => ({ id, name: id.split('/').pop() || id }))
          }
        }
      }
    }
    if (first) {
      next.agents = {
        ...(existing.agents ?? {}),
        defaults: { ...(existing.agents?.defaults ?? {}), model: { primary: `orca-router/${first}` } }
      }
    }
    return next
  })
  // OMP discovers models itself with `openai-models-list`, so its picker always
  // reflects the gateway's current /v1/models.
  applyYaml(targets.ompModels.yaml, [
    'providers:',
    '  orca-router:',
    `    baseUrl: ${v1}`,
    `    apiKey: ${token}`,
    '    api: openai-completions',
    '    authHeader: true',
    '    discovery:',
    '      type: openai-models-list',
    '      injectV1: false'
  ])
  if (first) {
    applyYaml(targets.ompConfig.yaml, [
      'modelRoles:',
      `  default: orca-router/${first}`
    ])
  }
  // Hermes reads custom_providers with a model map plus per-role pins.
  applyYaml(targets.hermes.yaml, [
    'custom_providers:',
    '  - name: orca-router',
    `    base_url: ${v1}`,
    '    key_env: LLM_ROUTER_API_KEY',
    '    models:',
    ...(modelIds.length ? modelIds.map((id) => `      ${JSON.stringify(id)}: {}`) : ['      {}']),
    ...(first ? [
      'model:',
      '  default: ' + first,
      '  provider: orca-router'
    ] : [])
  ])
  applyEnvFile(targets.hermes.env, [['LLM_ROUTER_API_KEY', token]])
  // jcode keeps a single pinned provider profile in TOML.
  applyYaml(targets.jcode.toml, [
    '[providers.orca-router]',
    'type = "openai-compatible"',
    `base_url = ${tomlString(v1)}`,
    `api_key = ${tomlString(token)}`,
    ...(first ? [`default_model = ${tomlString(first)}`] : []),
    'requires_api_key = false'
  ])
  written.push('crush', 'droid', 'openclaw', 'omp', 'hermes', 'jcode')

  return written
}

/** Env additions and command pin needed to launch Pi against the gateway. */
export function piLaunchInfo(modelIds = []) {
  return {
    env: {
      PI_CODING_AGENT_DIR: PI_AGENT_DIR,
      PI_CODING_AGENT_SESSION_DIR: PI_SESSION_DIR
    },
    provider: 'orca-router',
    model: modelIds[0] ?? ''
  }
}

/** Restore every file we touched. Safe to call repeatedly. */
export function restoreAgentConfigs() {
  if (!existsSync(BACKUP_DIR)) return []
  const restored = []
  for (const path of readManifest()) {
    rmSync(path, { force: true })
    restored.push(path)
  }
  rmSync(MANIFEST, { force: true })
  for (const backup of readdirSafe(BACKUP_DIR)) {
    const path = Buffer.from(backup, 'hex').toString('utf8')
    const source = join(BACKUP_DIR, backup)
    if (existsSync(source)) {
      atomicWrite(path, readFileSync(source, 'utf8'))
      restored.push(path)
    }
    rmSync(source, { force: true })
  }
  return restored
}

function readdirSafe(path) {
  try { return readdirSync(path) } catch { return [] }
}
