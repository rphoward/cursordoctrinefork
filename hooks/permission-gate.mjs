#!/usr/bin/env node

const DENY_RE = /\b(rm\s+-rf\s+\/|curl\s*\|\s*(bash|sh|zsh|fish|powershell|pwsh)|wget\s*\|\s*(bash|sh|zsh|fish)|git\s+push\s+--force|git\s+push\s+-f|git\s+reset\s+--hard|git\s+clean\s+-fd|npm\s+publish|pnpm\s+publish|yarn\s+publish|npx\s+.*\s+publish|dd\s+.*\s+\/dev\/(zero|random|urandom)|mkfs\.|chmod\s+-R\s+\/|chown\s+-R\s+\/)\b/i;

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function decision(command) {
  if (!command) return 'allow';
  if (DENY_RE.test(command)) return 'deny';
  return 'allow';
}

(async () => {
  if (process.env.PERM_GATE_ENFORCE === '0') {
    console.log(JSON.stringify({ permission: 'allow' }, null, 2));
    return;
  }

  const payload = await readInput();
  const command = (payload.command || payload.shell?.command || '').trim();
  const result = decision(command);

  if (result === 'allow') {
    console.log(JSON.stringify({ permission: 'allow' }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    permission: 'deny',
    user_message: 'Blocked shell command: `' + command + '`.',
    agent_message: 'Blocked shell command: `' + command + '`.'
  }, null, 2));
})();
