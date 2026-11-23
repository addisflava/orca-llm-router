// Pure pricing tests: no network, no secrets, no live gateway.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPriceCatalog, entryCostUsd, estimateCostUsd, normalizeModelId, quoteCost, resolvePriceEntry, catalogVersion } from '../worker/pricing.mjs'
import { PRICE_ENTRIES } from '../worker/price-data.mjs'
import { buildCatalogData, renderCatalogModule } from '../tools/generate-prices.mjs'

const FIXTURE = [
  { id: 'gpt-4o', provider: 'openai', input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
  { id: 'claude-sonnet-4-5', provider: 'anthropic', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { id: 'claude-sonnet-4-5', provider: 'opencode', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { id: 'deepseek-chat', provider: 'deepseek', input: 0.29, output: 1.16, cacheRead: 0.29, reasoning: 1.16 },
  {
    id: 'tiered', provider: 'openai', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1,
    tiers: [
      { size: 1000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2 },
      { size: 10000, input: 3, output: 6, cacheRead: 0.3, cacheWrite: 3 }
    ]
  },
  { id: 'free-model', provider: 'openai', input: 0, output: 0 }
]

const catalog = createPriceCatalog(FIXTURE)
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)

test('model ids normalize dates, prefixes and version suffixes', () => {
  assert.equal(normalizeModelId('anthropic/claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5')
  assert.equal(normalizeModelId('openai/gpt-4o'), 'gpt-4o')
  assert.equal(normalizeModelId('deepseek-v4-pro-0813'), 'deepseek-v4-pro')
  assert.equal(normalizeModelId('claude-opus-5@20260101'), 'claude-opus-5')
  assert.equal(normalizeModelId(''), '')
})

test('resolve prefers the requested provider, then the publisher, then any match', () => {
  assert.equal(resolvePriceEntry('openai', 'openai/gpt-4o', catalog).provider, 'openai')
  assert.equal(resolvePriceEntry('opencode', 'claude-sonnet-4-5-20250929', catalog).provider, 'opencode')
  assert.equal(resolvePriceEntry('openrouter', 'anthropic/claude-sonnet-4-5', catalog).provider, 'anthropic')
  assert.equal(resolvePriceEntry('unknown-gateway', 'claude-sonnet-4-5', catalog).provider, 'anthropic')
  assert.equal(resolvePriceEntry('openai', 'not-a-model', catalog), null)
})

test('resolver maps router preset ids to models.dev provider ids', () => {
  assert.equal(resolvePriceEntry('gemini', 'gemini-2.5-flash').provider, 'google')
  assert.equal(resolvePriceEntry('zhipu-cn-coding', 'glm-5.2').provider, 'zhipuai')
  assert.equal(resolvePriceEntry('moonshot', 'kimi-k2.7-code').provider, 'moonshotai-cn')
  assert.equal(resolvePriceEntry('bailian', 'qwen-plus').provider, 'alibaba')
})

test('basic input and output pricing', () => {
  close(entryCostUsd(FIXTURE[0], { input: 1_000_000, output: 1_000_000 }), 12.5)
  close(estimateCostUsd({ provider: 'openai', model: 'gpt-4o', input: 1000, output: 100 }, catalog), 0.0035)
})

test('cache reads and single-rate cache writes', () => {
  const usd = entryCostUsd(FIXTURE[0], { input: 1000, cacheRead: 1000, cacheWrite: 2000 })
  close(usd, (1000 * 2.5 + 1000 * 1.25 + 2000 * 2.5) / 1e6)
})

test('anthropic 1-hour writes cost twice the tier input rate', () => {
  const usd = entryCostUsd(FIXTURE[1], { cacheWrite: 100, cacheWrite1h: 40 })
  close(usd, (60 * 3.75 + 40 * 6) / 1e6)
  // Without a 1h split everything uses the listed 5m write rate.
  close(entryCostUsd(FIXTURE[1], { cacheWrite: 100 }), (100 * 3.75) / 1e6)
})

test('long-context tiers count cache tokens toward the prompt length', () => {
  const entry = FIXTURE[4]
  close(entryCostUsd(entry, { input: 1500, output: 10 }), (1500 * 2 + 10 * 4) / 1e6)
  close(entryCostUsd(entry, { input: 900, cacheRead: 200, output: 10 }), (900 * 2 + 200 * 0.2 + 10 * 4) / 1e6)
  close(entryCostUsd(entry, { input: 20_000, output: 10 }), (20_000 * 3 + 10 * 6) / 1e6)
})

test('reasoning tokens use their own rate when listed', () => {
  const usd = entryCostUsd(FIXTURE[3], { output: 100, reasoning: 900 })
  close(usd, (100 * 1.16 + 900 * 1.16) / 1e6)
})

test('missing rates make a request unpriced, free models still cost zero', () => {
  assert.equal(entryCostUsd({ id: 'x', provider: 'openai', input: 1 }, { output: 10 }), null)
  assert.equal(entryCostUsd(FIXTURE[5], { input: 1000, output: 1000 }), 0)
  assert.equal(estimateCostUsd({ provider: 'openai', model: 'nope', input: 10 }, catalog), null)
})

test('OpenAI-style prompt_tokens that include cache tokens are not double counted', () => {
  const quote = quoteCost({
    provider: 'openai', model: 'gpt-4o',
    tokens: { input: 1000, output: 100, cacheRead: 500, inputIncludesCache: true }
  }, catalog)
  // 500 uncached input + 500 cached reads, not 1000 input + 500 reads.
  close(quote.usd, (500 * 2.5 + 100 * 10 + 500 * 1.25) / 1e6)
  const anthropic = quoteCost({
    provider: 'anthropic', model: 'claude-sonnet-4-5',
    tokens: { input: 500, output: 100, cacheRead: 500 }
  }, catalog)
  close(anthropic.usd, (500 * 3 + 100 * 15 + 500 * 0.3) / 1e6)
})

test('operator pricing wins and keeps the old input/output-only behaviour', () => {
  const quote = quoteCost({
    pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
    provider: 'openai', model: 'gpt-4o',
    tokens: { input: 1000, output: 100, cacheRead: 5000 }
  }, catalog)
  assert.equal(quote.source, 'override')
  close(quote.usd, (1000 + 200) / 1e6)

  const fallback = quoteCost({ provider: 'openai', model: 'gpt-4o', tokens: { input: 1000 } }, catalog)
  assert.equal(fallback.source, 'catalog')
  close(fallback.usd, 0.0025)

  const unpriced = quoteCost({ provider: 'openai', model: 'nope', tokens: { input: 1000 } }, catalog)
  assert.deepEqual(unpriced, { usd: null, source: null })
})

test('generated catalog covers router presets with cache and tier data', () => {
  assert.ok(catalogVersion)
  assert.ok(PRICE_ENTRIES.length > 500)
  assert.ok(PRICE_ENTRIES.some((entry) => entry.provider === 'anthropic' && entry.cacheWrite))
  assert.ok(PRICE_ENTRIES.some((entry) => entry.provider === 'deepseek' && entry.cacheRead))
  assert.ok(PRICE_ENTRIES.some((entry) => entry.tiers?.length))
  close(estimateCostUsd({ provider: 'deepseek', model: 'deepseek-chat', input: 1000, output: 100 }), (1000 * 0.29 + 100 * 1.16) / 1e6)
})

test('generator is offline-safe and emits deterministic data', () => {
  const json = {
    openai: {
      models: {
        gpt4: { cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 1, tiers: [{ input: 3, output: 4, cache_read: 1, cache_write: 2, tier: { size: 1000 } }] } },
        noCost: {}
      }
    },
    anthropic: { models: { claude: { cost: { input: 5, output: 25 } } } },
    'nano-gpt': { models: { 'deepseek-chat': { cost: { input: 0.29, output: 1.16 } } } }
  }
  const data = buildCatalogData(json, { providers: ['openai', 'anthropic'], asOf: '2026-01-02' })
  assert.equal(data.generatedAt, '2026-01-02')
  assert.deepEqual(data.entries.map((entry) => `${entry.provider}/${entry.id}`), [
    'anthropic/claude', 'deepseek/deepseek-chat', 'openai/gpt4'
  ])
  assert.equal(data.entries[2].tiers.length, 1)
  assert.equal(data.entries[2].tiers[0].size, 1000)
  const module = renderCatalogModule(data)
  assert.match(module, /export const GENERATED_AT = "2026-01-02"/)
  assert.equal(renderCatalogModule(buildCatalogData(json, { providers: ['openai', 'anthropic'], asOf: '2026-01-02' })), module)
})
