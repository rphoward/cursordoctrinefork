import { closeSync, openSync, rmSync, statSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { isPlanArtifactPath, scopeRelativePath } from './hook-common.mjs';

export const DEFAULT_ACCEPTANCE =
  'Biome --error-on-warnings + Semgrep --config auto --error pass clean; typecheck/build passes; the described problem no longer reproduces.';

export const SCOPE_FIELDS = ['prompt', 'intent', 'decomposition', 'verifications', 'files', 'acceptance'];

const LOCK_STALE_SECONDS = 10;
const LOCK_ATTEMPTS = 10;
const LOCK_RETRY_MS = 50;

function sleepMs(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { /* busy-wait: hook-local, sub-second */ }
}

function reapStaleLock(lockPath) {
  try {
    const st = statSync(lockPath);
    if (Date.now() / 1000 - st.mtimeMs / 1000 > LOCK_STALE_SECONDS) rmSync(lockPath, { force: true });
  } catch { /* not present */ }
}

function acquireLock(lockPath) {
  reapStaleLock(lockPath);
  for (let i = 0; i < LOCK_ATTEMPTS; i++) {
    try {
      return openSync(lockPath, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      sleepMs(LOCK_RETRY_MS);
    }
  }
  return null;
}

function releaseLock(fd, lockPath) {
  try { closeSync(fd); } catch { /* already closed */ }
  rmSync(lockPath, { force: true });
}

export function withScopeLock(path, fn) {
  const lockPath = `${path}.lock`;
  const fd = acquireLock(lockPath);
  if (fd === null) return null;
  try {
    return fn();
  } finally {
    releaseLock(fd, lockPath);
  }
}

export function readScope(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeScopeAtomic(path, content) {
  if (!path || !content) return false;
  return withScopeLock(path, () => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    try {
      renameSync(tmp, path);
      return true;
    } catch {
      rmSync(tmp, { force: true });
      return false;
    }
  }) ?? false;
}

export function updateScope(path, transform) {
  if (!path || !existsSync(path)) return false;
  return withScopeLock(path, () => {
    const scope = readScope(path);
    if (!scope) return false;
    const next = transform(scope) ?? scope;
    const json = JSON.stringify(next);
    if (!json) return false;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, json, 'utf8');
    try {
      renameSync(tmp, path);
      return true;
    } catch {
      rmSync(tmp, { force: true });
      return false;
    }
  }) ?? false;
}

export function isPlaceholderFile(entry) {
  const s = typeof entry === 'string' ? entry : '';
  if (!s || s.trim() === '') return true;
  if (/^\s*<TODO/.test(s)) return true;
  if (s.trim().toLowerCase() === '.scope.json') return true;
  return false;
}

export function realFiles(files) {
  return (Array.isArray(files) ? files : []).filter((f) => !isPlaceholderFile(f));
}

export function intentNeedsStep0(intent) {
  const s = typeof intent === 'string' ? intent.trim() : '';
  return s === '' || /^\[DRAFT\]/.test(s);
}

export function acceptanceIsDefault(acceptance) {
  const s = typeof acceptance === 'string' ? acceptance : '';
  return s.trim() === '' || s === DEFAULT_ACCEPTANCE;
}

export function resetScope(prompt) {
  return {
    prompt,
    intent: '',
    decomposition: [],
    verifications: [],
    files: [],
    acceptance: DEFAULT_ACCEPTANCE,
  };
}

export function continuationScope(existing, prompt) {
  const next = { prompt };
  for (const key of Object.keys(existing)) {
    if (key === 'prompt' || key.startsWith('_')) continue;
    if (key === 'trace' || key === 'allow_growth') continue;
    next[key] = existing[key];
  }
  if (typeof next.intent !== 'string') next.intent = '';
  if (!Array.isArray(next.decomposition)) next.decomposition = [];
  if (!Array.isArray(next.verifications)) next.verifications = [];
  if (!Array.isArray(next.files)) next.files = [];
  if (typeof next.acceptance !== 'string') next.acceptance = '';
  return next;
}

export function mergeFiles(existing, newPaths, root) {
  const kept = [];
  for (const e of Array.isArray(existing) ? existing : []) {
    const s = typeof e === 'string' ? e : '';
    if (isPlaceholderFile(s)) continue;
    if (isPlanArtifactPath(s)) continue;
    kept.push(s);
  }
  let appended = false;
  for (const p of Array.isArray(newPaths) ? newPaths : []) {
    const rel = scopeRelativePath(String(p), root);
    if (!rel || rel.toLowerCase() === '.scope.json') continue;
    if (isPlanArtifactPath(rel)) continue;
    const already = kept.some((f) => String(f).replace(/\\/g, '/').replace(/^\//, '').toLowerCase() === rel.toLowerCase());
    if (!already) {
      kept.push(rel);
      appended = true;
    }
  }
  let changed = appended;
  if (!changed) {
    const ex = Array.isArray(existing) ? existing : [];
    if (kept.length !== ex.length) changed = true;
    else {
      for (let i = 0; i < kept.length; i++) {
        if (String(kept[i]) !== String(ex[i])) { changed = true; break; }
      }
    }
  }
  return { files: kept, appended, changed };
}

export function recordFiles(path, newPaths, root) {
  const scope = readScope(path);
  if (!scope) return { appended: false, changed: false, files: [] };
  const merged = mergeFiles(scope.files || [], newPaths, root);
  if (merged.changed) {
    updateScope(path, (s) => { s.files = merged.files; return s; });
  }
  return merged;
}

export function setVerdict(path, entry) {
  updateScope(path, (s) => {
    const verifs = Array.isArray(s.verifications) ? s.verifications : [];
    const out = [];
    let replaced = false;
    for (const v of verifs) {
      if (v && Number(v.step) === Number(entry.step)) {
        out.push(entry);
        replaced = true;
      } else {
        out.push(v);
      }
    }
    if (!replaced) out.push(entry);
    s.verifications = out;
    return s;
  });
}

export function verdictsByStep(verifications) {
  const byStep = {};
  for (const v of Array.isArray(verifications) ? verifications : []) {
    if (v && v.step !== undefined && v.verdict !== undefined) {
      byStep[Number(v.step)] = String(v.verdict);
    }
  }
  return byStep;
}

export function contractSignature(scope) {
  const intent = typeof scope.intent === 'string' ? scope.intent : '';
  const acceptance = typeof scope.acceptance === 'string' ? scope.acceptance : '';
  return `${intent}|${acceptance}`;
}

export function scopePathFor(root) {
  if (!root) return '';
  return root.replace(/\\/g, '/').replace(/\/$/, '') + '/.scope.json';
}
