import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from '../src/panel'
import type { RouterConfig } from '../src/protocol'

const config: RouterConfig = {
  version: 3,
  token: 'orca-router',
  providers: [
    {
      name: 'anthropic',
      displayName: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      protocols: ['anthropic_messages'],
      models: [{ id: 'existing-model' }, { id: 'custom-extra' }],
      keys: []
    }
  ],
  routes: [
    {
      name: 'fast',
      targets: [{ provider: 'anthropic', model: 'existing-model' }],
      strategy: 'fastest',
      enabled: true
    }
  ],
  aliases: {},
  policies: [],
  defaultFallback: { mode: 'retry', models: [], retryCount: 2 },
  clientKeys: [],
  agentProfiles: []
}

const status = {
  running: true,
  host: '127.0.0.1',
  port: 18080,
  providers: [
    {
      name: 'anthropic',
      displayName: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      protocols: ['anthropic_messages'],
      models: ['existing-model', 'custom-extra'],
      keyCount: 0,
      health: { state: 'healthy', latencyMs: 180, samples: 6, failures: 0, lastSuccessAt: Date.now() - 5_000 }
    }
  ],
  upstreams: [],
  policies: [],
  aliases: {},
  clientKeys: [],
  agentProfiles: [],
  agents: [],
  logs: []
}

const usage = {
  window: 'today',
  since: Date.now() - 3_600_000,
  requests: 0,
  successRate: 1,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cost: 0,
  avgLatencyMs: 0,
  byProvider: [],
  byModel: [],
  totals: {}
}

test('model picker filters fetched models and adds only the selected ones', async () => {
  let saved: RouterConfig | null = null
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': () => ({ config: saved ?? config }),
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.discoverModels': {
        ok: true,
        models: ['existing-model', 'new-alpha', 'new-beta'],
        provider: 'anthropic'
      },
      'router.config.save': (input) => {
        saved = input.config
        return { ok: true }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'providers' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  await app.press(app.findAll({ text: 'Fetch models' })[0])
  assert.ok(app.find({ text: 'Select models' }), 'picker opens after fetching')

  assert.equal(app.valueOf({ label: 'existing-model' }), true, 'saved models start selected')
  assert.equal(app.valueOf({ label: 'new-alpha' }), false, 'new models start unselected')

  await app.toggle({ label: 'new-alpha' })
  assert.equal(app.valueOf({ label: 'new-alpha' }), true, 'individual checkbox toggles on')
  await app.toggle({ label: 'new-alpha' })
  assert.equal(app.valueOf({ label: 'new-alpha' }), false, 'individual checkbox toggles off')

  await app.press({ text: 'Select all' })
  assert.equal(app.valueOf({ label: 'new-alpha' }), true, 'select all checks new models')
  await app.press({ text: 'Deselect all' })
  assert.equal(app.valueOf({ label: 'new-alpha' }), false, 'deselect all clears new models')
  assert.equal(app.valueOf({ label: 'existing-model' }), false, 'deselect all clears saved models')
  await app.press({ text: 'Select all' })
  assert.equal(app.valueOf({ label: 'existing-model' }), true, 'select all checks saved models')

  await app.press({ text: 'Deselect all' })
  await app.type({ label: 'Filter models' }, 'new-alpha', { replace: true })
  assert.equal(app.findAll({ label: 'new-beta' }).length, 0, 'filter hides other models')
  await app.press({ text: 'Select shown' })
  assert.equal(app.valueOf({ label: 'new-alpha' }), true, 'select shown checks filtered models')
  await app.press({ text: 'Apply changes' })

  assert.ok(saved, 'config saved')
  const models = saved.providers[0].models ?? []
  assert.deepEqual(
    models.map((model) => model.id),
    ['custom-extra', 'new-alpha'],
    'only selected fetched models are saved and unseen extras are kept'
  )
  assert.equal(app.find({ text: 'Select models' }), null, 'picker closes after saving')
  await app.unmount()
})

