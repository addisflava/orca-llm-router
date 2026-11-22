// The global Codex/OpenCode writes are opt-in. These tests use their own
// process so the worker's module-level config paths point at temp dirs.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'orca-global-config-'))
const previousCodexHome = process.env.CODEX_HOME
const previousXdgHome = process.env.XDG_CONFIG_HOME
const previousTmp = process.env.TMPDIR
process.env.CODEX_HOME = join(home, 'codex')
process.env.XDG_CONFIG_HOME = join(home, 'xdg')
// worker/main.mjs derives OPENCODE_CONFIG_DIR from os.tmpdir() at import time.
// Redirect TMPDIR too, or these tests clobber the real per-launch catalogs.
process.env.TMPDIR = join(home, 'tmp')
mkdirSync(process.env.TMPDIR, { recursive: true })

const { applyGlobalAgentConfig, restoreGlobalAgentConfig, openCodeProfileRouted, codexProfileRouted } = await import('../worker/main.mjs')
const { DEFAULT_CONFIG, normalizeConfig } = await import('../worker/sidecar.mjs')

const codexFile = join(process.env.CODEX_HOME, 'config.toml')
const opencodeDir = join(process.env.XDG_CONFIG_HOME, 'opencode')
const opencodeFile = join(opencodeDir, 'opencode.jsonc')
const config = normalizeConfig({
  ...structuredClone(DEFAULT_CONFIG),
  providers: [{ name: 'demo', baseUrl: 'https://api.example.com', models: ['demo/model'], keys: [] }],
  defaultModel: 'demo/model'
})

function storageHarness() {
  const store = new Map()
  return {
    store,
    orca: {
      storage: {
        get: async (key) => store.get(key) ?? null,
        set: async (key, value) => { store.set(key, value) },
        delete: async (key) => { store.delete(key) }
      }
    }
  }
}

