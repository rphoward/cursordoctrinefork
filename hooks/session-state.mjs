import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { conversationId, homeDir } from './hook-common.mjs';

const FILE_KINDS = {
  scope: { ext: 'txt' },
  'scope-sig': { ext: 'txt' },
  precompile: { ext: 'txt' },
  'session-start': { ext: 'txt' },
  'intent-anchored': { ext: 'flag' },
  decompose: { ext: 'flag' },
  reviewed: { ext: 'flag' },
};

const SWEEP_MAX_AGE_DAYS = 7;
const NUDGE_DEFAULT_CAP = 99999;

export function pendingDir() {
  return join(homeDir(), '.cursor', '.hooks-pending');
}

export function pendingPath(cid, key) {
  const kind = FILE_KINDS[key];
  if (!kind) throw new Error(`unknown session-state key: ${key}`);
  return join(pendingDir(), `${key}-${cid}.${kind.ext}`);
}

function ensurePendingDir() {
  mkdirSync(pendingDir(), { recursive: true });
}

export function stash(cid, key, content) {
  if (!cid) return;
  ensurePendingDir();
  try {
    writeFileSync(pendingPath(cid, key), content, 'utf8');
  } catch { /* best-effort: hooks fail open */ }
}

export function readStash(cid, key) {
  const p = pendingPath(cid, key);
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export function drain(cid, key) {
  const p = pendingPath(cid, key);
  if (!existsSync(p)) return '';
  try {
    const content = readFileSync(p, 'utf8');
    rmSync(p, { force: true });
    return content;
  } catch {
    return '';
  }
}

export function clearStash(cid, key) {
  if (!cid) return;
  rmSync(pendingPath(cid, key), { force: true });
}

export function readNudge(cid, key) {
  const raw = readStash(cid, key);
  if (!raw) return { lastCount: -1, nudgeCount: 0 };
  const parts = raw.trim().split(':');
  const lastCount = parts.length >= 1 && parts[0] !== '' ? Number(parts[0]) : -1;
  const nudgeCount = parts.length >= 2 && parts[1] !== '' ? Number(parts[1]) : 0;
  return { lastCount: Number.isFinite(lastCount) ? lastCount : -1, nudgeCount: Number.isFinite(nudgeCount) ? nudgeCount : 0 };
}

export function writeNudge(cid, key, filesCount, nudgeCount) {
  stash(cid, key, `${filesCount}:${nudgeCount}`);
}

export function throttle(cid, key, filesCount, cap) {
  const capVal = cap ?? NUDGE_DEFAULT_CAP;
  const { lastCount, nudgeCount } = readNudge(cid, key);
  const shouldNudge = (lastCount < 0 || filesCount > lastCount) && nudgeCount < capVal;
  if (shouldNudge) {
    writeNudge(cid, key, filesCount, nudgeCount + 1);
    return { shouldNudge: true, nudgeCount: nudgeCount + 1, lastCount };
  }
  return { shouldNudge: false, nudgeCount, lastCount };
}

export function resetTask(cid) {
  clearStash(cid, 'intent-anchored');
  clearStash(cid, 'decompose');
}

export function sweep() {
  const dir = pendingDir();
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - SWEEP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) rmSync(p, { force: true });
    } catch { /* raced */ }
  }
}

export function sessionStampPath(obj) {
  const cid = conversationId(obj);
  return pendingPath(cid, 'session-start');
}

export function writeSessionStartStamp(obj) {
  if (!obj) return;
  ensurePendingDir();
  try {
    writeFileSync(sessionStampPath(obj), new Date().toISOString().replace(/\.\d+Z$/, 'Z'), 'utf8');
  } catch { /* best-effort */ }
}

export function ensureSessionStartStamp(obj) {
  const p = sessionStampPath(obj);
  if (existsSync(p)) return;
  writeSessionStartStamp(obj);
}

export function getSessionStartUtc(obj) {
  const p = sessionStampPath(obj);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8').trim();
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms);
  } catch {
    return null;
  }
}

export function pathModifiedSinceSession(fullPath, obj) {
  const start = getSessionStartUtc(obj);
  if (!start) return false;
  if (!existsSync(fullPath)) return false;
  try {
    const st = statSync(fullPath);
    return Math.floor(st.mtimeMs / 1000) >= Math.floor(start.getTime() / 1000) - 1;
  } catch {
    return false;
  }
}

export function writeFinalReviewDebug(reason) {
  if (process.env.FINAL_REVIEW_DEBUG !== '1' || !reason) return;
  ensurePendingDir();
  try {
    const log = join(pendingDir(), 'last-final-review.log');
    const line = `${new Date().toISOString()} ${reason}\n`;
    const prev = existsSync(log) ? readFileSync(log, 'utf8') : '';
    writeFileSync(log, prev + line, 'utf8');
  } catch { /* best-effort */ }
}

export function reviewedFlagPath(obj) {
  return pendingPath(conversationId(obj), 'reviewed');
}
