// Every agent Orca can launch must receive the gateway endpoint and a usable
// router model through buildAgentLaunchEnv before the launch hook adds its
// agent-specific command overrides (Codex -c, OpenCode config, Claude settings).
import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_CONFIG, buildAgentLaunchEnv, normalizeConfig } from '../worker/sidecar.mjs'
import { ORCA_AGENTS } from '../worker/orca-agents.mjs'

const BASE = 'http://127.0.0.1:18080'
const TOKEN = 'orca-router'
const MODEL = 'pgs/deepseek-v4.1-flash'

function configFor(agent, enabled) {
  return normalizeConfig({
    version: 3,
    ...structuredClone(DEFAULT_CONFIG),
    providers: [{ name: 'pgs', baseUrl: 'https://example.com', models: [{ id: 'deepseek-v4.1-flash' }], keys: [] }],
    agentProfiles: [{ agent, name: agent, model: MODEL, enabled, scope: 'system-default', env: {} }]
  })
}

test('Orca agent registry covers every launchable agent with unique ids', () => {
  const ids = ORCA_AGENTS.map((agent) => agent.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.includes('claude'))
  assert.ok(ids.includes('codex'))
  assert.ok(ids.includes('opencode'))
  assert.ok(ids.includes('opencode2'))
  assert.ok(ids.includes('pi'))
  assert.ok(ids.includes('gemini'))
  assert.ok(ids.includes('kimi'))
  assert.ok(ids.includes('qwen-code'))
})

test('every enabled agent is pointed at the gateway with its profile model', () => {
  for (const { id } of ORCA_AGENTS) {
    const { routed, scope, model, profile, env } = buildAgentLaunchEnv(configFor(id, true), id, {
      base: BASE,
      token: TOKEN
    })
    assert.equal(routed, true, `${id}: agent should be routed`)
    assert.equal(scope, 'system-default', `${id}: profile scope`)
    assert.equal(profile.agent, id, `${id}: resolved its own profile`)
    assert.equal(model, MODEL, `${id}: profile model`)
    // Anthropic-compatible clients.
    assert.equal(env.ANTHROPIC_BASE_URL, BASE, `${id}: anthropic base url`)
    assert.equal(env.ANTHROPIC_API_BASE_URL, BASE, `${id}: anthropic api base url`)
    assert.equal(env.CLAUDE_AGENT_API_BASE_URL, BASE, `${id}: claude agent base url`)
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, TOKEN, `${id}: anthropic auth token`)
    // OpenAI-compatible clients.
    assert.equal(env.OPENAI_BASE_URL, `${BASE}/v1`, `${id}: openai base url`)
    assert.equal(env.OPENAI_API_KEY, TOKEN, `${id}: openai api key`)
    assert.equal(env.OPENAI_MODEL, MODEL, `${id}: openai model`)
    assert.equal(env.MODEL, MODEL, `${id}: generic model`)
    // Claude Code must not see a custom API key (approval prompt).
    const claudeFamily = /claude/i.test(id)
    assert.equal(env.ANTHROPIC_API_KEY, claudeFamily ? '' : TOKEN, `${id}: anthropic api key`)
    // Loopback must bypass a proxy for the local gateway.
    assert.match(env.NO_PROXY, /127\.0\.0\.1/, `${id}: NO_PROXY`)
    assert.equal(env.no_proxy, env.NO_PROXY, `${id}: lowercase no_proxy`)
    assert.equal(env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT, '1', `${id}: unknown model allowed`)
  }
})

test('every agent toggle can opt out without inheriting gateway env', () => {
  for (const { id } of ORCA_AGENTS) {
    const original = { PATH: '/usr/bin', CUSTOM_FLAG: 'keep' }
    const { routed, env } = buildAgentLaunchEnv(configFor(id, false), id, {
      base: BASE,
      token: TOKEN,
      eventEnv: original
    })
    assert.equal(routed, false, `${id}: opt-out should skip the agent`)
    assert.equal(env.ANTHROPIC_BASE_URL, undefined, `${id}: no gateway base url`)
    assert.equal(env.OPENAI_BASE_URL, undefined, `${id}: no openai base url`)
    assert.equal(env.OPENAI_API_KEY, undefined, `${id}: no openai key`)
    assert.equal(env.CUSTOM_FLAG, 'keep', `${id}: original env preserved`)
  }
})

test('Grok gets a model-list URL for its picker and CodeBuddy gets its own base URL', () => {
  const config = normalizeConfig(structuredClone(DEFAULT_CONFIG))
  const grok = buildAgentLaunchEnv(config, 'grok', {
    base: BASE,
    token: TOKEN,
    eventEnv: {}
  }).env
  assert.equal(grok.GROK_MODELS_LIST_URL, `${BASE}/v1/models`)
  assert.equal(grok.GROK_MODELS_BASE_URL, `${BASE}/v1`)
  assert.equal(grok.XAI_API_KEY, TOKEN)

  const codebuddy = buildAgentLaunchEnv(config, 'codebuddy', {
    base: BASE,
    token: TOKEN,
    eventEnv: {}
  }).env
  assert.equal(codebuddy.CODEBUDDY_BASE_URL, BASE)
  assert.equal(codebuddy.CODEBUDDY_API_KEY, TOKEN)
  assert.equal(codebuddy.LLM_ROUTER_API_KEY, TOKEN)
})

test('launch env never uses an env name Orca reserves for itself', () => {
  const config = normalizeConfig(structuredClone(DEFAULT_CONFIG))
  for (const { id } of ORCA_AGENTS) {
    const { env } = buildAgentLaunchEnv(config, id, { base: BASE, token: TOKEN, eventEnv: {} })
    for (const key of Object.keys(env)) {
      // Orca's agent.launch.before schema rejects the entire env change when
      // one key starts with ORCA_, which silently unroutes every agent.
      assert.ok(!key.toUpperCase().startsWith('ORCA_'), `${id}: ${key} uses Orca's reserved prefix`)
      assert.match(key, /^[A-Za-z_][A-Za-z0-9_]*$/, `${id}: ${key} is not a valid env name`)
    }
  }
})

test('agents with no explicit toggle entry still route by default', () => {
  const config = normalizeConfig({ version: 3, ...structuredClone(DEFAULT_CONFIG), agentProfiles: [] })
  for (const { id } of ORCA_AGENTS) {
    const { routed, env } = buildAgentLaunchEnv(config, id, { base: BASE, token: TOKEN })
    assert.equal(routed, true, `${id}: default opt-in`)
    assert.equal(env.OPENAI_BASE_URL, `${BASE}/v1`, `${id}: default gateway`)
  }
})