test.after(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousCodexHome
  if (previousXdgHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousXdgHome
  if (previousTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmp
  rmSync(home, { recursive: true, force: true })
})

test('global routing outside Orca is opt-in and the directory name is compliant', () => {
  const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  const setting = manifest.contributes.settings.find((item) => item.key === 'routeOutsideOrca')
  assert.ok(setting)
  assert.equal(setting.default, false)
  assert.match(setting.title, /outside Orca/)
  // The directory rejects names that start with "Orca"; the id may stay.
  assert.equal(manifest.name.startsWith('Orca'), false)
  assert.equal(manifest.id, 'llm-router')
})

test('applyGlobalAgentConfig publishes both global configs and restore undoes both', async () => {
  mkdirSync(process.env.CODEX_HOME, { recursive: true })
  mkdirSync(opencodeDir, { recursive: true })
  const original = {
    $schema: 'https://opencode.ai/config.json',
    mcp: { servers: { docs: { type: 'remote', url: 'https://example.com/mcp' } } },
    provider: {}
  }
  writeFileSync(opencodeFile, `${JSON.stringify(original, null, 2)}\n`)
  const originalCodex = 'model = "gpt-5.5"\n\n[projects."/tmp/x"]\ntrust_level = "trusted"\n'
  writeFileSync(codexFile, originalCodex)

  const { orca, store } = storageHarness()
  assert.equal(await applyGlobalAgentConfig(orca, config), true)
  assert.match(readFileSync(codexFile, 'utf8'), /# BEGIN Orca LLM Router managed profile/)
  assert.match(readFileSync(codexFile, 'utf8'), /\[model_providers\.orca-router\]/)
  const written = JSON.parse(readFileSync(opencodeFile, 'utf8'))
  assert.ok(written.provider['orca-router'])
  assert.ok(written.providers['orca-router'])
  assert.equal(written.providers['orca-router'].settings.baseURL, 'http://127.0.0.1:18080/v1')
  assert.deepEqual(written.mcp, original.mcp)
  assert.ok(store.has('router.codexConfigBackup'))

  await restoreGlobalAgentConfig(orca)
  assert.doesNotMatch(readFileSync(codexFile, 'utf8'), /orca-router/)
  assert.match(readFileSync(codexFile, 'utf8'), /^model = "gpt-5\.5"$/m)
  assert.deepEqual(JSON.parse(readFileSync(opencodeFile, 'utf8')), original)
  assert.equal(existsSync(`${opencodeFile}.orca-backup`), false)
  assert.equal(store.has('router.codexConfigBackup'), false)
})

test('restoreGlobalAgentConfig is a no-op when nothing was installed', async () => {
  const { orca } = storageHarness()
  writeFileSync(codexFile, 'model = "gpt-5.5"\n')
  const before = readFileSync(codexFile, 'utf8')
  await restoreGlobalAgentConfig(orca)
  assert.equal(readFileSync(codexFile, 'utf8'), before)
})

test('the OpenCode Agents tab toggle opts in without the outside-Orca setting', () => {
  const enabled = normalizeConfig({
    ...structuredClone(config),
    agentProfiles: [{ agent: 'opencode', enabled: true, name: 'opencode' }]
  })
  const disabled = normalizeConfig({
    ...structuredClone(config),
    agentProfiles: [{ agent: 'opencode', enabled: false, name: 'opencode' }]
  })
  assert.equal(openCodeProfileRouted(enabled), true)
  assert.equal(openCodeProfileRouted(disabled), false)
})

test('the Codex Agents tab toggle also opts in to the global catalog', () => {
  const enabled = normalizeConfig({
    ...structuredClone(config),
    agentProfiles: [{ agent: 'codex', enabled: true, name: 'Codex' }]
  })
  const disabled = normalizeConfig({
    ...structuredClone(config),
    agentProfiles: [{ agent: 'codex', enabled: false, name: 'Codex' }]
  })
  assert.equal(codexProfileRouted(enabled), true)
  assert.equal(codexProfileRouted(disabled), false)
})

test('apply/restore can target OpenCode alone and leave Codex untouched', async () => {
  mkdirSync(process.env.CODEX_HOME, { recursive: true })
  mkdirSync(opencodeDir, { recursive: true })
  const originalCodex = 'model = "gpt-5.5"\n'
  writeFileSync(codexFile, originalCodex)
  writeFileSync(opencodeFile, `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: {} }, null, 2)}\n`)

  const { orca } = storageHarness()
  assert.equal(await applyGlobalAgentConfig(orca, config, { codex: false, opencode: true }), true)
  assert.equal(readFileSync(codexFile, 'utf8'), originalCodex)
  assert.ok(JSON.parse(readFileSync(opencodeFile, 'utf8')).provider['orca-router'])

  await restoreGlobalAgentConfig(orca, { codex: false, opencode: true })
  assert.equal(JSON.parse(readFileSync(opencodeFile, 'utf8')).provider['orca-router'], undefined)
  assert.equal(readFileSync(codexFile, 'utf8'), originalCodex)
})

// The Agents tab publishes the router's whole model list to Codex's catalog and
// OpenCode's provider config. Saving a provider's model list in the Providers
// tab re-applies both, so adding or removing a model immediately shows up in
// the agents' pickers instead of waiting for the next launch.
test('re-applying after a provider model change refreshes both agent catalogs', async () => {
  mkdirSync(process.env.CODEX_HOME, { recursive: true })
  mkdirSync(opencodeDir, { recursive: true })
  writeFileSync(codexFile, '')
  writeFileSync(opencodeFile, `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: {} }, null, 2)}\n`)

  const catalogPath = join(process.env.TMPDIR, 'orca-llm-router', 'codex-models.json')
  const configWith = (ids) => normalizeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    providers: [{ name: 'demo', baseUrl: 'https://api.example.com', models: ids.map((id) => ({ id })), keys: [] }]
  })
  const { orca } = storageHarness()

  await applyGlobalAgentConfig(orca, configWith(['one']))
  assert.deepEqual(JSON.parse(readFileSync(catalogPath, 'utf8')).models.map((item) => item.slug), ['demo/one'])
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(opencodeFile, 'utf8')).provider['orca-router'].models), ['demo/one'])

  await applyGlobalAgentConfig(orca, configWith(['one', 'two']))
  assert.deepEqual(JSON.parse(readFileSync(catalogPath, 'utf8')).models.map((item) => item.slug), ['demo/one', 'demo/two'])
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(opencodeFile, 'utf8')).provider['orca-router'].models), ['demo/one', 'demo/two'])

  await applyGlobalAgentConfig(orca, configWith(['two']))
  assert.deepEqual(JSON.parse(readFileSync(catalogPath, 'utf8')).models.map((item) => item.slug), ['demo/two'])
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(opencodeFile, 'utf8')).provider['orca-router'].models), ['demo/two'])
})

test('enabling OpenCode publish creates its global config when none exists yet', async () => {
  rmSync(opencodeDir, { recursive: true, force: true })
  const { orca } = storageHarness()
  const fresh = normalizeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    providers: [{ name: 'demo', baseUrl: 'https://api.example.com', models: [{ id: 'model' }], keys: [] }]
  })
  assert.equal(await applyGlobalAgentConfig(orca, fresh, { codex: false, opencode: true }), true)
  const written = JSON.parse(readFileSync(opencodeFile, 'utf8'))
  assert.deepEqual(Object.keys(written.provider['orca-router'].models), ['demo/model'])
  await restoreGlobalAgentConfig(orca, { codex: false, opencode: true })
  assert.equal(existsSync(opencodeFile), false)
})
