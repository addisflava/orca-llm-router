// Orca's launchable coding agents, mirrored from the host's TUI agent registry
// (tui-agent-config / tui-agent-display-names). The plugin never configures an
// agent's model or environment — it only decides whether an Orca-launched agent
// is pointed at the local gateway. `commands` is what Orca probes on PATH to
// decide an agent is installed; `requires` lists extra commands that must also
// exist. Keep ids identical to Orca's `agent.launch.before` payload.
export const ORCA_AGENTS = [
  { id: 'claude', name: 'Claude', commands: ['claude'] },
  { id: 'claude-agent-teams', name: 'Claude Agent Teams', commands: ['orca'], requires: ['claude'] },
  { id: 'codebuddy', name: 'CodeBuddy', commands: ['codebuddy', 'cbc'] },
  { id: 'openclaude', name: 'OpenClaude', commands: ['openclaude'] },
  { id: 'codex', name: 'Codex', commands: ['codex'] },
  { id: 'devin', name: 'Devin', commands: ['devin'] },
  { id: 'ante', name: 'Ante', commands: ['ante'] },
  { id: 'trae', name: 'Trae', commands: ['traecli'] },
  { id: 'muse', name: 'Muse', commands: ['muse'] },
  { id: 'dsh', name: 'DeepSeek Harness', commands: ['dsh-tui', 'dst'], requires: ['dsh'] },
  { id: 'zcode', name: 'ZCode', commands: ['zcode'] },
  { id: 'autohand', name: 'Autohand Code', commands: ['autohand'] },
  { id: 'opencode', name: 'OpenCode', commands: ['opencode'] },
  { id: 'opencode2', name: 'OpenCode 2', commands: ['opencode2'] },
  { id: 'mimo-code', name: 'MiMo Code', commands: ['mimo'] },
  { id: 'pi', name: 'Pi', commands: ['pi'] },
  { id: 'omp', name: 'OMP', commands: ['omp'] },
  { id: 'prime-agent', name: 'Prime Agent', commands: ['prime-agent'] },
  { id: 'qoder', name: 'Qoder CLI', commands: ['qodercli', 'qoder'] },
  { id: 'qoder-cn', name: 'Qoder CLI China', commands: ['qoderclicn', 'qodercn'] },
  { id: 'gemini', name: 'Gemini', commands: ['gemini'] },
  { id: 'antigravity', name: 'Antigravity', commands: ['agy'] },
  { id: 'aider', name: 'Aider', commands: ['aider'] },
  { id: 'goose', name: 'Goose', commands: ['goose'] },
  { id: 'amp', name: 'Amp', commands: ['amp'] },
  { id: 'kilo', name: 'Kilocode', commands: ['kilo'] },
  { id: 'kiro', name: 'Kiro', commands: ['kiro-cli'] },
  { id: 'crush', name: 'Charm', commands: ['crush'] },
  { id: 'aug', name: 'Auggie', commands: ['auggie'] },
  { id: 'cline', name: 'Cline', commands: ['cline'] },
  { id: 'codebuff', name: 'Codebuff', commands: ['codebuff'] },
  { id: 'freebuff', name: 'Freebuff', commands: ['freebuff'] },
  { id: 'command-code', name: 'Command Code', commands: ['command-code'] },
  { id: 'continue', name: 'Continue', commands: ['cn'] },
  { id: 'cursor', name: 'Cursor', commands: ['cursor-agent'] },
  { id: 'droid', name: 'Droid', commands: ['droid'] },
  { id: 'kimi', name: 'Kimi', commands: ['kimi', 'kimi-code'] },
  { id: 'mistral-vibe', name: 'Mistral Vibe', commands: ['vibe', 'mistral-vibe'] },
  { id: 'qwen-code', name: 'Qwen Code', commands: ['qwen'] },
  { id: 'rovo', name: 'Rovo Dev', commands: ['acli'] },
  { id: 'hermes', name: 'Hermes', commands: ['hermes'] },
  { id: 'openclaw', name: 'OpenClaw', commands: ['openclaw'] },
  { id: 'copilot', name: 'GitHub Copilot', commands: ['copilot'] },
  { id: 'grok', name: 'Grok', commands: ['grok'] },
  { id: 'jcode', name: 'Jcode', commands: ['jcode'] }
]

const AGENT_BY_ID = new Map(ORCA_AGENTS.map((agent) => [agent.id, agent]))

export function orcaAgentName(id) {
  return AGENT_BY_ID.get(id)?.name ?? id
}
