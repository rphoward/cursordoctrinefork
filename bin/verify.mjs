import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { allChecks } from './checks/index.mjs';

export function verify(ctx) {
  const {
    HOME, pkg, hooksDst, hooksJsonDst, pendingDir,
  } = ctx;

  const filter = (process.env.CHECKS_FILTER || '').trim().toLowerCase();
  const only = (process.env.CHECKS_ONLY || '').trim().toLowerCase();

  console.log(`cursordoctrine ${pkg.version} — verifying the Node hook pack in ${HOME}`);
  console.log('');

  if (!existsSync(hooksDst) || !existsSync(hooksJsonDst)) {
    console.error('Not installed (missing ~/.agents/hooks or ~/.cursor/hooks.json).');
    console.error('Run: npx cursordoctrine install');
    process.exit(1);
  }

  const checks = allChecks(ctx);
  const results = [];

  for (const c of checks) {
    if (filter && !c.group.includes(filter) && !c.name.toLowerCase().includes(filter)) continue;
    if (only && c.group !== only) continue;

    let ok = false;
    let warn = c.warn;
    let detail = '';
    try {
      const r = c.run();
      ok = r === true || (typeof r === 'object' && r.ok);
      if (typeof r === 'object') {
        if (r.detail) detail = r.detail;
        if (r.warn) warn = true;
      }
    } catch (e) {
      detail = e.message;
    }
    results.push({ group: c.group, name: c.name, ok, warn, detail });
    const tag = warn ? 'warn' : ok ? ' ok ' : 'FAIL';
    console.log(`  ${tag}  [${c.group}] ${c.name}${detail ? ` — ${detail}` : ''}`);
  }

  if (existsSync(pendingDir)) {
    for (const f of readdirSync(pendingDir)) {
      if (f.includes('npxv')) rmSync(join(pendingDir, f), { force: true });
    }
  }

  const failed = results.filter((r) => !r.ok && !r.warn);
  const warnings = results.filter((r) => r.warn);
  console.log('');
  console.log(`  ${results.length} check(s): ${results.length - failed.length - warnings.length} ok, ${warnings.length} warn, ${failed.length} failed`);
  if (failed.length) {
    console.error(`${failed.length} check(s) failed. Re-run: npx cursordoctrine install`);
    process.exit(1);
  }
  console.log('All checks passed. Restart Cursor if you have not since installing.');
}
