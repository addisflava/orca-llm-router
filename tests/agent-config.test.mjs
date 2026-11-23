// Agents with file-based provider config get the router provider + fresh model
// list written on every config change, and their original files restored on
// opt-out. These tests use isolated HOME/XDG/TMP dirs via dynamic import.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'orca-agent-config-'))
const previous = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  TMPDIR: process.env.TMPDIR
}
process.env.HOME = sandbox
process.env.XDG_CONFIG_HOME = join(sandbox, 'xdg')
process.env.TMPDIR = join(sandbox, 'tmp')
mkdirSync(process.env.TMPDIR, { recursive: true })

const { AGENT_CONFIG_TARGETS, PI_AGENT_DIR, KILO_CONFIG_FILE, restoreAgentConfigs, writeAgentConfigs } = await import('../worker/agent-config.mjs')

test.after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(sandbox, { recursive: true, force: true })
})

test('writes provider + model list into agent config files and restores them', () => {
  const geminiEnv = AGENT_CONFIG_TARGETS.gemini.env
  const geminiSettings = AGENT_CONFIG_TARGETS.gemini.settings
  const aider = AGENT_CONFIG_TARGETS.aider.yaml
  mkdirSync(join(sandbox, '.gemini'), { recursive: true })
  writeFileSync(geminiEnv, 'USER_SETTING=keep\n')
  writeFileSync(geminiSettings, JSON.stringify({ mcp: { servers: {} } }, null, 2))
  writeFileSync(aider, 'auto-commits: true\n')

  const written = writeAgentConfigs(null, {
    base: 'http://127.0.0.1:18080',
    token: 'orca-router',
    modelIds: ['demo/one', 'demo/two']
  })
  assert.ok(written.includes('gemini') && written.includes('aider') && written.includes('continue'))

  const envText = readFileSync(geminiEnv, 'utf8')
  assert.match(envText, /USER_SETTING=keep/)
  assert.match(envText, /GOOGLE_GEMINI_BASE_URL="http:\/\/127\.0\.0\.1:18080"/)
  assert.match(envText, /GEMINI_MODEL="demo\/one"/)
  const settings = JSON.parse(readFileSync(geminiSettings, 'utf8'))
  assert.deepEqual(settings.mcp, { servers: {} })
  assert.equal(settings.env.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:18080')

  const aiderText = readFileSync(aider, 'utf8')
  assert.match(aiderText, /auto-commits: true/)
  assert.match(aiderText, /openai-api-base: http:\/\/127\.0\.0\.1:18080/)
  assert.match(aiderText, /model: openai\/demo\/one/)

  const continueText = readFileSync(AGENT_CONFIG_TARGETS.continue.yaml, 'utf8')
  assert.match(continueText, /name: demo\/two/)
  assert.match(continueText, /apiBase: http:\/\/127\.0\.0\.1:18080\/v1/)

  const kimi = readFileSync(AGENT_CONFIG_TARGETS.kimi.toml, 'utf8')
  assert.match(kimi, /\[providers\.orca-router\]/)
  assert.match(kimi, /base_url = "http:\/\/127\.0\.0\.1:18080\/v1"/)
  assert.match(kimi, /\[models\."demo\/two"\]/)

  const kilo = JSON.parse(readFileSync(AGENT_CONFIG_TARGETS.kilo.json, 'utf8'))
  assert.equal(kilo['openai-compatible'].baseUrl, 'http://127.0.0.1:18080/v1')
  assert.equal(kilo['openai-compatible'].model, 'demo/one')
  const cline = JSON.parse(readFileSync(AGENT_CONFIG_TARGETS.cline.state, 'utf8'))
  assert.equal(cline.openAiBaseUrl, 'http://127.0.0.1:18080')

  const piModels = JSON.parse(readFileSync(join(PI_AGENT_DIR, 'models.json'), 'utf8'))
  assert.deepEqual(piModels.providers['orca-router'].models.map((m) => m.id), ['demo/one', 'demo/two'])
  const piSettings = JSON.parse(readFileSync(join(PI_AGENT_DIR, 'settings.json'), 'utf8'))
  assert.equal(piSettings.defaultProvider, 'orca-router')

  const crush = JSON.parse(readFileSync(AGENT_CONFIG_TARGETS.crush.json, 'utf8'))
  assert.deepEqual(crush.providers['orca-router'].models.map((m) => m.id), ['demo/one', 'demo/two'])
  const droid = JSON.parse(readFileSync(AGENT_CONFIG_TARGETS.droid.json, 'utf8'))
  assert.equal(droid.customModels.length, 2)
  const openclaw = JSON.parse(readFileSync(AGENT_CONFIG_TARGETS.openclaw.json, 'utf8'))
  assert.equal(openclaw.models.providers['orca-router'].models.length, 2)
  assert.equal(openclaw.agents.defaults.model.primary, 'orca-router/demo/one')
  const omp = readFileSync(AGENT_CONFIG_TARGETS.ompModels.yaml, 'utf8')
  assert.match(omp, /type: openai-models-list/)
  const hermes = readFileSync(AGENT_CONFIG_TARGETS.hermes.yaml, 'utf8')
  assert.match(hermes, /name: orca-router/)
  assert.match(hermes, /"demo\/two": \{\}/)
  const jcode = readFileSync(AGENT_CONFIG_TARGETS.jcode.toml, 'utf8')
  assert.match(jcode, /\[providers\.orca-router\]/)

  // CodeBuddy's CustomModelsJSON feature reads a full models.json.
  const codebuddyModels = JSON.parse(readFileSync(AGENT_CONFIG_TARGETS.codebuddy.models, 'utf8'))
  assert.deepEqual(codebuddyModels.availableModels, ['demo/one', 'demo/two'])
  assert.equal(codebuddyModels.models[0].url, 'http://127.0.0.1:18080/v1')
  // Qwen Code's /model picker reads modelProviders.
  const qwen = JSON.parse(readFileSync(AGENT_CONFIG_TARGETS['qwen-code'].settings, 'utf8'))
  assert.deepEqual(qwen.modelProviders.openai.map((model) => model.id), ['demo/one', 'demo/two'])
  assert.equal(qwen.security.auth.selectedType, 'openai')
  assert.equal(qwen.model.name, 'demo/one')
  // Kilo's OpenCode-style provider block carries the full model list.
  const kiloGenerated = JSON.parse(readFileSync(KILO_CONFIG_FILE, 'utf8'))
  assert.deepEqual(Object.keys(kiloGenerated.provider['orca-router'].models), ['demo/one', 'demo/two'])
  const kiloUser = JSON.parse(readFileSync(AGENT_CONFIG_TARGETS.kiloConfig.json, 'utf8'))
  assert.ok(kiloUser.provider['orca-router'])

  restoreAgentConfigs()
  assert.equal(readFileSync(geminiEnv, 'utf8'), 'USER_SETTING=keep\n')
  assert.deepEqual(JSON.parse(readFileSync(geminiSettings, 'utf8')), { mcp: { servers: {} } })
  assert.equal(readFileSync(aider, 'utf8'), 'auto-commits: true\n')
  assert.equal(existsSync(AGENT_CONFIG_TARGETS.continue.yaml), false)
})

test('a changed model list refreshes the published config in place', () => {
  const aider = AGENT_CONFIG_TARGETS.aider.yaml
  writeAgentConfigs(null, { base: 'http://127.0.0.1:18080', token: 't', modelIds: ['demo/old'] })
  assert.match(readFileSync(aider, 'utf8'), /model: openai\/demo\/old/)
  writeAgentConfigs(null, { base: 'http://127.0.0.1:18080', token: 't', modelIds: ['demo/new'] })
  const text = readFileSync(aider, 'utf8')
  assert.doesNotMatch(text, /demo\/old/)
  assert.match(text, /model: openai\/demo\/new/)
  restoreAgentConfigs()
})
