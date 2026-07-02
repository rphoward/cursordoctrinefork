import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

const PROJECT_MARKERS = [
  '.git', '.hg', '.svn',
  'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json',
  'Makefile', 'CMakeLists.txt', '.project', 'tsconfig.json',
];

const HOOK_GENERATED_RE = /^(?:\s)*(FINAL REVIEW \((end of implementation|re-review)\)|SUBAGENT FINAL REVIEW|SELF-REVIEW|INTENT ANCHOR|INTENT REFINEMENT REQUIRED|SCOPE REMINDER|SCOPE[ :(]|VERIFY MILESTONE|DECOMPOSE|STEP 0 CONTRACT)/;
const EMBEDDED_ORIGINAL_RE = /ORIGINAL REQUEST[^\r\n]*\r?\n-{3,}\r?\n([\s\S]+?)\r?\n-{3,}/;
const USER_QUERY_RE = /<user_query>\s*([\s\S]+?)\s*<\/user_query>/;
const INTENT_TOPIC_THRESHOLD_DEFAULT = 0.34;
const USER_QUERY_MAX = 2000;

export function homeDir() {
  return process.env.CURSORDOCTRINE_HOME || homedir();
}

export function conversationId(obj) {
  let cid = '';
  if (obj && typeof obj === 'object' && typeof obj.conversation_id === 'string') cid = obj.conversation_id;
  if (!cid && obj && typeof obj.transcript_path === 'string' && obj.transcript_path) {
    const base = obj.transcript_path.split(/[\\/]/).pop() || '';
    cid = base.replace(/\.[^.]*$/, '');
  }
  cid = cid.replace(/[^\w-]/g, '');
  return cid || 'default';
}

export function readHookStdin() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  return raw.replace(/^\uFEFF/, '').trim();
}

export function readHookStdinJson() {
  const raw = readHookStdin();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function writeHookJson(obj) {
  process.stdout.write(JSON.stringify(obj ?? {}));
}

export function isMainModule(metaUrl) {
  try {
    return metaUrl === pathToFileURL(resolve(process.argv[1] || '')).href;
  } catch {
    return false;
  }
}

export function runHookMain(run, metaUrl, { parseStdin = readHookStdinJson } = {}) {
  if (!isMainModule(metaUrl)) return;
  let result = {};
  try {
    const payload = parseStdin();
    result = run(payload) ?? {};
  } catch {
    result = {};
  }
  writeHookJson(result);
  process.exit(0);
}

export function convertToFwdPath(p) {
  if (typeof p !== 'string' || p === '') return '';
  let s = p.trim();
  const driveMatch = s.match(/^\/([A-Za-z]):?(\/.*)$/);
  if (driveMatch) s = `${driveMatch[1]}:${driveMatch[2]}`;
  return s.replace(/\\/g, '/');
}

export function isPlanArtifactPath(path) {
  const p = convertToFwdPath(path);
  if (!p) return false;
  const rel = p.replace(/^\/+/, '').toLowerCase();
  return rel === '.cursor/plans' || rel.startsWith('.cursor/plans/');
}

function isWindowsDrive(p) {
  return /^[A-Za-z]:\//.test(p);
}

export function scopeRelativePath(path, root) {
  let p = convertToFwdPath(path);
  if (!p) return '';
  const rootFwd = convertToFwdPath(root).replace(/\/+$/, '');
  if (!rootFwd) return '';

  const isAbs = isWindowsDrive(p) || p.startsWith('/');
  if (isAbs) {
    const caseInsensitive = isWindowsDrive(p);
    const a = caseInsensitive ? p.toLowerCase() : p;
    const b = caseInsensitive ? rootFwd.toLowerCase() : rootFwd;
    if (a === b) return '';
    if (!a.startsWith(b + '/')) return '';
    p = p.slice(rootFwd.length + 1);
  }
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return '';
    out.push(part);
  }
  return out.join('/');
}

export function workspaceRoots(obj) {
  const roots = [];
  const push = (f) => {
    if (!f) return;
    const norm = f.replace(/\/+$/, '');
    if (norm && existsSync(norm) && !roots.includes(norm)) roots.push(norm);
  };
  if (obj && typeof obj.cwd === 'string') push(convertToFwdPath(obj.cwd));
  if (obj && Array.isArray(obj.workspace_roots)) {
    for (const w of obj.workspace_roots) push(convertToFwdPath(String(w)));
  }
  return roots;
}

export function isProjectRoot(dir) {
  for (const m of PROJECT_MARKERS) {
    if (existsSync(join(dir, m))) return true;
  }
  return false;
}

