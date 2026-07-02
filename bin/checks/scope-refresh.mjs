import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { runHook, withRepo, writeScope, readScope, pendingFile, rmPending, hasContext, fail, pass } from '../fixture.mjs';

export function checks(ctx) {
  return [
    {
      name: 'scope-refresh prunes <TODO> entries on re-edit of already-recorded file',
      run: () => withRepo(ctx, '.cd-verify-prune', (dir) => {
        const cid = 'npxvprune';
        rmPending(ctx, cid, 'scope');
        writeScope(dir, { prompt: 'fix sidebar', intent: 'fix layout', decomposition: [], verifications: [], files: ['src/Sidebar.tsx', '<TODO: fill>', '', 'src/other.tsx'], acceptance: 'tests pass' });
        runHook(ctx, 'scope-refresh', { conversation_id: cid, cwd: dir, file_path: join(dir, 'src/Sidebar.tsx') });
        const after = readScope(dir);
        if (!Array.isArray(after.files)) return fail('files[] missing');
        if (after.files.length !== 2) return fail(`expected 2 entries, got ${after.files.length}: ${JSON.stringify(after.files)}`);
        if (after.files.some((f) => typeof f === 'string' && (f.trim() === '' || /^\s*<TODO/.test(f)))) return fail(`placeholder/blank survived: ${JSON.stringify(after.files)}`);
        return pass();
      }),
    },
    {
      name: 'scope refresh stashes + scope drain delivers .scope.json',
      run: () => withRepo(ctx, '.cd-verify-scope', (dir) => {
        const cid = 'npxvscope';
        writeScope(dir, { prompt: 'user asked for sidebar fix', intent: 'test intent', files: ['a.ts', 'b.ts'], acceptance: 'tests pass' });
        runHook(ctx, 'scope-refresh', { conversation_id: cid, cwd: dir, file_path: join(dir, 'a.ts') });
        const delivered = runHook(ctx, 'scope-drain', { conversation_id: cid });
        const secondDrain = runHook(ctx, 'scope-drain', { conversation_id: cid });
        if (!hasContext(delivered) || !delivered.includes('test intent')) return fail('scope-drain did not deliver the contract');
        if (hasContext(secondDrain)) return fail('scope-drain delivered twice (not one-shot)');
        return pass();
      }),
    },
    {
      name: 'scope refresh ignores saved Cursor plan files',
      run: () => withRepo(ctx, '.cd-verify-scope-plan', (dir) => {
        const cid = 'npxvscopeplan';
        const stashPath = pendingFile(ctx, cid, 'scope');
        mkdirSync(join(dir, '.cursor', 'plans'), { recursive: true });
        rmPending(ctx, cid, 'scope');
        writeScope(dir, { prompt: 'fix sidebar', intent: 'Fix sidebar', decomposition: [], verifications: [], files: [], acceptance: 'tests pass' });
        runHook(ctx, 'scope-refresh', { conversation_id: cid, cwd: dir, file_path: join(dir, '.cursor', 'plans', 'fix-sidebar.md') });
        const after = readScope(dir);
        if ((after.files || []).length !== 0) return fail(`plan file entered files[]: ${JSON.stringify(after.files)}`);
        if (existsSync(stashPath)) return fail('scope reminder was stashed for a plan file');
        return pass();
      }),
    },
    {
      name: 'scope refresh stays silent when no .scope.json exists',
      run: () => withRepo(ctx, '.cd-verify-noscope', (dir) => {
        const cid = 'npxvscope2';
        runHook(ctx, 'scope-refresh', { conversation_id: cid, cwd: dir, file_path: join(dir, 'a.ts') });
        const drain = runHook(ctx, 'scope-drain', { conversation_id: cid });
        if (hasContext(drain)) return fail('scope-drain emitted without a .scope.json');
        return pass();
      }),
    },
  ];
}
