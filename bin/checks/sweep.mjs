import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pass, fail } from '../fixture.mjs';

export function checks(ctx) {
  const { pythonCmd, skillDst, pkgRoot, HOME } = ctx;
  const py = pythonCmd();
  const scanner = join(skillDst, 'scripts', 'scan_slop.py');
  let scannerOk = false;
  if (py && existsSync(scanner)) {
    const r = spawnSync(py, [scanner, '--help'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    scannerOk = !r.error && /usage/i.test(`${r.stdout || ''}${r.stderr || ''}`);
  }

  return [
    {
      name: `anti-slop scanner --help${scannerOk ? '' : ' — unavailable (final review falls back to the checklist)'}`,
      warn: !scannerOk,
      run: () => (scannerOk ? pass() : { ok: true, warn: true }),
    },
    {
      name: 'sweep runs and emits a structured report when scanner is available',
      run: () => {
        if (!scannerOk) return pass();
        const r = spawnSync(process.execPath, [join(pkgRoot, 'bin', 'cli.mjs'), 'sweep', pkgRoot], {
          encoding: 'utf8', timeout: 120000, windowsHide: true,
          env: { ...process.env, HOME, USERPROFILE: HOME, CURSORDOCTRINE_HOME: HOME },
          maxBuffer: 64 * 1024 * 1024,
        });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        if (r.status !== 0 || r.error) return fail(`exit ${r.status} ${r.error ? r.error.message : ''}`);
        if (!/anti-slop sweep \(whole codebase\)/.test(out)) return fail('missing sweep header');
        if (!/slop_found:/.test(out)) return fail('missing slop_found verdict line');
        return pass();
      },
    },
  ];
}
