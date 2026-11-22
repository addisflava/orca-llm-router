// Some agents build their model picker from an OpenAI-style /v1/models response
// but reject ids that do not look like Claude models. Claude Code's gateway
// discovery, for example, keeps only ids matching /claude|anthropic/i after
// fetching ANTHROPIC_BASE_URL/v1/models. CCR works around this by advertising a
// synthetic `anthropic/claude-ccr-h<hex>` id whose display_name is the real model
// id, and decoding the hex back at request time. We use the same trick with our
// own prefix so both routers can coexist on one machine.

const PREFIX = 'anthropic/claude-orca-h'
const ID_PATTERN = /^anthropic\/claude-orca-h([0-9a-f]+)$/

/** Advertise a real model id under a Claude-looking id Claude Code will accept. */
export function syntheticModelId(realId) {
  return `${PREFIX}${Buffer.from(String(realId), 'utf8').toString('hex')}`
}

/** Decode a synthetic id back to the real router model, or return the input. */
export function decodeSyntheticModelId(value) {
  if (typeof value !== 'string') return value
  const match = ID_PATTERN.exec(value.trim())
  if (!match || match[1].length % 2 !== 0) return value
  try {
    const real = Buffer.from(match[1], 'hex').toString('utf8').trim()
    return real || value
  } catch {
    return value
  }
}

/**
 * Build the model list Claude Code discovery expects. Every router model is
 * advertised under a synthetic id with `display_name` set to the real id, so
 * the picker shows the entire router catalog rather than just the models whose
 * names happen to contain "claude" or "anthropic".
 */
export function claudeGatewayModels(catalog) {
  const seen = new Set()
  const data = []
  for (const model of catalog?.data ?? []) {
    const id = String(model?.id ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    data.push({
      id: syntheticModelId(id),
      object: 'model',
      owned_by: 'orca-router',
      display_name: id,
      ...(model.description ? { description: model.description } : {}),
      ...(model.context_length ? { context_length: model.context_length } : {}),
      ...(model.max_output_tokens ? { max_output_tokens: model.max_output_tokens } : {})
    })
  }
  return { object: 'list', data }
}
