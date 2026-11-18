// Typed upstream errors for the web-chat transports.
//
// The router's retry/cooldown/failover logic keys on `error.status`, optional
// `error.retryAfter` (seconds) and `error.type`. These factories produce exactly
// those fields so the plugin's existing recovery handles web-chat failures the
// same way it handles any other upstream, without a copied server framework.

export function createUpstreamHttpError(status, body = '', retryAfter = null) {
  const code = Number(status) || 502
  const detail = String(body || '').replace(/\s+/g, ' ').trim().substring(0, 300)
  const type = code === 429
    ? 'rate_limit_error'
    : ((code === 401 || code === 403) ? 'authentication_error' : 'upstream_http_error')
  const error = new Error(`Upstream HTTP ${code}${detail ? `: ${detail}` : ''}`)
  error.status = code
  error.type = type
  if (retryAfter) error.retryAfter = retryAfter
  return error
}

export function providerHttpError(status, message, type, retryAfter = null) {
  const error = new Error(message)
  error.status = Number(status) || 502
  error.type = type
  if (retryAfter != null) error.retryAfter = retryAfter
  return error
}

// Parse a Retry-After header value into a cooldown duration in ms, or null if
// absent/unparseable. Supports delta-seconds ("120") and HTTP-date forms.
export function parseRetryAfterMs(retryAfterRaw, now = Date.now()) {
  if (!retryAfterRaw) return null
  const raw = String(retryAfterRaw).trim()
  if (/^\d+$/.test(raw)) return Math.max(1000, Number(raw) * 1000)
  const t = Date.parse(raw)
  if (!Number.isNaN(t)) return Math.max(1000, t - now)
  return null
}

export function looksLikeHtml(body) {
  return /^\s*<(?:!doctype|html|head|body)/i.test(String(body || ''))
}

export function isRetryableStatus(status) {
  return [400, 404, 429, 500, 502, 503, 504].includes(Number(status))
}