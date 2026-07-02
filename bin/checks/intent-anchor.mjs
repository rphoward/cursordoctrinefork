import { existsSync } from 'node:fs';
import { runHook, withRepo, writeScope, readScope, pendingFile, rmPending, hasContext, fail, pass, defaultAcceptance } from '../fixture.mjs';

const DA = defaultAcceptance();

export function checks(ctx) {
  return [
    {
      name: 'intent-anchor fires on empty intent, silent when no new files, re-fires on new files',
      run: () => withRepo(ctx, '.cd-verify-ia', (dir) => {
        const cid = 'npxvia';
        const flagPath = pendingFile(ctx, cid, 'intent-anchored');
        rmPending(ctx, cid, 'intent-anchored');
        writeScope(dir, { prompt: 'add login', intent: '', decomposition: [], verifications: [], files: ['src/login.tsx'], acceptance: DA });
        const first = runHook(ctx, 'intent-anchor', { conversation_id: cid, cwd: dir });
        if (!hasContext(first) || !first.includes('INTENT ANCHOR')) return fail(`should fire on empty intent, got: ${first.slice(0, 200)}`);
        if (!existsSync(flagPath)) return fail('flag was not armed after first fire');
        const second = runHook(ctx, 'intent-anchor', { conversation_id: cid, cwd: dir });
        if (hasContext(second) || second.includes('INTENT ANCHOR')) return fail('should stay silent when no new files since last nudge');
        const sj = readScope(dir);
        sj.files.push('src/auth.ts');
        writeScope(dir, sj);
        const third = runHook(ctx, 'intent-anchor', { conversation_id: cid, cwd: dir });
        if (!hasContext(third) || !third.includes('INTENT ANCHOR')) return fail('should re-fire when new file added since last nudge');
        return pass();
      }),
    },
    {
      name: 'intent-anchor silent when intent and acceptance already filled',
      run: () => withRepo(ctx, '.cd-verify-ia2', (dir) => {
        const cid = 'npxvia2';
        const flagPath = pendingFile(ctx, cid, 'intent-anchored');
        rmPending(ctx, cid, 'intent-anchored');
        writeScope(dir, { prompt: 'add login', intent: 'Add JWT login form with rate limit', decomposition: [], verifications: [], files: ['src/login.tsx'], acceptance: 'npm run test:e2e passes; rate limit holds at 5/min' });
        const out = runHook(ctx, 'intent-anchor', { conversation_id: cid, cwd: dir });
        if (hasContext(out) || out.includes('INTENT ANCHOR')) return fail(`should stay silent when contract is filled, got: ${out.slice(0, 200)}`);
        if (!existsSync(flagPath)) return fail('flag should still be armed (so we never bug this cid again)');
        return pass();
      }),
    },
  ];
}
