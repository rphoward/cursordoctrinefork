import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const PENDING_EXTS = {
  scope: 'txt',
  'scope-sig': 'txt',
  precompile: 'txt',
  'session-start': 'txt',
  'intent-anchored': 'flag',
  decompose: 'flag',
  reviewed: 'flag',
};

export function hookPath(ctx, name) {
  return join(ctx.hooksDst, `${name}.mjs`);
}

export function runHook(ctx, name, payload) {
  return ctx.runHook(hookPath(ctx, name), payload);
}

export function parseOut(out) {
  try { return JSON.parse(out); } catch { return null; }
}

export function assertAllow(out) {
  const o = parseOut(out);
  return !!o && o.permission === 'allow';
}

export function assertDeny(out) {
  const o = parseOut(out);
  return !!o && o.permission === 'deny';
}

export function hasContext(out) {
  return /"additional_context"\s*:/.test(out);
}

export function hasFollowup(out) {
  return /"followup_message"\s*:/.test(out);
}

export function fail(detail) {
  return { ok: false, detail };
}

export function pass() {
  return true;
}

export function withRepo(ctx, name, fn) {
  const dir = join(ctx.HOME, name);
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function withScope(ctx, name, scopeObj, fn) {
  return withRepo(ctx, name, (dir) => {
    writeScope(dir, scopeObj);
    return fn(dir, join(dir, '.scope.json'));
  });
}

export function withGitRepo(ctx, name, opts, fn) {
  const { seed = {} } = opts || {};
  return withRepo(ctx, name, (dir) => {
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'v', GIT_AUTHOR_EMAIL: 'a@b.c',
      GIT_COMMITTER_NAME: 'v', GIT_COMMITTER_EMAIL: 'a@b.c',
    };
    const git = (args) => spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8', windowsHide: true, env: gitEnv,
    });
    if (git(['init', '-q']).status !== 0) throw new Error('git init failed');
    for (const [rel, content] of Object.entries(seed)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    if (Object.keys(seed).length > 0) {
      git(['add', '.']);
      if (git(['commit', '-q', '-m', 'init']).status !== 0) throw new Error('git commit failed');
    }
    return fn(dir, git);
  });
}

export function writeScope(dir, scope) {
  writeFileSync(join(dir, '.scope.json'), JSON.stringify(scope), 'utf8');
}

export function readScope(dir) {
  return JSON.parse(readFileSync(join(dir, '.scope.json'), 'utf8'));
}

export function pendingFile(ctx, cid, key) {
  const ext = PENDING_EXTS[key] ?? 'txt';
  return join(ctx.pendingDir, `${key}-${cid}.${ext}`);
}

export function rmPending(ctx, cid, key) {
  rmSync(pendingFile(ctx, cid, key), { force: true });
}

export function writeTranscript(ctx, cid, records) {
  const path = join(ctx.pendingDir, `transcript-${cid}.jsonl`);
  mkdirSync(ctx.pendingDir, { recursive: true });
  const lines = records.map((r) => JSON.stringify(r));
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

export function stampSession(ctx, cid) {
  mkdirSync(ctx.pendingDir, { recursive: true });
  writeFileSync(pendingFile(ctx, cid, 'session-start'), new Date().toISOString(), 'utf8');
}

export function defaultAcceptance() {
  return 'Biome --error-on-warnings + Semgrep --config auto --error pass clean; typecheck/build passes; the described problem no longer reproduces.';
}
