// Content-level recovery for web-chat transports.
//
// HTTP-level failures (401/429/5xx) are handled by the router's own retry /
// cooldown / failover loop via synthetic error Responses. What the router
// cannot handle is a *successful* upstream turn that produced a useless result
// — an empty response, a context-overflow error, or malformed tool markup. That
// recovery lives here, wrapped around one createWebChatProvider instance so it
// runs inside a single forwardOnce call and keeps the router's response
// pipeline untouched.
//
// Ported from FreeDeepseekAPI's session/recovery behaviour (server.js) and
// adapted to the plugin's session store and prompt helpers.

import { isContextTooLongError } from './prompt.mjs'
import { looksLikeToolCallMarkup, parseToolCall } from './tools.mjs'

function isEmpty(result) {
  return Boolean(result)
    && !result.content
    && !result.tool_calls
    && !result.modelError
}

// Drop tool-call markup tags/legacy markers from a string that the parser could
// not turn into a valid tool call, so the client receives the plain text.
export function stripToolMarkup(text) {
  let out = String(text ?? '')
  out = out.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, '')
  out = out.replace(/<direct[^>]*>[\s\S]*?<\/direct>/gi, '')
  out = out.replace(/<invoke[^>]*>[\s\S]*?<\/invoke>/gi, '')
  // Remove any leftover unclosed structural tags (malformed markup).
  out = out.replace(/<\/?(?:tool_calls|invoke|direct|parameter)\b[^>]*>/gi, '')
  out = out.replace(/TOOL_CALL:\s*[\w-]+\s*(?:arguments:\s*(?:{[\s\S]*?}|.*?))?/gi, '')
  out = out.replace(/```(?:json)?[\s\S]*?```/g, '')
  out = out.replace(/[|｜]+\s*DSML\s*[|｜]+/gi, '')
  out = out.replace(/\s*\n{3,}/g, '\n\n').trim()
  return out
}

/**
 * Wrap a createWebChatProvider instance with content-level recovery.
 * @param {ReturnType<typeof import('./index.mjs').createWebChatProvider>} webchat
 * @param {object} [opts]
 * @param {number} [opts.maxEmptyRetries]
 * @param {(msg: string) => void} [opts.log]
 */
export function createRecoveredWebChat(webchat, { maxEmptyRetries = 2, log = () => {} } = {}) {
  return {
    ...webchat,
    async forwardOnce({ session, model, messages, tools, ...rest } = {}) {
      let result = await webchat.forwardOnce({ session, model, messages, tools, ...rest })

      // 1) Empty-response retries. A stuck remote continuation can return an
      // empty turn; forcing a fresh remote session (which re-injects local
      // recovery history) usually escapes it.
      let emptyTries = 0
      while (isEmpty(result) && emptyTries < maxEmptyRetries) {
        emptyTries++
        log(`[recovery] empty response, retrying ${emptyTries}/${maxEmptyRetries}`)
        if (session?.id) { session.id = null; session.parentMessageId = null }
        result = await webchat.forwardOnce({ session, model, messages, tools, ...rest })
      }

      // 2) Context overflow. The remote session ran out of window; reset it and
      // retry once with the recovery (bounded) prompt the orchestrator builds.
      if (result?.modelError && isContextTooLongError(result.modelError)) {
        log('[recovery] context too long; resetting remote session and retrying')
        if (session) { session.id = null; session.parentMessageId = null }
        result = await webchat.forwardOnce({ session, model, messages, tools, ...rest })
      }

      // 3) Tool-markup repair. Markup the parser could not turn into a real
      // tool call becomes plain text instead of leaking raw tags to the client.
      if (result && looksLikeToolCallMarkup(result.content) && !result.tool_calls) {
        log('[recovery] malformed tool markup; stripping to plain text')
        result = {
          ...result,
          content: stripToolMarkup(result.content),
          tool_calls: null,
          finish_reason: 'stop',
        }
      }
      return result
    },
  }
}
