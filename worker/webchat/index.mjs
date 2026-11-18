// Web-chat provider orchestrator.
//
// Glue between the router's forwardOnce seam and the DeepSeek/Qwen transports:
//  - builds the upstream prompt from the normalized request (system + tool
//    schema + turn transcript),
//  - decides the recovery-history prefix for fresh remote sessions,
//  - calls one transport turn,
//  - shapes the raw transport result into an OpenAI chat-completion message
//    (tool_calls parsed from plain-text tool markup, finish_reason mapped).
//
// Content-level recovery (empty retries, context overflow, continuation, tool
// markup repair) is layered on top of this in recovery.mjs.

import { formatMessages, hasExplicitConversationHistory, buildRecoveryHistoryPrefix, buildBoundedPrompt, MAX_UPSTREAM_PROMPT_CHARS } from './prompt.mjs'
import { looksLikeToolCallMarkup, parseToolCall, sanitizeContent } from './tools.mjs'

export function buildOpenAIChatMessage(result, model) {
  const message = { role: 'assistant', content: result.content }
  if (result.reasoning_content) message.reasoning_content = result.reasoning_content
  if (result.tool_calls && result.tool_calls.length) message.tool_calls = result.tool_calls
  if (result.finish_reason) message.finish_reason = result.finish_reason
  return { model, message, finish_reason: result.finish_reason || 'stop' }
}

export function createWebChatProvider(transport, { serverLabel = 'the local gateway', maxPromptChars = MAX_UPSTREAM_PROMPT_CHARS, now = () => Date.now() } = {}) {
  if (!transport || typeof transport.forwardOnce !== 'function') {
    throw new Error('createWebChatProvider requires a transport with forwardOnce()')
  }
  return {
    id: transport.id,
    displayName: transport.displayName,
    isConfigured: () => transport.isConfigured(),
    resolveModel: (model) => transport.resolveModel(model),
    listModels: () => transport.listModels(),

    /**
     * One completion turn. `session` is the router's session object (mutated by
     * the transport to advance the remote chat). `messages`/`tools` are the
     * normalized client request. Returns an OpenAI-shaped completion result.
     */
    async forwardOnce({ session, model, messages, tools, serverLabel: label, maxPromptChars: budget } = {}) {
      const sl = label || serverLabel
      const mc = budget || maxPromptChars
      const { systemPrompt, prompt: conversation } = formatMessages(messages, tools, { serverLabel: sl, maxPromptChars: mc })
      const hasHistory = hasExplicitConversationHistory(messages)
      const recoveryPrefix = (session.history && session.history.length && !hasHistory)
        ? buildRecoveryHistoryPrefix(session.history)
        : ''
      // Continued-session prompt: current turn only (remote session holds context).
      const continued = buildBoundedPrompt(systemPrompt, '', conversation, mc).prompt
      // Fresh-session prompt: same current turn, prefixed by local recovery
      // history so a new remote session reconstructs prior context.
      const fresh = buildBoundedPrompt(systemPrompt, recoveryPrefix, conversation, mc).prompt

      const raw = await transport.forwardOnce(session, { model, prompt: continued, freshPrompt: fresh })

      const content = sanitizeContent(raw.content)
      const reasoningContent = sanitizeContent(raw.reasoningContent)
      let finishReason = raw.finishReason || 'stop'
      let toolCalls = null
      if (looksLikeToolCallMarkup(content)) {
        const tc = parseToolCall(content)
        if (tc) {
          toolCalls = [{ id: `call_${Date.now()}`, type: 'function', function: { name: tc.name, arguments: tc.arguments } }]
          finishReason = 'tool_calls'
        }
      }
      return {
        content,
        reasoning_content: reasoningContent,
        finish_reason: finishReason,
        tool_calls: toolCalls,
        modelError: raw.modelError || null,
        sessionReset: Boolean(raw.sessionReset),
        promptUsed: raw.promptUsed,
      }
    },
  }
}