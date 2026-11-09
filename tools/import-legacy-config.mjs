#!/usr/bin/env node
// Standalone converter: import configs from Claude Code Router and/or OmniRoute
// (JSON backups or SQLite databases) into this router's config + secrets.
//
// Usage:
//   node tools/import-legacy-config.mjs                    # Auto-detects CCR, OmniRoute, or both
//   node tools/import-legacy-config.mjs <path>             # Auto-detects format of file at <path>
//   node tools/import-legacy-config.mjs --both             # Imports and merges both local routers
//   node tools/import-legacy-config.mjs --ccr <path>       # Explicit Claude Code Router path
//   node tools/import-legacy-config.mjs --omni <path>      # Explicit OmniRoute path
//   node tools/import-legacy-config.mjs [--out-dir <dir>]  # Output directory (default: .)
//   node tools/import-legacy-config.mjs [--key <secret>]   # OmniRoute decryption key override
//
// Output files:
//   router.config.json  -> paste into the plugin's "Import and export" card
//   router.secrets.json -> add keys to Orca's secret store or provider cards

import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  detectAndConvertConfig,
  detectLocalRouterConfigs,
  mergeRouterConfigs
} from '../worker/sidecar.mjs'

const args = process.argv.slice(2)
let outDir = '.'
let ccrPath = ''
let omniPath = ''
let encryptionKey = ''
let both = false
let positional = ''

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--out-dir' && args[i + 1]) {
    outDir = args[++i]
  } else if (arg === '--ccr' && args[i + 1]) {
    ccrPath = args[++i]
  } else if (arg === '--omni' && args[i + 1]) {
    omniPath = args[++i]
  } else if (arg === '--key' && args[i + 1]) {
    encryptionKey = args[++i]
  } else if (arg === '--both') {
    both = true
  } else if (!arg.startsWith('-') && !positional) {
    positional = arg
  }
}

const detected = detectLocalRouterConfigs()

let converted = null
let sourceDescription = ''

if (both || (!positional && !ccrPath && !omniPath && detected.ccr && detected.omniroute)) {
  console.log('Detected both Claude Code Router and OmniRoute installations:')
  console.log(`  • Claude Code Router: ${detected.ccr.path} (${detected.ccr.providers ?? 0} providers, ${detected.ccr.keys ?? 0} keys)`)
  console.log(`  • OmniRoute:          ${detected.omniroute.path} (${detected.omniroute.aliases ?? 0} aliases, ${detected.omniroute.connections ?? 0} connections)`)

  const ccrTarget = ccrPath || detected.ccr?.path
  const omniTarget = omniPath || detected.omniroute?.path

  const ccrResult = ccrTarget ? detectAndConvertConfig(ccrTarget) : null
  const omniResult = omniTarget ? detectAndConvertConfig(omniTarget, { encryptionKey }) : null

  if (ccrResult && omniResult) {
    const merged = mergeRouterConfigs(ccrResult.config, omniResult.config, ccrResult.secrets, omniResult.secrets)
    converted = { config: merged.config, secrets: merged.secrets }
    sourceDescription = 'both Claude Code Router and OmniRoute'
  } else if (ccrResult) {
    converted = ccrResult
    sourceDescription = 'Claude Code Router'
  } else if (omniResult) {
    converted = omniResult
    sourceDescription = 'OmniRoute'
  }
} else if (ccrPath) {
  if (!existsSync(ccrPath)) {
    console.error(`Claude Code Router path not found: ${ccrPath}`)
    process.exit(1)
  }
  converted = detectAndConvertConfig(ccrPath)
  sourceDescription = `Claude Code Router (${ccrPath})`
} else if (omniPath) {
  if (!existsSync(omniPath)) {
    console.error(`OmniRoute path not found: ${omniPath}`)
    process.exit(1)
  }
  converted = detectAndConvertConfig(omniPath, { encryptionKey })
  sourceDescription = `OmniRoute (${omniPath})`
} else if (positional) {
  if (!existsSync(positional)) {
    console.error(`Input file not found: ${positional}`)
    process.exit(1)
  }
  converted = detectAndConvertConfig(positional, { encryptionKey })
  sourceDescription = `${converted.type.toUpperCase()} (${positional})`
} else if (detected.ccr) {
  console.log(`Auto-detected Claude Code Router at ${detected.ccr.path}`)
  converted = detectAndConvertConfig(detected.ccr.path)
  sourceDescription = 'Claude Code Router'
} else if (detected.omniroute) {
  console.log(`Auto-detected OmniRoute at ${detected.omniroute.path}`)
  converted = detectAndConvertConfig(detected.omniroute.path, { encryptionKey })
  sourceDescription = 'OmniRoute'
} else {
  console.error('No configuration found. Provide a path or ensure ~/.claude-code-router or ~/.omniroute exists.')
  console.error('Usage: node tools/import-legacy-config.mjs [path] [--both] [--ccr <path>] [--omni <path>] [--out-dir <dir>]')
  process.exit(1)
}

const { config, secrets } = converted
mkdirSync(outDir, { recursive: true })
const configPath = join(outDir, 'router.config.json')
const secretsPath = join(outDir, 'router.secrets.json')

writeFileSync(configPath, JSON.stringify(config, null, 2))
writeFileSync(secretsPath, JSON.stringify(secrets, null, 2))

const aliasCount = Object.keys(config.aliases || {}).length
const ruleCount = (config.routes || []).length
const keyCount = (config.clientKeys || []).length
const profileCount = (config.agentProfiles || []).length

console.log(`\nSuccessfully converted from ${sourceDescription}:`)
console.log(`  • Providers:      ${config.providers.length}`)
console.log(`  • Aliases:        ${aliasCount}`)
console.log(`  • Routing Rules:  ${ruleCount}`)
console.log(`  • Client Keys:    ${keyCount}`)
console.log(`  • Agent Profiles: ${profileCount}`)
console.log(`  • Secrets:        ${secrets.length}`)
console.log(`\nWrote:`)
console.log(`  ${configPath}`)
console.log(`  ${secretsPath}`)
console.log('\nNext steps:')
console.log('1. In Orca LLM Router, navigate to the "Import and export" tab and paste router.config.json (or import directly from the panel).')
console.log('2. Secret values are in router.secrets.json to add into Orca secrets or provider cards.')