export function resolveProjectRoot(obj) {
  const cands = [];
  if (obj && typeof obj.cwd === 'string' && obj.cwd) cands.push(obj.cwd);
  if (obj && Array.isArray(obj.workspace_roots)) {
    for (const w of obj.workspace_roots) cands.push(String(w));
  }
  for (const c of cands) {
    const f = convertToFwdPath(c);
    if (f && existsSync(f)) return f.replace(/\/+$/, '');
  }
  if (process.env.CURSOR_PROJECT_DIR) {
    const cpd = process.env.CURSOR_PROJECT_DIR.replace(/\\/g, '/').replace(/\/+$/, '');
    if (existsSync(cpd)) return cpd;
  }
  const pwdFwd = process.cwd().replace(/\\/g, '/').replace(/\/+$/, '');
  if (pwdFwd && isProjectRoot(pwdFwd)) return pwdFwd;
  return '';
}

export function scopeRelativeAnyRoot(path, obj) {
  for (const root of workspaceRoots(obj)) {
    const rel = scopeRelativePath(path, root);
    if (rel) return rel;
  }
  const fallback = resolveProjectRoot(obj);
  if (fallback) return scopeRelativePath(path, fallback);
  return '';
}

export function isPlanModeEvent(obj) {
  if (!obj) return false;
  const modeKeys = ['composer_mode', 'composerMode', 'agent_mode', 'agentMode', 'cursor_mode', 'cursorMode', 'chat_mode', 'chatMode', 'mode'];
  for (const k of modeKeys) {
    if (obj[k]) {
      const v = String(obj[k]).trim().toLowerCase();
      if (/^(plan|planning|plan_mode|planning_mode)$/.test(v)) return true;
    }
  }
  for (const k of ['is_plan_mode', 'isPlanMode', 'planning']) {
    if (obj[k] === true) return true;
    if (obj[k] !== undefined && obj[k] !== null) {
      const v = String(obj[k]).trim().toLowerCase();
      if (v === 'true' || v === '1' || v === 'yes') return true;
    }
  }
  return false;
}

export function isPlanOnlyPrompt(text) {
  if (!text) return false;
  const implementation = /\b(implement|build|fix|edit|modify|change|patch|apply|code|ship|execute|wire|refactor|update|make this work|do it)\b/i;
  if (implementation.test(text)) return false;
  if (/<proposed_plan>/i.test(text)) return true;
  if (/\b(plan mode|planning mode)\b/i.test(text)) return true;
  if (/\b(write|draft|propose|produce|generate|outline|create|make)\b.{0,80}\b(plan|implementation plan|spec)\b/i.test(text)) return true;
  if (/\b(plan|spec)\b.{0,80}\b(only|first|before implementation|before coding)\b/i.test(text)) return true;
  return false;
}

export function expandAgentPaths(text) {
  if (!text) return text;
  return text.replace(/~\//g, `${homeDir().replace(/[\\/]+$/, '')}/`);
}

export function redactSecretsFromIntent(text) {
  if (!text) return text;
  return text
    .replace(/\bnpm_[A-Za-z0-9]{10,}\b/g, '[REDACTED_NPM_TOKEN]')
    .replace(/\b(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,})\b/g, '[REDACTED_TOKEN]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
}

export function isHookGeneratedQuery(text) {
  if (!text) return false;
  return HOOK_GENERATED_RE.test(text);
}

export function getEmbeddedOriginalRequest(text) {
  if (!text) return '';
  const m = EMBEDDED_ORIGINAL_RE.exec(text);
  return m ? m[1].trim() : '';
}

function getContentText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  let text = '';
  for (const part of content) {
    if (part && part.type === 'text' && part.text) text += part.text;
  }
  return text;
}

function truncate(s, max) {
  return s && s.length > max ? s.slice(0, max) + '...' : s;
}

export function getLastRawUserQueryText(obj) {
  return getLastUserQuery(obj, { includeHookGenerated: true });
}

export function getLastUserQuery(obj, { includeHookGenerated = false } = {}) {
  if (!obj || typeof obj.transcript_path !== 'string' || !obj.transcript_path) return '';
  const tp = obj.transcript_path;
  if (!existsSync(tp)) return '';
  let lines;
  try { lines = readFileSync(tp, 'utf8').split(/\r?\n/); } catch { return ''; }
  let embeddedFallback = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !/"role"\s*:\s*"user"/.test(line)) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || !rec.message) continue;
    const text = getContentText(rec.message.content);
    const m = USER_QUERY_RE.exec(text);
    if (!m) continue;
    const q = m[1].trim();
    if (includeHookGenerated) return q;
    if (isHookGeneratedQuery(q)) {
      if (!embeddedFallback) embeddedFallback = getEmbeddedOriginalRequest(q);
      continue;
    }
    return redactSecretsFromIntent(truncate(q, USER_QUERY_MAX));
  }
  if (embeddedFallback) return redactSecretsFromIntent(truncate(embeddedFallback, USER_QUERY_MAX));
  return '';
}

