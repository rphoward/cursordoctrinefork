import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { withGitRepo, readScope, writeScope, stampSession, pendingFile, fail, pass } from '../fixture.mjs';

function runSweepHook(ctx, dir, cid) {
  const r = spawnSync('node', [join(ctx.hooksDst, 'scope-git-sweep.mjs')], {
    input: JSON.stringify({ conversation_id: cid, cwd: dir, tool_name: 'Shell' }),
    encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { ...process.env, HOME: ctx.HOME, USERPROFILE: ctx.HOME, CURSORDOCTRINE_HOME: ctx.HOME },
  });
  if (r.error) return fail(`spawn error: ${r.error.message}`);
  return r.stdout ? r.stdout.trim() : '';
}

function baseScope() {
  return { prompt: 't', intent: 't', decomposition: [], verifications: [], files: [], acceptance: 'tests pass' };
}

export function checks(ctx) {
  return [
    {
      name: 'scope-git-sweep catches a Shell-written file into files[]',
      run: () => withGitRepo(ctx, '.cd-verify-sgs', { seed: { 'README.md': 'init\n' } }, (dir) => {
        const cid = 'npxvsgs';
        writeScope(dir, baseScope());
        stampSession(ctx, cid);
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'generated.ts'), 'shell-written\n');
        runSweepHook(ctx, dir, cid);
        const after = readScope(dir);
        const hit = (after.files || []).some((f) => String(f).replace(/\\/g, '/') === 'src/generated.ts');
        if (!hit) return fail(`src/generated.ts not in files[]: ${JSON.stringify(after.files)}`);
        return pass();
      }),
    },
    {
      name: 'scope-git-sweep ignores Shell-written Cursor plan files',
      run: () => withGitRepo(ctx, '.cd-verify-sgs-plan', { seed: { 'README.md': 'init\n' } }, (dir) => {
        const cid = 'npxvsgsplan';
        writeScope(dir, baseScope());
        stampSession(ctx, cid);
        mkdirSync(join(dir, '.cursor', 'plans'), { recursive: true });
        writeFileSync(join(dir, '.cursor', 'plans', 'next.md'), 'plan\n');
        runSweepHook(ctx, dir, cid);
        const after = readScope(dir);
        if ((after.files || []).length !== 0) return fail(`plan file entered files[]: ${JSON.stringify(after.files)}`);
        return pass();
      }),
    },
  ];
}
