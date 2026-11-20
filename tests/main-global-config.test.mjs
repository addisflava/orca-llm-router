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
process.env.CODEX_HOME = join(home, 'codex')
process.env.XDG_CONFIG_HOME = join(home, 'xdg')

const { applyGlobalAgentConfig, restoreGlobalAgentConfig } = await import('../worker/main.mjs')
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
