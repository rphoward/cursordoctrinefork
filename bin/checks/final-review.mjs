import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { runHook, withGitRepo, withRepo, writeScope, pendingFile, rmPending, hasFollowup, fail, pass } from '../fixture.mjs';

export function checks(ctx) {
  return [
    {
      name: 'final review fires once when files changed, then goes quiet (no further edits)',
      run: () => withGitRepo(ctx, '.cd-verify-repo', { seed: { 'dummy.ts': 'original\n' } }, (dir, git) => {
        const cid = 'npxvfr';
        rmPending(ctx, cid, 'reviewed');
        writeFileSync(join(dir, 'dummy.ts'), 'changed\n', 'utf8');
        const first = runHook(ctx, 'final-review', { conversation_id: cid, status: 'completed', cwd: dir });
        if (!hasFollowup(first)) return fail('no followup_message on first stop');
        const second = runHook(ctx, 'final-review', { conversation_id: cid, status: 'completed', cwd: dir, loop_count: 1 });
        if (hasFollowup(second)) return fail('review re-fired when diff unchanged (should be accept)');
        return pass();
      }),
    },
    {
      name: 'final review recovers from orphaned reviewed flag',
      run: () => withGitRepo(ctx, '.cd-verify-orphan', { seed: { 'dummy.ts': 'original\n' } }, (dir) => {
        const cid = 'npxvfr3';
        const flagPath = pendingFile(ctx, cid, 'reviewed');
        writeFileSync(join(dir, 'dummy.ts'), 'changed\n', 'utf8');
        writeFileSync(flagPath, '0', 'utf8');
        const out = runHook(ctx, 'final-review', { conversation_id: cid, status: 'completed', cwd: dir, loop_count: 0 });
        if (!hasFollowup(out)) return fail('orphaned flag suppressed review');
        return pass();
      }),
    },
    {
      name: 'final review stays quiet when no files changed',
      run: () => withGitRepo(ctx, '.cd-verify-clean', { seed: { 'dummy.ts': 'original\n' } }, (dir) => {
        const cid = 'npxvfr2';
        rmPending(ctx, cid, 'reviewed');
        const out = runHook(ctx, 'final-review', { conversation_id: cid, status: 'completed', cwd: dir });
        if (hasFollowup(out)) return fail('review fired on a clean repo (no diff)');
        return pass();
      }),
    },
    {
      name: 'final review stays quiet when only Cursor plan files changed',
      run: () => withGitRepo(ctx, '.cd-verify-plan-only', { seed: { 'README.md': 'init\n' } }, (dir) => {
        const cid = 'npxvfrplan';
        rmPending(ctx, cid, 'reviewed');
        mkdirSync(join(dir, '.cursor', 'plans'), { recursive: true });
        writeFileSync(join(dir, '.cursor', 'plans', 'fix.md'), 'plan\n', 'utf8');
        const out = runHook(ctx, 'final-review', { conversation_id: cid, status: 'completed', cwd: dir, composer_mode: 'plan' });
        if (hasFollowup(out)) return fail('review fired for saved plan-only change');
        return pass();
      }),
    },
    {
      name: 'final review fires for non-git project via .scope.json fallback',
      run: () => withRepo(ctx, '.cd-verify-nogit', (dir) => {
        const cid = 'npxvfrng';
        rmPending(ctx, cid, 'reviewed');
        writeScope(dir, { prompt: 'fix the bug', intent: 'Fix null pointer in auth', decomposition: [], verifications: [], files: ['src/auth.ts', 'src/utils.ts'], acceptance: 'tests pass' });
        const out = runHook(ctx, 'final-review', { conversation_id: cid, status: 'completed', cwd: dir });
        if (!hasFollowup(out)) return fail('review did not fire for non-git project');
        if (!out.includes('src/auth.ts')) return fail('files[] from scope.json not in review');
        return pass();
      }),
    },
  ];
}
