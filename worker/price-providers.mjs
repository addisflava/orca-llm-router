// Mapping between the router's provider ids and models.dev provider ids, plus
// model-name prefixes used when a provider-specific price is not available.
// Pure data: no Node built-ins, no network, no Orca imports.

// Router preset ids not listed here map to themselves. Multiple router presets
// can share one models.dev provider (for example zhipu-cn-coding and
// zhipu-cn-general both use `zhipuai` prices).
export const ROUTER_TO_MODELS_DEV = Object.freeze({
  gemini: 'google',
  'kimi-coding': 'kimi-code-plan-global',
  'zhipu-cn-coding': 'zhipuai',
  'zhipu-cn-general': 'zhipuai',
  'zai-global-coding': 'zai',
  'zai-global-general': 'zai',
  'minimax-global': 'minimax',
  moonshot: 'moonshotai-cn',
  'moonshot-global': 'moonshotai',
  bailian: 'alibaba',
  'qwen-web': 'alibaba',
  'deepseek-web': 'deepseek'
})

// Ordered: a model name is matched against these prefixes to find the
// publisher's own provider when the request's provider has no price for it.
export const MODEL_PROVIDERS = Object.freeze([
  [/^claude-/, 'anthropic'],
  [/^(gpt-|o[134]-|chatgpt-|text-embedding-)/, 'openai'],
  [/^(gemini-|gemma-|learnlm-)/, 'google'],
  [/^deepseek-/, 'deepseek'],
  [/^qwen/, 'alibaba'],
  [/^(glm-|chatglm-)/, 'zhipuai'],
  [/^(kimi-|k2-)/, 'moonshotai'],
  [/^mimo-/, 'xiaomi'],
  [/^minimax-/i, 'minimax'],
  [/^(nemotron-|nvidia-)/, 'nvidia'],
  [/^(mistral|devstral|codestral|ministral|voxtral)/, 'mistral'],
  [/^opencode/, 'opencode']
])

// All models.dev providers worth bundling: the router presets plus the
// publishers above, so a model can still be priced when the endpoint is a
// third-party gateway that models.dev does not list under its own id.
export const CATALOG_PROVIDERS = Object.freeze([
  ...new Set([
    ...Object.values(ROUTER_TO_MODELS_DEV),
    'openai', 'anthropic', 'google', 'deepseek', 'alibaba', 'zhipuai', 'zai',
    'moonshotai', 'moonshotai-cn', 'kimi-code-plan-global', 'kimi-code-plan-cn',
    'xiaomi', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-ams',
    'minimax', 'minimax-cn', 'mistral', 'nvidia', 'opencode', 'opencode-go',
    'openrouter', 'siliconflow', 'qiniu-ai', 'teamorouter', 'runapi'
  ])
])
