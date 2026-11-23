// Claude Code only lists gateway models whose ids look like Claude models. The
// gateway advertises every router model under a synthetic Claude-compatible id
// and decodes it back before routing, so the picker shows the whole catalog.
import assert from 'node:assert/strict'
import test from 'node:test'
import { claudeGatewayModels, decodeSyntheticModelId, syntheticModelId } from '../worker/agent-catalog.mjs'
import { buildAgentLaunchEnv, createSidecar, DEFAULT_CONFIG, normalizeConfig } from '../worker/sidecar.mjs'

test('synthetic ids round-trip to the real router model', () => {
  for (const real of ['tokenharbor/mimo-v2.5:free', 'google-gemini/gemini-4-hydrogen', 'coding']) {
    const id = syntheticModelId(real)
    assert.match(id, /^anthropic\/claude-orca-h[0-9a-f]+$/)
    assert.match(id, /claude/)
    assert.equal(decodeSyntheticModelId(id), real)
  }
})

test('unknown and malformed ids pass through unchanged', () => {
  assert.equal(decodeSyntheticModelId('openai/gpt-4o'), 'openai/gpt-4o')
  assert.equal(decodeSyntheticModelId('anthropic/claude-orca-habc'), 'anthropic/claude-orca-habc')
  assert.equal(decodeSyntheticModelId(undefined), undefined)
})

test('Claude gateway catalog advertises every model with the real id as display name', () => {
  const catalog = {
    object: 'list',
    data: [
      { id: 'tokenharbor/mimo-v2.5:free', object: 'model', description: 'fast' },
      { id: 'google-gemini/gemini-4-hydrogen', object: 'model' }
    ]
  }
  const published = claudeGatewayModels(catalog)
  assert.equal(published.data.length, 2)
  for (let i = 0; i < published.data.length; i += 1) {
    assert.equal(decodeSyntheticModelId(published.data[i].id), catalog.data[i].id)
    assert.equal(published.data[i].display_name, catalog.data[i].id)
    assert.match(published.data[i].id, /claude/)
  }
})

test('Claude-family launch env enables gateway model discovery', () => {
  const config = normalizeConfig(structuredClone(DEFAULT_CONFIG))
  for (const agent of ['claude', 'claude-agent-teams', 'openclaude']) {
    const { env } = buildAgentLaunchEnv(config, agent, { base: 'http://127.0.0.1:18080', token: 'orca-router' })
    assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1', agent)
  }
  const { env: codex } = buildAgentLaunchEnv(config, 'codex', { base: 'http://127.0.0.1:18080', token: 'orca-router' })
  assert.equal(codex.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, undefined)
})

test('gateway serves synthetic ids only to Anthropic discovery clients', async () => {
  const config = normalizeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    providers: [{ name: 'demo', baseUrl: 'https://example.com', models: [{ id: 'mimo' }], keys: [] }]
  })
  const sidecar = createSidecar({ getConfig: () => config, getSecret: async () => null })
  await sidecar.start('127.0.0.1', 0)
  assert.equal(sidecar.status().running, true)
  const port = sidecar.status().port
  try {
    const plain = await fetch(`http://127.0.0.1:${port}/v1/models`)
    const plainBody = await plain.json()
    assert.deepEqual(plainBody.data.map((m) => m.id), ['demo/mimo'])

    const discovery = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { 'anthropic-version': '2023-06-01' }
    })
    const discoveryBody = await discovery.json()
    assert.equal(discoveryBody.data.length, 1)
    assert.equal(decodeSyntheticModelId(discoveryBody.data[0].id), 'demo/mimo')
    assert.equal(discoveryBody.data[0].display_name, 'demo/mimo')
  } finally {
    await sidecar.stop()
  }
})
