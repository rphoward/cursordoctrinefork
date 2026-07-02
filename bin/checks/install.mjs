import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function checks(ctx) {
  const { hooksJsonDst, hooksJsonSrc, hooksDst, HOME, pkgRoot, ourKeys, LEGACY_HOOK_FILES, mergeHooks, keyOf } = ctx;

  return [
    {
      name: 'hooks.json parses as JSON',
      run: () => {
        JSON.parse(readFileSync(hooksJsonDst, 'utf8'));
        return true;
      },
    },
    {
      name: 'hooks.json command paths all resolve under $HOME',
      run: () => {
        const cfg = JSON.parse(readFileSync(hooksJsonDst, 'utf8'));
        const homeFwd = HOME.replaceAll('\\', '/');
        const missing = [];
        for (const entries of Object.values(cfg.hooks || {})) {
          if (!Array.isArray(entries)) continue;
          for (const e of entries) {
            const cmd = e && typeof e.command === 'string' ? e.command : '';
            if (!cmd) continue;
            const m = cmd.match(/(?:^|\s)node\s+("?)([^"\s]+)\1/);
            if (!m) continue;
            let path = m[2];
            if (path.startsWith('~/')) path = homeFwd + path.slice(1);
            const abs = path.includes(':') || path.startsWith('/') ? path : `${homeFwd}/${path}`;
            if (!existsSync(abs)) missing.push(`${path} (from: ${cmd.slice(0, 80)})`);
          }
        }
        if (missing.length) {
          return { ok: false, detail: `${missing.length} path(s) missing: ${missing.slice(0, 3).join('; ')}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}` };
        }
        return true;
      },
    },
    {
      name: 'merge preserves a foreign hook and reaps a retired one',
      run: () => {
        const keys = ourKeys();
        const foreignCmd = 'node ~/.agents/hooks/my-custom-gate.mjs';
        const staleName = LEGACY_HOOK_FILES.find((f) => f.endsWith('.ps1')) || 'anchor-set-nudge.ps1';
        const staleCmd = `pwsh.exe -NoProfile -File ~/.agents/hooks/${staleName}`;
        const incoming = JSON.parse(readFileSync(hooksJsonSrc, 'utf8'));
        const existing = {
          version: 1,
          hooks: { beforeShellExecution: [{ command: foreignCmd, timeout: 5 }, { command: staleCmd, timeout: 5 }] },
        };
        const { merged } = mergeHooks(existing, incoming, keys);
        const cmds = [];
        for (const entries of Object.values(merged.hooks || {})) {
          if (Array.isArray(entries)) for (const e of entries) if (e && e.command) cmds.push(e.command);
        }
        if (!cmds.some((c) => c.includes('my-custom-gate'))) return { ok: false, detail: 'foreign hook was dropped by the merge' };
        if (cmds.some((c) => c.includes(staleName))) return { ok: false, detail: `retired hook ${staleName} survived the merge` };
        return true;
      },
    },
    {
      name: 'merge leaves one cursordoctrine final-review stop hook',
      run: () => {
        const keys = ourKeys();
        const incoming = JSON.parse(readFileSync(hooksJsonSrc, 'utf8'));
        const currentStop = incoming.hooks.stop.find((e) => e.command.includes('final-review'));
        const duplicateStop = structuredClone(currentStop);
        const existing = {
          version: 1,
          hooks: { stop: [currentStop, duplicateStop, { command: 'node ~/.agents/hooks/foreign-stop.mjs', timeout: 5 }] },
        };
        const { merged } = mergeHooks(existing, incoming, keys);
        const ours = (merged.hooks.stop || []).filter((e) => keyOf(e.command, keys) === keyOf(currentStop.command, keys));
        const foreign = (merged.hooks.stop || []).filter((e) => e.command && e.command.includes('foreign-stop'));
        if (ours.length !== 1) return { ok: false, detail: `expected 1 final-review hook, got ${ours.length}` };
        if (foreign.length !== 1) return { ok: false, detail: 'foreign stop hook was not preserved' };
        return true;
      },
    },
    {
      name: 'install removes prior pack before writing new hooks',
      run: () => {
        const sandbox = join(HOME, '.cd-verify-install-upgrade');
        const sandboxHooks = join(sandbox, '.agents', 'hooks');
        const sandboxPending = join(sandbox, '.cursor', '.hooks-pending');
        const stalePath = join(sandboxHooks, 'intent-anchor.ps1');
        const cliPath = join(pkgRoot, 'bin/cli.mjs');
        const sandboxEnv = { ...process.env, CURSORDOCTRINE_HOME: sandbox, HOME: sandbox, USERPROFILE: sandbox };
        try {
          rmSync(sandbox, { recursive: true, force: true });
          mkdirSync(sandboxHooks, { recursive: true });
          mkdirSync(sandboxPending, { recursive: true });
          writeFileSync(stalePath, '# stale leftover from prior version\n');
          writeFileSync(join(sandboxPending, 'old.flag'), '1');
          const r = spawnSync(process.execPath, [cliPath, 'install'], {
            env: sandboxEnv, encoding: 'utf8', timeout: 30000, windowsHide: true,
          });
          if (r.status !== 0) return { ok: false, detail: `install exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}` };
          if (existsSync(stalePath)) return { ok: false, detail: 'intent-anchor.ps1 survived install upgrade' };
          if (existsSync(join(sandboxPending, 'old.flag'))) return { ok: false, detail: '.hooks-pending not cleared on upgrade install' };
          if (!existsSync(join(sandboxHooks, 'intent-anchor.mjs'))) return { ok: false, detail: 'fresh hooks were not installed' };
          return true;
        } finally {
          rmSync(sandbox, { recursive: true, force: true });
        }
      },
    },
  ];
}