export function getLastVerdictFromText(text) {
  if (!text) return null;
  if (/\*\*Verdict\*\*:/.test(text)) return null;
  const stripped = text.replace(/```[\s\S]*?```/g, '');
  const candidates = [];
  const push = (verdict, step, diagnosis, index) => candidates.push({ index, verdict, step, diagnosis });

  for (const m of stripped.matchAll(/\b(ACCEPT|REVISE)\s+step\s+(\d+)(?:\s*[:\-]\s*(.+?))?(?=\s*$|\r?\n)/gim)) {
    push(m[1].toUpperCase(), Number(m[2]), m[3] ? m[3].trim() : '', m.index);
  }
  for (const m of stripped.matchAll(/\b(ACCEPTED|REVISED)\s+step\s+(\d+)(?:\s*[:\-]\s*(.+?))?(?=\s*$|\r?\n)/gim)) {
    const verb = m[1].toUpperCase();
    push(verb === 'ACCEPTED' ? 'ACCEPT' : 'REVISE', Number(m[2]), m[3] ? m[3].trim() : '', m.index);
  }
  for (const m of stripped.matchAll(/\bstep\s+(\d+)\s+(accepted|approved|done|complete[ds]?|looks good|good|ok|passes?|passed)\b/gi)) {
    push('ACCEPT', Number(m[1]), '', m.index);
  }
  for (const m of stripped.matchAll(/\bstep\s+(\d+)\s+(revise[ds]?|needs?\s+fix|fails?|failed|broken|reject(?:ed)?)\b/gi)) {
    push('REVISE', Number(m[1]), '', m.index);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.index - a.index);
  const last = candidates[0];
  return { verdict: last.verdict, step: last.step, diagnosis: last.diagnosis };
}

export function getLastVerdict(obj) {
  if (!obj || typeof obj.transcript_path !== 'string' || !obj.transcript_path) return null;
  const tp = obj.transcript_path;
  if (!existsSync(tp)) return null;
  let lines;
  try { lines = readFileSync(tp, 'utf8').split(/\r?\n/); } catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !/"role"\s*:\s*"assistant"/.test(line)) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec) continue;
    const msg = rec.message || rec;
    const text = getContentText(msg && msg.content);
    if (!text) continue;
    const v = getLastVerdictFromText(text);
    if (v) return v;
  }
  return null;
}

function promptTokenSet(p) {
  const normalized = p.toLowerCase().replace(/[^\p{L}\p{Nd} ]/gu, ' ');
  return new Set(normalized.split(/\s+/).filter(Boolean));
}

export function topicChanged(newPrompt, oldPrompt) {
  if (!oldPrompt || oldPrompt.trim() === '') return true;
  const newSet = promptTokenSet(newPrompt);
  const oldSet = promptTokenSet(oldPrompt);
  if (newSet.size < 3 || oldSet.size < 3) return false;
  let intersection = 0;
  for (const t of newSet) if (oldSet.has(t)) intersection++;
  let union = newSet.size;
  for (const t of oldSet) if (!newSet.has(t)) union++;
  if (union === 0) return false;
  const threshold = Number(process.env.INTENT_TOPIC_THRESHOLD) || INTENT_TOPIC_THRESHOLD_DEFAULT;
  return intersection / union < threshold;
}

export function gitSync(root, args) {
  const r = spawnSync('git', ['-C', root, '-c', 'core.quotepath=off', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return '';
  return r.stdout || '';
}

export function gitRevParseOk(root) {
  return gitSync(root, ['rev-parse', '--git-dir']).trim() !== '';
}

function findPython() {
  for (const c of process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']) {
    const r = spawnSync(c, ['-c', ''], { windowsHide: true, stdio: 'ignore' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

export function runMinimality(root, rels) {
  if (!root || !Array.isArray(rels) || rels.length === 0) return null;
  const py = findPython();
  if (!py) return null;
  const minPy = join(HOOKS_DIR, 'minimality.py');
  if (!existsSync(minPy)) return null;
  const r = spawnSync(py, [minPy, root, ...rels.slice(0, 20)], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.error) return null;
  for (const ln of (r.stdout || '').split(/\r?\n/)) {
    const m = ln.match(/^SUMMARY\t(-?[0-9.]+)\t(.*)\t(-?\d+)$/);
    if (m) {
      const worstRatio = Number.parseFloat(m[1]);
      const worstFile = m[2];
      const structDelta = Number.parseInt(m[3], 10);
      return { worstRatio, worstFile, structDelta };
    }
  }
  return null;
}
