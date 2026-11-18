// Prompt construction for web-chat providers.
//
// The router forwards a complete message array, but web chat accepts a single
// text prompt. These pure helpers build that prompt (system + tool schema +
// turn transcript), bound it to the upstream char budget, and manage the local
// recovery-history prefix used when a fresh remote session must reconstruct
// context. Ported from FreeDeepseekAPI's server.js and adapted to drop the
// proxy-specific wording.

import { formatToolDefinitions, normalizeMessageContent } from './tools.mjs'

const PROMPT_COMPACTION_MARKER = '\n\n[Earlier context compacted by the router]\n\n'

// DeepSeek-Web-specific defaults (kept as exported defaults so the transport
// can pass its own when configured).
export const MAX_MESSAGE_DEPTH = 100
export const MAX_HISTORY_LENGTH = 15
export const MAX_HISTORY_CHARS = 10000
export const MAX_UPSTREAM_PROMPT_CHARS = 80000

/**
 * Build the effective upstream prompt for one turn from the message array and
 * the (optional) tool list. Returns { prompt, systemPrompt } where prompt is the
 * conversation transcript and systemPrompt carries the system text + tool schema.
 */
export function formatMessages(messages, tools, { serverLabel = 'the local gateway', maxPromptChars = MAX_UPSTREAM_PROMPT_CHARS } = {}) {
  let systemPrompt = ''
  for (const msg of messages || []) {
    if (msg.role === 'system' && msg.content) {
      systemPrompt += normalizeMessageContent(msg.content) + '\n'
    }
  }
  systemPrompt += formatToolDefinitions(tools, { maxPromptChars, serverLabel })

  let conversation = ''
  for (const msg of messages || []) {
    if (msg.role === 'system') continue
    if (msg.role === 'user' && msg.content) {
      conversation += `User: ${normalizeMessageContent(msg.content)}\n\n`
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          conversation += `Assistant: TOOL_CALL: ${tc.function.name}\narguments: ${tc.function.arguments}\n\n`
        }
      } else if (msg.content) {
        conversation += `Assistant: ${normalizeMessageContent(msg.content)}\n\n`
      }
    } else if (msg.role === 'tool' && msg.content) {
      const toolContent = normalizeMessageContent(msg.content)
      conversation += `[Tool Result]\n${toolContent}\n\n`
    }
  }
  return { prompt: conversation.trim(), systemPrompt: systemPrompt.trim() }
}

/** True when the client already sent multi-turn history (skip recovery prefix). */
export function hasExplicitConversationHistory(messages) {
  const turns = (messages || []).filter((msg) => msg && msg.role !== 'system')
  return turns.length > 1 || turns.some((msg) => msg.role === 'assistant' || msg.role === 'tool')
}

export function buildRecoveryHistoryPrefix(history) {
  if (!Array.isArray(history) || history.length === 0) return ''
  let prefix = '[Previous conversation]\n'
  for (const exchange of history) {
    prefix += `User: ${String(exchange?.user || '')}\nAssistant: ${String(exchange?.assistant || '')}\n\n`
  }
  return prefix + '[Continue from here]\n\n'
}

export function truncatePromptMiddle(text, maxChars, headRatio = 0.35) {
  const value = String(text || '')
  if (value.length <= maxChars) return value
  if (maxChars <= 0) return ''
  if (maxChars <= PROMPT_COMPACTION_MARKER.length) return value.substring(value.length - maxChars)
  const payloadChars = maxChars - PROMPT_COMPACTION_MARKER.length
  const headChars = Math.max(0, Math.min(payloadChars, Math.floor(payloadChars * headRatio)))
  const tailChars = payloadChars - headChars
  return value.substring(0, headChars) + PROMPT_COMPACTION_MARKER + value.substring(value.length - tailChars)
}

/**
 * Bound the full prompt to `maxChars`. Preserves the start of system/task
 * instructions and the most recent tool loop, and prefers dropping the local
 * recovery-history prefix over client-provided turns.
 */
export function buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
  const system = String(systemPrompt || '').trim()
  const history = String(historyPrefix || '')
  const conversation = String(conversationPrompt || '').trim()
  const original = system ? `${system}\n\n${history}${conversation}` : `${history}${conversation}`
  const safeMax = Math.max(1, Math.floor(Number(maxChars) || MAX_UPSTREAM_PROMPT_CHARS))
  if (original.length <= safeMax) {
    return { prompt: original, compacted: false, historyDropped: false, originalChars: original.length, promptChars: original.length }
  }

  const historyDropped = history.length > 0
  const currentConversation = conversation
  const separatorLength = system && currentConversation ? 2 : 0
  let systemBudget = system ? Math.floor((safeMax - separatorLength) * 0.5) : 0
  let conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget)

  if (system.length < systemBudget) {
    systemBudget = system.length
    conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget)
  } else if (currentConversation.length < conversationBudget) {
    conversationBudget = currentConversation.length
    systemBudget = Math.max(0, safeMax - separatorLength - conversationBudget)
  }

  const boundedSystem = truncatePromptMiddle(system, systemBudget, 0.35)
  const boundedConversation = truncatePromptMiddle(currentConversation, conversationBudget, 0.25)
  let bounded = boundedSystem && boundedConversation
    ? `${boundedSystem}\n\n${boundedConversation}`
    : (boundedSystem || boundedConversation)
  if (bounded.length > safeMax) bounded = bounded.substring(0, safeMax)
  return {
    prompt: bounded,
    compacted: true,
    historyDropped,
    originalChars: original.length,
    promptChars: bounded.length,
  }
}

export function buildRetryPrompt(systemPrompt, historyPrefix, conversationPrompt, currentPrompt, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
  const retryBuild = buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars)
  const current = String(currentPrompt || '')
  return {
    ...retryBuild,
    compacted: retryBuild.compacted || retryBuild.prompt.length < current.length,
    originalChars: retryBuild.originalChars,
    promptChars: retryBuild.prompt.length,
    previousPromptChars: current.length,
  }
}

export function appendPromptInstruction(promptText, instruction, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
  const suffix = `\n\n${String(instruction || '').trim()}`
  const baseBudget = Math.max(0, maxChars - suffix.length)
  return truncatePromptMiddle(promptText, baseBudget, 0.35) + suffix
}

/** Detect upstream "context too long" errors (several locales). */
export function isContextTooLongError(error) {
  const message = typeof error === 'string'
    ? error
    : `${error?.content || ''} ${error?.message || ''} ${error?.finish_reason || ''} ${error?.type || ''}`
  return /(?:content|prompt|context).{0,40}(?:too\s+long|too\s+large|length|limit|maximum)|maximum.{0,30}(?:context|token)|too\s+many\s+tokens|содержани[ея]\s+слишком\s+длин|контекст.{0,30}(?:длин|лимит)|内容.{0,12}(?:过长|太长)|上下文.{0,12}(?:过长|超出)/i.test(message)
}