test('provider editor exposes every endpoint and protocol, including gemini', async () => {
  const gatewayStatus = {
    ...status,
    providers: [
      {
        name: 'gateway',
        displayName: 'Gateway',
        baseUrl: 'https://gateway.test/v1',
        protocols: ['openai', 'anthropic', 'gemini'],
        models: ['model-a'],
        keyCount: 0
      }
    ]
  }
  const gatewayConfig: RouterConfig = {
    ...config,
    providers: [
      {
        name: 'gateway',
        displayName: 'Gateway',
        baseUrl: 'https://gateway.test/v1',
        protocols: ['openai', 'anthropic', 'gemini'],
        models: [{ id: 'model-a' }],
        keys: [],
        endpoints: [
          { baseUrl: 'https://gateway.test/v1', protocols: ['openai'] },
          { baseUrl: 'https://gateway.test', protocols: ['anthropic'] },
          { baseUrl: 'https://gateway.test', protocols: ['gemini'] }
        ]
      }
    ]
  }
  let saved: RouterConfig | null = null
  const host = mockHost({
    requests: {
      'router.status': gatewayStatus as never,
      'router.config.get': () => ({ config: saved ?? gatewayConfig }),
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.config.save': (input) => {
        saved = input.config
        return { ok: true }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'providers' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  await app.press(app.findAll({ text: 'Edit' })[0])
  await app.settled()
  assert.ok(app.find({ label: 'Base URL 1' }), 'the first endpoint is editable')
  assert.ok(app.find({ label: 'Base URL 2' }), 'a second endpoint is editable')
  assert.ok(app.find({ text: '✓ Gemini' }), 'the gemini protocol is exposed')
  await app.type({ label: 'Base URL 2' }, 'https://gateway.test/api', { replace: true })
  await app.press({ text: 'Save changes' })
  await app.settled()

  assert.ok(saved, 'the edit is persisted')
  const provider = saved.providers[0]
  assert.deepEqual(
    provider.endpoints?.map((endpoint) => endpoint.baseUrl),
    ['https://gateway.test/v1', 'https://gateway.test/api'],
    'endpoint URLs are saved in order'
  )
  assert.deepEqual(provider.protocols, ['openai', 'anthropic', 'gemini'], 'every protocol survives the edit')
  await app.unmount()
})

test('search all models writes the picked models into every provider', async () => {
  const multiConfig: RouterConfig = {
    ...config,
    providers: [
      {
        name: 'anthropic',
        displayName: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        protocols: ['anthropic_messages'],
        models: [{ id: 'existing-model' }, { id: 'custom-extra' }],
        keys: []
      },
      {
        name: 'openai',
        displayName: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        protocols: ['openai'],
        models: [{ id: 'gpt-5' }],
        keys: []
      }
    ]
  }
  const multiStatus = {
    ...status,
    providers: [
      { ...status.providers[0] },
      {
        name: 'openai',
        displayName: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        protocols: ['openai'],
        models: ['gpt-5'],
        keyCount: 0
      }
    ]
  }
  let saved: RouterConfig | null = null
  const host = mockHost({
    requests: {
      'router.status': multiStatus as never,
      'router.config.get': () => ({ config: saved ?? multiConfig }),
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.discoverAllModels': {
        ok: true,
        providers: [
          { provider: 'anthropic', models: ['existing-model', 'new-alpha'] },
          { provider: 'openai', models: ['gpt-5', 'gpt-5-mini'] }
        ]
      },
      'router.config.save': (input) => {
        saved = input.config
        return { ok: true }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'providers' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  await app.press({ text: 'Fetch all models' })
  assert.ok(app.find({ text: 'Search all providers' }), 'the cross-provider list opens')
  assert.equal(app.valueOf({ label: 'existing-model' }), true, 'saved models start selected')
  assert.equal(app.valueOf({ label: 'gpt-5' }), true, 'saved models on another provider start selected')
  assert.equal(app.valueOf({ label: 'new-alpha' }), false, 'new models start unselected')

  await app.press({ text: 'Select all' })
  await app.toggle({ label: 'new-alpha' })
  await app.press({ text: 'Make 1 model available' })

  assert.ok(saved, 'config saved')
  const byName = new Map((saved as RouterConfig).providers.map((provider) => [provider.name, provider]))
  assert.deepEqual(
    (byName.get('anthropic')?.models ?? []).map((model) => model.id),
    ['existing-model', 'custom-extra'],
    'unchecked models are not added and hand-written extras survive'
  )
  assert.deepEqual(
    (byName.get('openai')?.models ?? []).map((model) => model.id),
    ['gpt-5', 'gpt-5-mini'],
    'the picked model is added to its own provider'
  )
  await app.unmount()
})

test('a route can pull every provider models into the target list', async () => {
  let saved: RouterConfig | null = null
  const statusFor = () => {
    const source = saved ?? config
    return {
      ...status,
      providers: source.providers.map((provider) => ({
        name: provider.name,
        displayName: provider.displayName,
        baseUrl: provider.baseUrl,
        protocols: provider.protocols,
        models: (provider.models ?? []).map((model) => model.id),
        keyCount: (provider.keys ?? []).length
      }))
    }
  }
  const host = mockHost({
    requests: {
      'router.status': statusFor as never,
      'router.config.get': () => ({ config: saved ?? config }),
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.discoverAllModels': {
        ok: true,
        providers: [{ provider: 'anthropic', models: ['existing-model', 'brand-new'] }]
      },
      'router.config.save': (input) => {
        saved = input.config
        return { ok: true }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'routing' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  await app.press({ text: 'New route' })
  await app.press({ text: 'Fetch all models from all providers' })
  assert.ok(app.find({ label: 'anthropic/brand-new' }), 'a fetched model joins the route target list')

  await app.type({ label: 'Model alias' }, 'fast', { replace: true })
  await app.toggle({ label: 'anthropic/brand-new' })
  await app.press({ text: 'Add route' })

  assert.ok(saved, 'the route is saved')
  const cfg = saved as RouterConfig
  assert.deepEqual(
    cfg.providers[0].models?.map((model) => model.id),
    ['existing-model', 'custom-extra', 'brand-new'],
    'the picked target is saved to its provider'
  )
  assert.deepEqual(
    cfg.routes.find((entry) => entry.name === 'fast')?.targets,
    [{ provider: 'anthropic', model: 'brand-new' }],
    'the route targets the fetched model'
  )
  await app.unmount()
})

test('overview groups configuration and traffic stats with the missing error and model counts', async () => {
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': { config },
      'router.usage': {
        ...usage,
        requests: 5,
        successRate: 0.8,
        errors: 1,
        inputTokens: 1_200,
        outputTokens: 800,
        totalTokens: 2_000,
        cost: 0.05,
        avgLatencyMs: 420
      },
      'router.presets': { presets: [] },
      'router.keyUsage': { providers: [] }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'overview' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    assert.ok(app.find({ text: 'Models' }), 'the model count is on the dashboard')
    assert.ok(app.find({ text: 'Errors' }), 'the error count is on the dashboard')
    assert.ok(app.find({ text: '1.2K in · 800 out' }), 'the token split is visible under the total')
  } finally {
    await app.unmount()
  }
})

test('provider key rows show rolling usage and the tightest quota meter', async () => {
  const keyedConfig: RouterConfig = {
    ...config,
    providers: [{
      ...config.providers[0],
      keys: [{ id: 'primary', secretKey: 'KEY_1', limits: { rpd: 100 } }]
    }]
  }
  const keyedStatus = {
    ...status,
    providers: [{
      ...status.providers[0],
      keyCount: 1,
      keyUsage: [{
        id: 'primary',
        secretKey: 'KEY_1',
        enabled: true,
        state: 'ready',
        requests: { minute: 1, hour: 15, day: 15 },
        tokens: { minute: 100, hour: 1_200, day: 1_200 },
        images: { minute: 0, hour: 0, day: 0 },
        meters: [{
          field: 'rpd',
          kind: 'requests',
          windowMs: 86_400_000,
          used: 15,
          limit: 100,
          remaining: 85,
          utilization: 0.15
        }],
        utilization: 0.15
      }]
    }]
  }
  const host = mockHost({
    secrets: { KEY_1: 'sk-ant-existing' },
    requests: {
      'router.status': keyedStatus as never,
      'router.config.get': { config: keyedConfig },
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.keyUsage': {
        providers: [{
          provider: 'anthropic',
          keys: [{
            id: 'primary',
            secretKey: 'KEY_1',
            enabled: true,
            status: 'ok',
            fetchedAt: Date.now(),
            errors: [],
            meters: [{
              id: 'rolling-5h',
              kind: 'quota',
              label: '5h limit',
              unit: '%',
              limit: 100,
              used: 42,
              remaining: 58
            }, {
              id: 'weekly',
              kind: 'quota',
              label: 'Weekly limit',
              unit: '%',
              limit: 100,
              used: 31,
              remaining: 69
            }]
          }]
        }]
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'providers' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    assert.ok(app.find({ text: '42 %' }), 'the provider quota bar is visible')
    assert.ok(app.find({ text: '5h limit · 42% / 100%' }), 'the provider window is named')
    assert.ok(app.find({ text: 'Provider quota' }), 'the provider section is labelled')
    assert.equal(app.findAll({ text: '24h: 15 req · 1.2K tok' }).length, 1, 'the usage summary appears once beside the key')
    assert.equal(app.findAll({ text: '5h limit: 42%' }).length, 1, 'provider rate summaries stack beside the key')
    assert.equal(app.findAll({ text: 'Weekly limit: 31%' }).length, 1, 'every provider window gets its own stacked line')
    assert.ok(app.find({ text: '15 %' }), 'the local percentage is visible')
    assert.ok(app.find({ text: 'rpd 15 / 100 per day' }), 'the limiting window is named')
    assert.ok(app.find({ text: 'Local limits' }), 'the local section is labelled')
    assert.equal(app.find({ text: 'View' }), null, 'there is no view button')
    assert.equal(app.find({ text: 'Copy key' }), null, 'copy starts under options')
    await app.press({ text: 'Options' })
    await app.settled()
    assert.ok(app.find({ label: 'Key name' }), 'options expose the key name')
    assert.equal(app.find({ label: 'API key' }), null, 'the key value field stays hidden until requested')
    assert.equal(app.find({ label: 'New API key' }), null, 'the old replacement field is gone')
    assert.ok(app.find({ text: 'Edit key' }), 'options expose an edit key action')
    assert.ok(app.find({ text: 'Copy key' }), 'copy is inside key options')
    assert.equal(app.find({ text: 'View' }), null, 'key options still have no view button')
    await app.press({ text: 'Edit key' })
    await app.settled()
    const apiKeyField = app.find({ label: 'API key' })
    assert.ok(apiKeyField, 'edit key opens the value field')
    assert.equal(app.valueOf(apiKeyField), 'sk-ant-existing', 'edit key loads the existing secret')
    await app.type(apiKeyField, '-updated')
    assert.equal(app.valueOf(apiKeyField), 'sk-ant-existing-updated', 'the loaded secret can be edited')
    assert.equal(app.find({ text: 'Edit key' }), null, 'the edit action hides while the field is open')
  } finally {
    await app.unmount()
  }
})

test('the provider Usage button probes, shows a detected quota, and can save it', async () => {
  const keyedConfig: RouterConfig = {
    ...config,
    providers: [{ ...config.providers[0], keys: [{ id: 'primary', secretKey: 'KEY_1' }] }]
  }
  let saved: { provider?: string; usageFetch?: any } | null = null
  const connector = {
    id: 'probe-openrouter',
    type: 'http-json',
    endpoint: 'https://api.anthropic.com/v1/credits',
    auth: 'provider-api-key',
    mapping: {
      meters: [{
        id: 'balance',
        kind: 'balance',
        label: 'Balance',
        limit: '$.data.total_credits',
        used: '$.data.total_usage',
        unit: 'USD'
      }]
    }
  }
  const reported = {
    provider: 'anthropic',
    keys: [{
      id: 'primary',
      secretKey: 'KEY_1',
      enabled: true,
      status: 'ok',
      fetchedAt: Date.now(),
      errors: [],
      meters: [{ id: 'balance', kind: 'balance', label: 'Balance', unit: 'USD', remaining: 12 }]
    }]
  }
  const host = mockHost({
    requests: {
      'router.status': { ...status, providers: [{ ...status.providers[0], keyCount: 1 }] } as never,
      'router.config.get': { config: keyedConfig },
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.keyUsage': () => ({
        providers: [saved ? reported : { provider: 'anthropic', keys: [], reason: 'no-endpoint' }]
      }),
      'router.usageProbe': {
        provider: 'anthropic',
        ok: true,
        endpoint: connector.endpoint,
        secretKey: 'KEY_1',
        connector,
        meters: [{ id: 'balance', kind: 'balance', label: 'Balance', unit: 'USD', remaining: 12 }],
        errors: [],
        tried: [{ url: connector.endpoint, status: 200 }]
      },
      'router.provider.usage': (input: { provider?: string; usageFetch?: any }) => {
        saved = input
        return { ok: true }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'providers' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    assert.equal(app.find({ text: 'Balance' }), null, 'no provider quota before the click')
    await app.press({ text: 'Fetch usage' })
    await app.settled()
    assert.ok(app.find({ text: 'Balance' }), 'the probe result is shown inline')
    assert.ok(app.find({ text: 'Save usage source' }), 'the detected source can be saved')
    await app.press({ text: 'Save usage source' })
    await app.settled()
    assert.ok(saved, 'the detected connector is persisted')
    assert.equal(saved.usageFetch.connectors[0].endpoint, connector.endpoint)
    assert.ok(app.find({ text: 'Usage source saved' }), 'the save is confirmed')
  } finally {
    await app.unmount()
  }
})

test('the Usage button explains a failed probe and the editor saves a custom source', async () => {
  const keyedConfig: RouterConfig = {
    ...config,
    providers: [{ ...config.providers[0], keys: [{ id: 'primary', secretKey: 'KEY_1' }] }]
  }
  let saved: { provider?: string; usageFetch?: any } | null = null
  const host = mockHost({
    requests: {
      'router.status': { ...status, providers: [{ ...status.providers[0], keyCount: 1 }] } as never,
      'router.config.get': { config: keyedConfig },
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.keyUsage': { providers: [{ provider: 'anthropic', keys: [], reason: 'no-endpoint' }] },
      'router.usageProbe': {
        provider: 'anthropic',
        ok: false,
        reason: 'not-found',
        tried: [{ url: 'https://api.anthropic.com/v1/credits', status: 404 }]
      },
      'router.provider.usage': (input: { provider?: string; usageFetch?: any }) => {
        saved = input
        return { ok: true }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'providers' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    await app.press({ text: 'Fetch usage' })
    await app.settled()
    assert.ok(app.find({ text: 'No usage source found after trying 1 endpoint.' }), 'the probe result is explained')
    await app.press({ text: 'Set up' })
    await app.settled()
    assert.ok(app.find({ text: 'Usage source' }), 'the usage source editor opens')
    await app.type({ label: 'Usage endpoint' }, 'https://api.example.test/v1/credits', { replace: true })
    await app.type(
      { label: 'Meters JSON' },
      '[{"id":"balance","label":"Balance","remaining":"$.data.balance","unit":"USD"}]',
      { replace: true }
    )
    await app.press({ text: 'Save usage source' })
    await app.settled()
    assert.ok(saved, 'the custom connector is persisted')
    assert.equal(saved.usageFetch.connectors[0].endpoint, 'https://api.example.test/v1/credits')
    assert.equal(saved.usageFetch.connectors[0].mapping.meters[0].remaining, '$.data.balance')
  } finally {
    await app.unmount()
  }
})

test('routing shows the routes list and creates a route', async () => {
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': { config },
      'router.usage': usage,
      'router.presets': { presets: [] }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'routing' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    assert.ok(app.find({ text: 'How routing works' }), 'the routing page explains routes')
    assert.ok(app.find({ text: 'Routes' }), 'the routes list is on the routing page')
    assert.ok(app.find({ text: 'fast' }), 'saved routes are listed')
    assert.equal(app.find({ text: 'Global Policies' }), null, 'policies moved off the routing page')

    await app.press({ text: 'New route' })
    assert.ok(app.find({ label: 'Model alias' }), 'the top action opens the route editor')
  } finally {
    await app.unmount()
  }
})

test('route editor hides the ordered chain in fastest mode and reorders in ordered mode', async () => {
  let saved: RouterConfig | null = null
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': () => ({ config: saved ?? config }),
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.config.save': (input) => {
        saved = input.config
        return { ok: true }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'routing' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    await app.press({ text: 'New route' })
    await app.type({ label: 'Model alias' }, 'smart', { replace: true })

    // Fastest first: order is decided at request time, so no reorder list is shown.
    await app.toggle({ label: 'anthropic/existing-model' })
    await app.toggle({ label: 'anthropic/custom-extra' })
    assert.equal(app.find({ text: 'Resolved chain' }), null, 'the resolved chain preview is gone')
    assert.ok(app.find({ text: 'Resolved order' }), 'the order section is always visible')
    assert.equal(app.findAll({ text: '↓' }).length, 0, 'fastest mode has no reorder controls')

    // Ordered mode: the reorder list appears and the dropdown can switch back.
    await app.select({ label: 'Try sequence' }, 'ordered')
    assert.ok(app.find({ label: 'Try sequence' }), 'the sequence dropdown sits beside the order title')
    const tree = JSON.stringify(app.tree())
    assert.ok(!tree.includes('["1","."]'), 'the index renders as one text node so its period cannot wrap')

    const downs = app.findAll({ text: '↓' })
    assert.equal(downs.length, 2, 'each selected target has a move-down control')
    await app.press(downs[0])
    await app.press({ text: 'Add route' })

    assert.deepEqual(
      saved?.routes.find((entry) => entry.name === 'smart')?.targets,
      [
        { provider: 'anthropic', model: 'custom-extra' },
        { provider: 'anthropic', model: 'existing-model' }
      ],
      'move-down reorders the saved targets'
    )
  } finally {
    await app.unmount()
  }
})

test('global policies live under settings', async () => {
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': { config },
      'router.usage': usage,
      'router.presets': { presets: [] }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'settings' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    assert.ok(app.find({ label: 'Global Policies' }), 'policies live under settings')

    await app.press({ text: 'New policy' })
    assert.ok(app.find({ label: 'Policy name' }), 'the top action opens the policy editor')
  } finally {
    await app.unmount()
  }
})

test('add-policy form saves every policy field the worker supports', async () => {
  let saved: RouterConfig | null = null
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': () => ({ config: saved ?? config }),
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.config.save': (input) => {
        saved = input.config
        return { ok: true }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'settings' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    await app.press({ text: 'New policy' })

    // The form exposes the match-all switch, the operator list, the default
    // model field, the multi-rewrite control and the fallback picker.
    assert.ok(app.find({ label: 'Policy name' }), 'policy name field')
    assert.ok(app.find({ label: 'Match all requests' }), 'match-all switch')
    assert.ok(app.find({ label: 'Operator' }), 'operator select')
    assert.ok(app.find({ label: 'Default model (optional)' }), 'default model field')
    assert.ok(app.find({ text: 'Add rewrite' }), 'add rewrite button')
    assert.ok(app.find({ label: 'Filter fallback targets' }), 'fallback picker')

    await app.type({ label: 'Policy name' }, 'Catch all', { replace: true })
    await app.toggle({ label: 'Match all requests' })
    assert.equal(app.find({ label: 'Operator' }), null, 'condition fields hide for match-all')
    await app.type({ label: 'Default model (optional)' }, 'anthropic/claude-sonnet-4-5', { replace: true })

    await app.press({ text: 'Add rewrite' })
    await app.type({ label: 'Path' }, 'request.body.tools', { replace: true })
    await app.select({ label: 'Operation' }, 'array-replace')
    assert.ok(app.find({ label: 'Match value' }), 'array-replace exposes a match value')
    await app.type({ label: 'Value' }, '{"type":"new"}', { replace: true })
    await app.type({ label: 'Match value' }, 'old-tool', { replace: true })

    await app.toggle({ label: 'fast (route)' })
    await app.press({ text: 'Add policy' })

    assert.ok(saved, 'config saved')
    const policy = saved.policies[0]
    assert.equal(policy.name, 'Catch all')
    assert.equal(policy.condition, null, 'match-all saves a null condition')
    assert.equal(policy.model, 'anthropic/claude-sonnet-4-5')
    assert.deepEqual(policy.rewrites, [
      { key: 'request.body.tools', operation: 'array-replace', value: { type: 'new' }, match: 'old-tool' }
    ], 'array rewrite keeps its operation, parsed value and match')
    assert.equal(policy.fallback?.mode, 'provider-chain')
    assert.deepEqual(policy.fallback?.models, ['fast'], 'the policy points at the route, not a copy of its targets')
  } finally {
    await app.unmount()
  }
})

test('a policy fallback can point at a route or a raw provider/model target', async () => {
  let saved: RouterConfig | null = null
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': () => ({ config: saved ?? config }),
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.config.save': (input) => {
        saved = input.config
        return { ok: true }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'settings' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    await app.press({ text: 'New policy' })
    await app.type({ label: 'Policy name' }, 'claude', { replace: true })
    await app.toggle({ label: 'fast (route)' })
    await app.toggle({ label: 'anthropic/existing-model' })
    await app.press({ text: 'Add policy' })

    assert.ok(saved, 'config saved')
    const policy = saved.policies.find((entry) => entry.name === 'claude')
    assert.deepEqual(
      policy?.fallback,
      { mode: 'provider-chain', models: ['fast', 'anthropic/existing-model'] },
      'a fallback chain mixes a named route and a raw provider/model target'
    )
  } finally {
    await app.unmount()
  }
})

test('the routing page reports migrated legacy chains and can dismiss the report', async () => {
  let saved: RouterConfig | null = null
  const migrated: RouterConfig = {
    ...config,
    migration: [{
      at: Date.now(),
      kind: 'global-chain',
      from: 'Global default fallback',
      to: 'default-failover',
      targets: [{ provider: 'anthropic', model: 'existing-model' }],
      note: 'No longer applies automatically; point a model name at this route to use it.'
    }]
  }
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': () => ({ config: saved ?? migrated }),
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.config.save': (input) => {
        saved = input.config
        return { ok: true }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'routing' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    assert.ok(
      app.find({ text: 'Global default fallback → default-failover (anthropic/existing-model)' }),
      'the migration report is visible'
    )
    await app.press({ text: 'Dismiss' })
    assert.ok(saved, 'config saved')
    assert.deepEqual(saved.migration, [], 'the report is dismissed')
  } finally {
    await app.unmount()
  }
})

test('route editor keeps a custom target and flags a provider that is not configured', async () => {
  let saved: RouterConfig | null = null
  const legacy: RouterConfig = {
    ...config,
    routes: [
      { name: 'legacy', targets: [{ provider: 'openai', model: 'gpt-5' }], strategy: 'ordered', enabled: true }
    ]
  }
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': () => ({ config: saved ?? legacy }),
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.config.save': (input) => {
        saved = input.config
        return { ok: true }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'routing' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    await app.press({ label: 'Edit route legacy' })
    assert.ok(app.find({ label: 'openai/gpt-5' }), 'the custom target stays selected while editing')
    assert.ok(
      app.find({ text: 'Provider "openai" is not configured; this target is skipped.' }),
      'an unknown provider prefix is flagged instead of silently misrouting'
    )
    await app.press({ text: 'Save route' })

    assert.ok(saved, 'config saved')
    const route = saved.routes?.find((entry) => entry.name === 'legacy')
    assert.deepEqual(route?.targets, [{ provider: 'openai', model: 'gpt-5' }])
  } finally {
    await app.unmount()
  }
})

test('route editor saves provider/model targets and speed preference', async () => {
  let saved: RouterConfig | null = null
  const emptyRoutes: RouterConfig = { ...config, routes: [] }
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': () => ({ config: saved ?? emptyRoutes }),
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.config.save': (input) => {
        saved = input.config
        return { ok: true }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'routing' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    await app.press({ text: 'New route' })
    await app.type({ label: 'Model alias' }, 'fast', { replace: true })
    await app.type({ label: 'Filter targets' }, 'model existing', { replace: true })
    assert.equal(app.findAll({ label: 'anthropic/custom-extra' }).length, 0, 'words match in any order and hide other targets')
    await app.press({ text: 'Select shown' })
    assert.equal(app.valueOf({ label: 'anthropic/existing-model' }), true, 'select shown ticks the filtered targets')
    await app.type({ label: 'Filter targets' }, 'custom', { replace: true })
    await app.toggle({ label: 'anthropic/custom-extra' })
    await app.type({ label: 'Retries per target' }, '4', { replace: true })
    await app.press({ text: 'Add route' })

    assert.ok(saved, 'config saved')
    const route = saved.routes?.find((entry) => entry.name === 'fast')
    assert.ok(route, 'the route is saved under the agent-facing name')
    assert.equal(route.strategy, 'fastest', 'the speed/health preference is saved')
    assert.equal(route.retries, 4, 'the per-target retry count is saved')
    assert.deepEqual(route.targets, [
      { provider: 'anthropic', model: 'existing-model' },
      { provider: 'anthropic', model: 'custom-extra' }
    ])
  } finally {
    await app.unmount()
  }
})

test('settings groups global behavior and config', async () => {
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': () => ({ config }),
      'router.usage': usage,
      'router.presets': { presets: [] }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'settings' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    assert.ok(app.find({ label: 'Global Policies' }), 'global policies are under settings')
    assert.ok(app.find({ label: 'Compress prompts' }), 'request optimization is under settings')
    assert.ok(app.find({ label: 'Priority tiers' }), 'key scheduling is under settings')
    assert.ok(app.find({ text: 'Create client key' }), 'client access is under settings')
    assert.ok(app.find({ text: 'Export config' }), 'import/export is under settings')
    assert.equal(app.findAll({ text: 'Default failover' }).length, 0, 'no global failover pane')
    assert.equal(
      app.findAll({ label: 'Order rule and default chains by speed and health' }).length,
      0,
      'no global health toggle'
    )
  } finally {
    await app.unmount()
  }
})

test('provider card hides health chrome when there is no sample', async () => {
  const withoutHealth = {
    ...status,
    providers: [{ ...status.providers[0], health: undefined }]
  }
  const host = mockHost({
    requests: {
      'router.status': withoutHealth as never,
      'router.config.get': { config },
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.keyUsage': { providers: [] }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'providers' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    assert.equal(app.find({ text: 'no data' }), null, 'no empty health badge')
    assert.equal(app.find({ text: 'No speed sample' }), null, 'no empty speed line')
  } finally {
    await app.unmount()
  }
})

test('providers tab no longer owns scheduling policy', async () => {
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': { config },
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.keyUsage': { providers: [] }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'providers' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    assert.equal(app.find({ text: 'Scheduling' }), null, 'scheduling lives on the Routing tab now')
    assert.equal(app.find({ text: 'Priority tiers' }), null, 'pool policy is not under Providers')
    assert.ok(app.find({ text: 'healthy' }), 'the provider card shows its health badge')
    assert.ok(app.find({ text: 'Response avg 180 ms / 6 reqs' }), 'the provider card combines the average and request count')
  } finally {
    await app.unmount()
  }
})

test('custom provider form uses the same grouped sections as the editor', async () => {
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': { config },
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.keyUsage': { providers: [] }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'providers' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    await app.press({ text: 'Add provider' })
    await app.press({ text: 'Custom provider' })
    await app.settled()

    assert.ok(app.find({ text: 'Provider name' }), 'name sits inline above the groups')
    assert.ok(app.find({ label: 'Base URL' }), 'the Endpoint group exposes the base URL')
    assert.ok(app.find({ text: 'Protocol' }), 'the Endpoint group exposes the protocol chips')
    assert.ok(app.find({ text: 'Usage source' }), 'the Usage source group is present')
    assert.ok(app.findAll({ text: 'Add endpoint' }).length, 'multiple endpoints can be added')

    await app.press({ text: 'Add endpoint' })
    await app.settled()
    assert.ok(app.find({ label: 'Base URL 2' }), 'a second endpoint can be edited')
  } finally {
    await app.unmount()
  }
})

test('custom provider saves its grouped endpoints and usage connector', async () => {
  let saved: RouterConfig | null = null
  let usageSaved: { provider?: string; usageFetch?: { connectors: { endpoint: string }[] } } | null = null
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': () => ({ config: saved ?? config }),
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.keyUsage': { providers: [] },
      'router.config.save': (input) => {
        saved = input.config
        return { ok: true }
      },
      'router.provider.usage': (input) => {
        usageSaved = input
        return { ok: true }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'providers' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await app.settled()

  try {
    await app.press({ text: 'Add provider' })
    await app.press({ text: 'Custom provider' })
    await app.settled()
    await app.type({ label: 'Name' }, 'gateway', { replace: true })
    await app.type({ label: 'Base URL' }, 'https://one.test/v1', { replace: true })
    await app.press({ text: 'Add endpoint' })
    await app.settled()
    await app.type({ label: 'Base URL 2' }, 'https://two.test', { replace: true })
    await app.press({ text: 'OpenAI' })
    await app.type(
      { label: 'Usage endpoint' },
      'https://one.test/credits',
      { replace: true }
    )
    await app.type(
      { label: 'Meters JSON' },
      '[{"id":"balance","label":"Balance","remaining":"$.balance","unit":"USD"}]',
      { replace: true }
    )
    await app.press(app.findAll({ text: 'Add provider' }).at(-1)!)
    await app.settled()

    assert.ok(saved, 'the provider is persisted')
    const provider = saved.providers.find((item) => item.name === 'gateway')
    assert.ok(provider, 'the new provider exists')
    assert.deepEqual(
      provider.endpoints?.map((endpoint) => endpoint.baseUrl),
      ['https://one.test/v1', 'https://two.test'],
      'both grouped endpoints are saved'
    )
    assert.deepEqual(provider.protocols, ['openai'], 'the enabled protocol is saved')
    assert.equal(usageSaved?.provider, 'gateway', 'the usage connector is saved with the provider')
  } finally {
    await app.unmount()
  }
})

const webchatProviderView = {
  name: 'deepseek-web',
  displayName: 'DeepSeek Web',
  baseUrl: '',
  protocols: ['openai'],
  models: ['deepseek-chat', 'deepseek-reasoner'],
  keyCount: 1,
  transport: 'deepseek-web'
} as never

async function openWebChatDialog(app: Awaited<ReturnType<typeof mount>>) {
  await app.press({ text: 'Add provider' })
  await app.settled()
  await app.press({ text: 'Web chat' })
  await app.settled()
}

test('add provider dialog offers to add both free web providers', async () => {
  const calls: string[] = []
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': () => ({ config }),
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.webchat.auth.status': ({ provider }: { provider: string }) => ({
        ok: true,
        configured: false,
        secretKey: `webchat:${provider}:auth`,
        session: null
      }),
      'router.webchat.setup': ({ transport }: { transport: string }) => {
        calls.push(`setup:${transport}`)
        return { ok: true, provider: transport, created: true, secretKey: `webchat:${transport}:auth` }
      },
      'router.webchat.auth.start': ({ provider }: { provider: string }) => {
        calls.push(`start:${provider}`)
        return { ok: true, mode: 'launch', port: 9222, profileDir: '', source: '', reused: false, secretKey: `webchat:${provider}:auth` }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'providers' } } })
  try {
    await app.settled()
    await openWebChatDialog(app)
    const tree = JSON.stringify(app.tree())
    assert.ok(tree.includes('deepseek-web.png'), 'the DeepSeek logo is rendered')
    assert.ok(tree.includes('qwen-web.png'), 'the Qwen logo is rendered')
    assert.equal(app.findAll({ text: 'Add as a provider' }).length, 2, 'both web services can be added')
    await app.press(app.findAll({ text: 'Add as a provider' })[0])
    await app.settled()
    assert.deepEqual(calls, ['start:deepseek-web'], 'adding a service only starts the browser login; the provider is created after verification')
  } finally {
    await app.unmount()
  }
})

test('add provider dialog exposes login, paste and session actions for a configured provider', async () => {
  const calls: string[] = []
  const host = mockHost({
    requests: {
      'router.status': { ...status, providers: [webchatProviderView] } as never,
      'router.config.get': () => ({ config }),
      'router.usage': usage,
      'router.presets': { presets: [] },
      'router.webchat.auth.status': () => ({
        ok: true,
        configured: true,
        secretKey: 'webchat:deepseek-web:auth',
        session: null
      }),
      'router.webchat.auth.start': ({ provider }: { provider: string }) => {
        calls.push(`start:${provider}`)
        return { ok: true, mode: 'launch', port: 9222, profileDir: '', source: '', reused: false, secretKey: `webchat:${provider}:auth` }
      }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'providers' } } })
  try {
    await app.settled()
    await openWebChatDialog(app)
    assert.ok(app.find({ text: 'Connected' }), 'a signed-in provider shows a Connected badge')
    assert.ok(app.find({ text: 'Reconnect' }), 'a connected provider offers Reconnect, not the setup buttons')
    assert.ok(!app.find({ text: 'Paste auth JSON' }), 'setup buttons are hidden until reconnect is chosen')
    assert.ok(!app.find({ text: 'Test connection' }), 'duplicate provider actions are not shown in the dialog')
    await app.press({ text: 'Reconnect' })
    await app.settled()
    assert.ok(app.find({ text: 'Web login' }), 'the reconnect dialog offers Web login')
    assert.ok(app.find({ text: 'Paste auth JSON' }), 'the reconnect dialog offers paste auth')
    await app.press({ text: 'Web login' })
    await app.settled()
    assert.deepEqual(calls, ['start:deepseek-web'], 'Web login calls the auth start handler')
    assert.ok(app.find({ text: 'Capture credentials' }), 'the capture step appears after login starts')
  } finally {
    await app.unmount()
  }
})

