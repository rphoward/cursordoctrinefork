import { readHookStdin, writeHookJson, redactSecretsFromIntent, isMainModule } from './hook-common.mjs';

const CMD_ANCHOR = '(?:^|[;&|]\\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*';
const RM_DEST_PATH = '["\']?(/|~(/|["\']|\\s|$))';

const DENY_RULES = [
  {
    re: new RegExp(`${CMD_ANCHOR}(?:sudo\\s+)?rm\\s+([^;&|]*\\s)?-[a-zA-Z]*([rR][fF]|[fF][rR])[a-zA-Z]*(\\s+--\\S+)*\\s+${RM_DEST_PATH}`, 'm'),
    reason: 'destructive rm -rf on absolute or home path (use relative paths or be more specific)',
  },
  {
    re: new RegExp(`${CMD_ANCHOR}(?:sudo\\s+)?rm\\s+[^;&|]*-[a-zA-Z]*[rR][a-zA-Z]*\\s+[^;&|]*-[a-zA-Z]*[fF][a-zA-Z]*[^;&|]*\\s+${RM_DEST_PATH}`, 'm'),
    reason: 'destructive rm -rf on absolute or home path (separate -r/-f flags)',
  },
  {
    re: new RegExp(`${CMD_ANCHOR}(?:sudo\\s+)?rm\\s+[^;&|]*-[a-zA-Z]*[fF][a-zA-Z]*\\s+[^;&|]*-[a-zA-Z]*[rR][a-zA-Z]*[^;&|]*\\s+${RM_DEST_PATH}`, 'm'),
    reason: 'destructive rm -rf on absolute or home path (separate -f/-r flags)',
  },
  { re: /:\(\)\{\s*:\|:&\s*\};:|bash\s+-c\s+["']*:s*\(\)\{/, reason: 'reverse shell / fork-bomb pattern' },
  { re: /curl\s.*\|\s*(sudo(\s+-\S+)*\s+)?(bash|sh|zsh|dash|ash)/, reason: 'curl piped to shell' },
  { re: /wget\s.*\|\s*(sudo(\s+-\S+)*\s+)?(bash|sh|zsh|dash|ash)/, reason: 'wget piped to shell' },
  { re: /<\s*(curl|wget)\s/, reason: 'curl/wget via process substitution piped to shell' },
  { re: /git\s+push\s+.*--force(?!\-with\-lease)(\s|$)/, reason: 'git push --force (use --force-with-lease for the safe variant)' },
  { re: /git\s+push\s+["']?(-f|--force)(\s|["']|$)/, reason: 'git push -f / --force immediately after push' },
  { re: /git\s+push\b[^;&|]*\s["']?-f["']?(\s|["']|$|[;&|])/, reason: 'git push with -f flag (use --force-with-lease for the safe variant)' },
  { re: /git\s+reset\s+--hard/, reason: 'git reset --hard (data loss)' },
  { re: /git\s+clean\s+(?![^;&|]*(?:-n|--dry-run))[^;&|]*-[a-zA-Z]*f/, reason: 'git clean -f (untracked data loss)' },
  { re: /dd\s.*of=\/dev\/(sd|nvme|hd|xvd)/, reason: 'dd to block device' },
  { re: /mkfs(\.[a-z0-9]+)?\s+\/dev\//, reason: 'mkfs on device' },
  { re: /chmod\s+-R\s+777\s+\//, reason: 'chmod -R 777 on root' },
  { re: /chown\s+-R\s+[^\s]+\s+(--\s+)?\//, reason: 'chown -R on root' },
  {
    re: new RegExp(`${CMD_ANCHOR}(npm|pnpm|yarn)\\s+(-\\S+\\s+)*publish(?![^;&|]*--dry-run)(\\s|$)`, 'm'),
    reason: 'package publish (use ship-hook, not direct publish)',
  },
  { re: /\b(iwr|irm|curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(iex\b|Invoke-Expression)/, reason: 'web download piped to Invoke-Expression' },
  { re: /\b(Format-Volume|Clear-Disk)\b/, reason: 'disk format / clear (destructive)' },
];

const RM_VERB = '(?:^|[;&|]\\s*)(?:Remove-Item|rm|ri|del|erase|rd|rmdir)\\s';
const ROOT_PATH = '(?:^|[\\s"\'])(?:[A-Za-z]:[\\/]{0,2}|[A-Za-z]:[\\/](?:Users|Windows)[\\/]?|\\$(?:env:USERPROFILE|HOME)[\\/]?)["\']?\\s*(?:$|[;&|-])';
const RM_VERB_RE = new RegExp(RM_VERB);
const ROOT_PATH_RE = new RegExp(ROOT_PATH);

function extractCommand(inputText) {
  if (!inputText) return '';
  let cmd = '';
  try {
    const obj = JSON.parse(inputText);
    if (obj && typeof obj.command === 'string') cmd = obj.command;
  } catch { cmd = ''; }
  if (!cmd) {
    const m = inputText.match(/"command"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
    if (m) cmd = m[1].replace(/\\"/g, '"').replace(/\\\//g, '/');
  }
  if (!cmd && inputText && !/^\s*\{/.test(inputText)) cmd = inputText.trim();
  return cmd;
}

function buildDeny(reason, cmd) {
  let shown = cmd.length > 400 ? cmd.slice(0, 400) + '...' : cmd;
  shown = redactSecretsFromIntent(shown);
  const userMsg = `BLOCKED by permission-gate: ${reason}\n\nCommand: ${shown}\n\nIf this is genuinely intended, run it yourself in your terminal.`;
  return {
    permission: 'deny',
    user_message: userMsg,
    agent_message: `${userMsg} Do not retry verbatim. Ask the user to run it manually if it is truly intended.`,
  };
}

export function run(rawText) {
  if (process.env.HOOKS_ENFORCE === '0' || process.env.PERM_GATE_ENFORCE === '0') return { permission: 'allow' };

  const cmd = extractCommand(rawText);
  if (!cmd) return { permission: 'allow' };

  for (const rule of DENY_RULES) {
    if (rule.re.test(cmd)) return buildDeny(rule.reason, cmd);
  }

  if (RM_VERB_RE.test(cmd) && ROOT_PATH_RE.test(cmd) && /(?:-Recurse\b|\/s\b)/.test(cmd) && /(?:-Force\b|\/q\b)/.test(cmd)) {
    return buildDeny('recursive forced delete of a drive root / Users / Windows / profile root', cmd);
  }

  return { permission: 'allow' };
}

if (isMainModule(import.meta.url)) {
  const raw = readHookStdin();
  writeHookJson(run(raw));
}
