// Web-chat model catalogs.
//
// These are the model alias tables the web-chat transports need: the client
// sends a friendly alias (deepseek-chat, qwen/qwen3-max) and the adapter maps it
// to the upstream web contract (DeepSeek model_type + thinking/search toggles,
// Qwen upstream model id + thinking flag).
//
// Ported from FreeDeepseekAPI (server.js MODEL_CONFIGS, lib/providers/qwen.js
// MODEL_ALIASES) but reimplemented as plain data; nothing depends on that repo.

// ---------------------------------------------------------------------------
// DeepSeek Web
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DeepSeekModelConfig
 * @property {string} model_type   upstream web mode: 'default' | 'expert'
 * @property {boolean} thinking_enabled
 * @property {boolean} search_enabled
 * @property {string} real_model   human label
 * @property {{reasoning:boolean, web_search:boolean, files?:boolean, vision?:boolean}} capabilities
 * @property {boolean} supported   exposed through model lists only when true
 * @property {string|undefined} unavailable_reason
 */

export const DEEPSEEK_MODEL_CONFIGS = {
  'deepseek-chat': {
    model_type: 'default', thinking_enabled: false, search_enabled: false,
    real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web "Fast" / default)',
    capabilities: { reasoning: false, web_search: false, files: true },
    supported: true,
  },
  'deepseek-v3': {
    model_type: 'default', thinking_enabled: false, search_enabled: false,
    real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web "Fast" / default)',
    capabilities: { reasoning: false, web_search: false, files: true },
    supported: true,
  },
  'deepseek-default': {
    model_type: 'default', thinking_enabled: false, search_enabled: false,
    real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web "Fast" / default)',
    capabilities: { reasoning: false, web_search: false, files: true },
    supported: true,
  },
  'deepseek-reasoner': {
    model_type: 'default', thinking_enabled: true, search_enabled: false,
    real_model: 'DeepSeek-V4-Flash thinking mode (DeepSeek Web "Fast" + thinking_enabled)',
    capabilities: { reasoning: true, web_search: false, files: true },
    supported: true,
  },
  'deepseek-r1': {
    model_type: 'default', thinking_enabled: true, search_enabled: false,
    real_model: 'DeepSeek-V4-Flash thinking mode; R1-compatible alias',
    capabilities: { reasoning: true, web_search: false, files: true },
    supported: true,
  },
  'deepseek-chat-search': {
    model_type: 'default', thinking_enabled: false, search_enabled: true,
    real_model: 'DeepSeek-V4-Flash non-thinking + web search',
    capabilities: { reasoning: false, web_search: true, files: true },
    supported: true,
  },
  'deepseek-default-search': {
    model_type: 'default', thinking_enabled: false, search_enabled: true,
    real_model: 'DeepSeek-V4-Flash non-thinking + web search',
    capabilities: { reasoning: false, web_search: true, files: true },
    supported: true,
  },
  'deepseek-reasoner-search': {
    model_type: 'default', thinking_enabled: true, search_enabled: true,
    real_model: 'DeepSeek-V4-Flash thinking mode + web search',
    capabilities: { reasoning: true, web_search: true, files: true },
    supported: true,
  },
  'deepseek-r1-search': {
    model_type: 'default', thinking_enabled: true, search_enabled: true,
    real_model: 'DeepSeek-V4-Flash thinking mode + web search; R1-compatible alias',
    capabilities: { reasoning: true, web_search: true, files: true },
    supported: true,
  },
  'deepseek-expert': {
    model_type: 'expert', thinking_enabled: false, search_enabled: false,
    real_model: 'DeepSeek Web "Expert" (limited resources)',
    capabilities: { reasoning: false, web_search: false, files: false },
    supported: true,
  },
  'deepseek-v4-pro': {
    model_type: 'expert', thinking_enabled: true, search_enabled: false,
    real_model: 'DeepSeek Web "Expert" + thinking mode',
    capabilities: { reasoning: true, web_search: false, files: false },
    supported: true,
  },
  'deepseek-expert-search': {
    model_type: 'expert', thinking_enabled: false, search_enabled: true,
    real_model: 'DeepSeek Web "Expert" + search (not available upstream)',
    capabilities: { reasoning: false, web_search: false, files: false },
    supported: false,
    unavailable_reason: 'Expert mode is rejected; remote config says search is not available for Expert.',
  },
  'deepseek-vision': {
    model_type: 'vision', thinking_enabled: false, search_enabled: false,
    real_model: 'DeepSeek Web "Vision" / image understanding beta',
    capabilities: { reasoning: false, web_search: false, files: true, vision: true },
    supported: false,
    unavailable_reason: 'Current Web API returns: Vision is temporarily unavailable (backend_err_by_model).',
  },
}