test('Show all is part of the collapsed model summary', async () => {
  const host = mockHost({
    requests: {
      'router.status': {
        ...status,
        providers: [
          { ...status.providers[0], models: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'] }
        ]
      } as never,
      'router.config.get': () => ({ config }),
      'router.usage': usage,
      'router.presets': { presets: [] }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'providers' } } })
  try {
    await app.settled()
    assert.ok(app.find({ text: 'Show all' }), 'the model summary offers Show all')
    await app.press({ text: 'Show all' })
    assert.ok(app.find({ text: 'Show less' }), 'the expanded model list can collapse again')
  } finally {
    await app.unmount()
  }
})

test('route cards use compact strategy badges', async () => {
  const host = mockHost({
    requests: {
      'router.status': status as never,
      'router.config.get': () => ({
        config: {
          ...config,
          routes: [
            ...config.routes,
            {
              name: 'ordered',
              targets: [{ provider: 'anthropic', model: 'existing-model' }],
              strategy: 'ordered',
              enabled: true
            }
          ]
        }
      }),
      'router.usage': usage,
      'router.presets': { presets: [] }
    }
  })
  const app = await mount(panel, { host, persisted: { plugin: { tab: 'routing' } } })
  try {
    await app.settled()
    assert.ok(app.find({ text: 'fastest' }), 'a fastest route shows a fastest badge')
    assert.ok(app.find({ text: 'in order' }), 'an ordered route shows an in order badge')
  } finally {
    await app.unmount()
  }
})
