#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

const HOME = process.env.CURSORDOCTRINE_HOME || homedir();
const hooksSrc = join(pkgRoot, 'hooks');
const hooksJsonSrc = join(pkgRoot, 'hooks.json');
const hooksDst = join(HOME, '.agents', 'hooks');
const cursorDst = join(HOME, '.cursor');
const hooksJsonDst = join(cursorDst, 'hooks.json');
const pendingDir = join(cursorDst, '.hooks-pending');

function rmBestEffort(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function install() {
  console.log(`cursordoctrine ${pkg.version} — installing into ${HOME}`);

  mkdirSync(hooksDst, { recursive: true });
  mkdirSync(cursorDst, { recursive: true });
  rmBestEffort(pendingDir);

  cpSync(hooksSrc, hooksDst, {
    recursive: true,
    filter: (src) => !src.includes('__pycache__'),
  });

  writeFileSync(hooksJsonDst, JSON.stringify({ ...JSON.parse(readFileSync(hooksJsonSrc, 'utf8')) }, null, 2) + '\n');

  const hookFiles = readdirSync(hooksDst);
  console.log(`  copied ${hookFiles.length} files to ~/.agents/hooks`);
  console.log('  wrote ~/.cursor/hooks.json');
  console.log('Done. Restart Cursor. Next: npx cursordoctrine verify');
}

function uninstall() {
  console.log(`cursordoctrine ${pkg.version} — removing from ${HOME}`);
  const removed = [];
  const shipped = readdirSync(hooksSrc).filter((f) => !f.startsWith('__pycache__'));
  for (const f of shipped) {
    const p = join(hooksDst, f);
    if (existsSync(p)) { rmSync(p, { force: true }); removed.push(`~/.agents/hooks/${f}`); }
  }
  rmBestEffort(pendingDir);
  if (existsSync(hooksJsonDst)) {
    rmSync(hooksJsonDst, { force: true });
    removed.push('~/.cursor/hooks.json');
  }
  for (const r of removed) console.log(`  removed ${r}`);
  if (!removed.length) console.log('  nothing to remove.');
  console.log('Done. Restart Cursor.');
}

function runHook(file, payloadObj) {
  const r = spawnSync('node', [file], {
    input: JSON.stringify(payloadObj),
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    env: { ...process.env, HOME, USERPROFILE: HOME },
  });
  if (r.error) return '';
  return `${r.stdout || ''}${r.stderr || ''}`.trim();
}

function verify() {
  console.log(`cursordoctrine ${pkg.version} — verifying hook pack (source: hooks/)`);
  console.log('');

  const scopePath = join(pkgRoot, '.scope.json');
  const scopeBackup = existsSync(scopePath) ? readFileSync(scopePath, 'utf8') : null;

  const checks = [
    {
      name: 'inject-doctrine-injects-content',
      run() {
        const r = runHook(join(hooksSrc, 'inject-doctrine.mjs'), {});
        const json = JSON.parse(r || '{}');
        return json.additional_context ? 'ok' : false;
      }
    },
    {
      name: 'step0-gate-allows-reads',
      run() {
        const r = runHook(join(hooksSrc, 'step0-gate.mjs'), { tool_name: 'Read', cwd: pkgRoot });
        const json = JSON.parse(r || '{}');
        return json.permission === 'allow' ? 'ok' : false;
      }
    },
    {
      name: 'step0-gate-denies-write-without-intent',
      run() {
        writeFileSync(scopePath, JSON.stringify({ intent: '', decomposition: [], files: [] }, null, 2) + '\n');
        const r = runHook(join(hooksSrc, 'step0-gate.mjs'), {
          tool_name: 'Write',
          file_path: join(pkgRoot, 'probe.txt'),
          cwd: pkgRoot,
        });
        const json = JSON.parse(r || '{}');
        return json.permission === 'deny' ? 'ok' : false;
      }
    },
    {
      name: 'permission-gate-denies-force-push',
      run() {
        const r = runHook(join(hooksSrc, 'permission-gate.mjs'), { command: 'git push --force' });
        const json = JSON.parse(r || '{}');
        return json.permission === 'deny' ? 'ok' : false;
      }
    },
    {
      name: 'permission-gate-allows-status',
      run() {
        const r = runHook(join(hooksSrc, 'permission-gate.mjs'), { command: 'git status' });
        const json = JSON.parse(r || '{}');
        return json.permission === 'allow' ? 'ok' : false;
      }
    },
    {
      name: 'final-review-emits-followup-on-completed',
      run() {
        const r = runHook(join(hooksSrc, 'final-review.mjs'), { status: 'completed', cwd: pkgRoot });
        const json = JSON.parse(r || '{}');
        return typeof json.followup_message === 'string' && json.followup_message.includes('FINAL REVIEW') ? 'ok' : false;
      }
    },
  ];

  let passed = 0;
  let failed = 0;
  for (const c of checks) {
    try {
      const ok = c.run() === 'ok';
      console.log(`  ${ok ? ' ok ' : 'FAIL'}  ${c.name}`);
      ok ? passed++ : failed++;
    } catch (e) {
      console.log(`  FAIL  ${c.name} — ${e.message}`);
      failed++;
    }
  }
  console.log('');
  console.log(`  ${checks.length} check(s): ${passed} ok, ${failed} failed`);
  if (scopeBackup !== null) writeFileSync(scopePath, scopeBackup);
  else if (existsSync(scopePath)) rmSync(scopePath, { force: true });

  if (failed) { console.error(`${failed} check(s) failed.`); process.exit(1); }
  console.log('All checks passed.');
}

function help() {
  console.log(`cursordoctrine ${pkg.version} — Cursor hooks\n\nUsage\n  npx cursordoctrine <command>\n\nCommands\n  install    Copy hook engine into ~/.agents/hooks and merge hooks.json.\n  verify     Smoke-test the installed pack.\n  uninstall  Remove installed files and strip hooks.json.\n  help       Show this help.\n`);
}

const cmd = (process.argv[2] || 'help').toLowerCase();
if (cmd === 'install') install();
else if (cmd === 'uninstall') uninstall();
else if (cmd === 'verify') verify();
else help();