export function deepseekModelConfig(model) {
  const id = String(model || '').toLowerCase()
    .replace(/^deepseek\//, '')
  if (id === 'deepseek') return DEEPSEEK_MODEL_CONFIGS['deepseek-chat']
  return DEEPSEEK_MODEL_CONFIGS[id] ?? null
}

/** All DeepSeek aliases, optionally only the ones usable today. */
export function listDeepseekModels(includeUnsupported = false) {
  return Object.keys(DEEPSEEK_MODEL_CONFIGS)
    .filter((id) => includeUnsupported || DEEPSEEK_MODEL_CONFIGS[id].supported)
}

/** Models exposed on a configured DeepSeek Web provider (supported only). */
export function deepseekCatalog() {
  return listDeepseekModels(false).map((id) => {
    const cfg = DEEPSEEK_MODEL_CONFIGS[id]
    return { id, description: cfg.real_model }
  })
}

// ---------------------------------------------------------------------------
// Qwen Web (chat.qwen.ai)
// ---------------------------------------------------------------------------

/**
 * Friendly, stable alias ids exposed to clients, mapped to the current upstream
 * catalog. `thinking: true` maps to Qwen's `phase: think` stream.
 */
export const QWEN_MODEL_ALIASES = {
  // Bare ids are what the router hands the transport when the `qwen-web`
  // provider owns them; the `qwen/...` spellings stay for older configs.
  'qwen3-max': { model: 'qwen3.7-max', thinking: false },
  'qwen3-max-thinking': { model: 'qwen3.7-max', thinking: true },
  'qwen3-plus': { model: 'qwen3.7-plus', thinking: false },
  'qwen3-plus-thinking': { model: 'qwen3.7-plus', thinking: true },
  'qwen/qwen3-max': { model: 'qwen3.7-max', thinking: false },
  'qwen/qwen3-max-thinking': { model: 'qwen3.7-max', thinking: true },
  'qwen/qwen3-plus': { model: 'qwen3.7-plus', thinking: false },
  'qwen/qwen3-plus-thinking': { model: 'qwen3.7-plus', thinking: true },
  'qwen3-coder-plus': { model: 'qwen3-coder-plus', thinking: false },
  'qwen3-coder-flash': { model: 'qwen3.6-plus', thinking: false },
  'qwen-max': { model: 'qwen3.7-max', thinking: false },
  'qwen-plus': { model: 'qwen3.7-plus', thinking: false },
  'qwen/qwen3-coder-plus': { model: 'qwen3-coder-plus', thinking: false },
  'qwen/qwen3-coder-flash': { model: 'qwen3.6-plus', thinking: false },
  'qwen/qwen-max': { model: 'qwen3.7-max', thinking: false },
  'qwen/qwen-plus': { model: 'qwen3.7-plus', thinking: false },
}

export const QWEN_DEFAULT_MODEL = 'qwen3.7-max'

/**
 * Resolve a client model id to an upstream Qwen model + thinking flag. Known
 * aliases come from the table; any other `qwen/<id>` passes through unchanged.
 */
export function qwenResolveModel(model) {
  const id = String(model || '').toLowerCase()
  const alias = QWEN_MODEL_ALIASES[id]
  if (alias) return { id: alias.model, thinking: alias.thinking, requested: id }
  const upstream = id.startsWith('qwen/') ? id.slice('qwen/'.length) : id
  return {
    id: upstream || QWEN_DEFAULT_MODEL,
    thinking: /think|reason|r1/.test(id),
    requested: id,
  }
}

export function qwenCatalog() {
  // Expose the canonical bare ids; the `qwen/...` spellings are compatibility
  // aliases for older configs and would only clutter the model picker.
  return Object.keys(QWEN_MODEL_ALIASES)
    .filter((id) => !id.startsWith('qwen/'))
    .map((id) => ({ id }))
}