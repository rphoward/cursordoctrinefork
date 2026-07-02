import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { runHook, withRepo, readScope, writeScope, pendingFile, rmPending, hasContext, fail, pass, defaultAcceptance } from '../fixture.mjs';

const DA = defaultAcceptance();

function seedPrompt(ctx, dir, cid, prompt) {
  runHook(ctx, 'intent-precompile', { conversation_id: cid, cwd: dir, prompt });
}

export function checks(ctx) {
  return [
    {
      name: 'intent-precompile writes .scope.json from the prompt',
      run: () => withRepo(ctx, '.cd-verify-precompile', (dir) => {
        const cid = 'pc1';
        seedPrompt(ctx, dir, cid, 'fix the sidebar');
        const s = readScope(dir);
        if (s.prompt !== 'fix the sidebar') return fail(`prompt mismatch: ${s.prompt}`);
        if (s.intent !== '') return fail(`intent should be empty seed: ${JSON.stringify(s.intent)}`);
        if (!Array.isArray(s.files) || s.files.length !== 0) return fail('files[] should start empty');
        if (!Array.isArray(s.decomposition) || s.decomposition.length !== 0) return fail('decomposition[] should start empty');
        if (!Array.isArray(s.verifications) || s.verifications.length !== 0) return fail('verifications[] should start empty');
        s.intent = 'Fix sidebar layout bug';
        s.files = ['src/Sidebar.tsx'];
        s.decomposition = [{ step: 1, subtask: 'fix layout', expected_files: ['src/Sidebar.tsx'] }];
        writeScope(dir, s);
        seedPrompt(ctx, dir, cid, 'now fix the sidebar padding too');
        const s2 = readScope(dir);
        if (s2.prompt !== 'now fix the sidebar padding too') return fail(`prompt not updated: ${s2.prompt}`);
        if (s2.intent !== 'Fix sidebar layout bug') return fail(`intent clobbered: ${s2.intent}`);
        if (!Array.isArray(s2.files) || s2.files.length !== 1 || s2.files[0] !== 'src/Sidebar.tsx') return fail(`files[] not preserved: ${JSON.stringify(s2.files)}`);
        if (!Array.isArray(s2.decomposition) || s2.decomposition.length !== 1) return fail(`decomposition[] not preserved: ${JSON.stringify(s2.decomposition)}`);
        return pass();
      }),
    },
    {
      name: 'intent-precompile normalizes legacy scope missing decomposition/verifications',
      run: () => withRepo(ctx, '.cd-verify-precompile-legacy', (dir) => {
        writeScope(dir, { prompt: 'old prompt', intent: 'Old intent', files: ['src/a.ts'], acceptance: 'tests pass' });
        seedPrompt(ctx, dir, 'pc1l', 'follow up question');
        const s = readScope(dir);
        if (s.prompt !== 'follow up question') return fail(`prompt not updated: ${s.prompt}`);
        if (!Array.isArray(s.decomposition)) return fail('decomposition[] not normalized');
        if (!Array.isArray(s.verifications)) return fail('verifications[] not normalized');
        if (s.decomposition.length !== 0 || s.verifications.length !== 0) return fail('normalized arrays should be empty');
        return pass();
      }),
    },
    {
      name: 'intent-precompile resets scope on topic change (automatic, no prefix)',
      run: () => withRepo(ctx, '.cd-verify-precompile-topic', (dir) => {
        const cid = 'pc1t';
        seedPrompt(ctx, dir, cid, 'fix the sidebar');
        let s = readScope(dir);
        s.intent = 'Fix sidebar layout bug';
        s.files = ['src/Sidebar.tsx'];
        s.decomposition = [{ step: 1, subtask: 'fix layout', expected_files: ['src/Sidebar.tsx'] }];
        s.verifications = [{ step: 1, verdict: 'ACCEPT', diagnosis: '' }];
        s.acceptance = 'custom acceptance bar';
        writeScope(dir, s);
        seedPrompt(ctx, dir, cid, 'refactor the auth middleware');
        s = readScope(dir);
        if (s.prompt !== 'refactor the auth middleware') return fail(`prompt mismatch: ${s.prompt}`);
        if (s.intent !== '') return fail(`intent not reset: ${JSON.stringify(s.intent)}`);
        if (!Array.isArray(s.files) || s.files.length !== 0) return fail(`files[] not reset: ${JSON.stringify(s.files)}`);
        if (!Array.isArray(s.decomposition) || s.decomposition.length !== 0) return fail('decomposition[] not reset');
        if (!Array.isArray(s.verifications) || s.verifications.length !== 0) return fail('verifications[] not reset');
        if (s.acceptance !== DA) return fail(`acceptance not reset: ${s.acceptance}`);
        return pass();
      }),
    },
    {
      name: 'intent-precompile resets scope on /new prefix',
      run: () => withRepo(ctx, '.cd-verify-precompile-new', (dir) => {
        const cid = 'pc1n';
        seedPrompt(ctx, dir, cid, 'fix the sidebar');
        let s = readScope(dir);
        s.intent = 'Fix sidebar layout bug';
        s.files = ['src/Sidebar.tsx'];
        s.decomposition = [{ step: 1, subtask: 'fix layout', expected_files: ['src/Sidebar.tsx'] }];
        s.verifications = [{ step: 1, verdict: 'ACCEPT', diagnosis: '' }];
        s.acceptance = 'custom acceptance bar';
        writeScope(dir, s);
        seedPrompt(ctx, dir, cid, '/new fix the bug');
        s = readScope(dir);
        if (s.prompt !== 'fix the bug') return fail(`prompt not stripped: ${s.prompt}`);
        if (s.intent !== '') return fail(`intent not reset: ${JSON.stringify(s.intent)}`);
        if (!Array.isArray(s.files) || s.files.length !== 0) return fail(`files[] not reset: ${JSON.stringify(s.files)}`);
        if (s.acceptance !== DA) return fail(`acceptance not reset: ${s.acceptance}`);
        return pass();
      }),
    },
    {
      name: 'intent-precompile resets scope on unicode topic change',
      run: () => withRepo(ctx, '.cd-verify-precompile-unicode', (dir) => {
        const cid = 'pc1u';
        seedPrompt(ctx, dir, cid, 'fix the sidebar padding margins borders');
        let s = readScope(dir);
        s.intent = 'Fix sidebar layout';
        s.files = ['src/Sidebar.tsx'];
        writeScope(dir, s);
        seedPrompt(ctx, dir, cid, '修复 身份 验证 中间件 重构 工作');
        s = readScope(dir);
        if (s.intent !== '') return fail(`intent not reset on unicode topic change: ${JSON.stringify(s.intent)}`);
        if (!Array.isArray(s.files) || s.files.length !== 0) return fail(`files[] not reset: ${JSON.stringify(s.files)}`);
        return pass();
      }),
    },
    {
      name: 'intent-precompile skips hook-generated prompts',
      run: () => withRepo(ctx, '.cd-verify-precompile-skip', (dir) => {
        const cid = 'pc2';
        seedPrompt(ctx, dir, cid, 'fix the sidebar');
        let after = readScope(dir);
        if (after.prompt !== 'fix the sidebar') return fail('seed failed');
        seedPrompt(ctx, dir, cid, 'FINAL REVIEW (end of implementation) - audit everything');
        after = readScope(dir);
        if (after.prompt !== 'fix the sidebar') return fail('hook-generated prompt overwrote prompt');
        seedPrompt(ctx, dir, cid, 'VERIFY MILESTONE step 1 of 2');
        after = readScope(dir);
        if (after.prompt !== 'fix the sidebar') return fail('VERIFY MILESTONE header overwrote prompt');
        return pass();
      }),
    },
    {
      name: 'intent-precompile skips Cursor Plan Mode payloads',
      run: () => withRepo(ctx, '.cd-verify-precompile-plan-mode', (dir) => {
        const cid = 'pcplan1';
        runHook(ctx, 'intent-precompile', { conversation_id: cid, cwd: dir, composer_mode: 'plan', prompt: 'investigate the auth flow and write a plan' });
        const scopePath = join(dir, '.scope.json');
        if (existsSync(scopePath)) return fail('.scope.json was created for Plan Mode');
        writeScope(dir, { prompt: 'fix the sidebar', intent: 'Fix sidebar layout', decomposition: [], verifications: [], files: ['src/Sidebar.tsx'], acceptance: 'tests pass' });
        runHook(ctx, 'intent-precompile', { conversation_id: cid, cwd: dir, mode: 'planning', prompt: 'create a detailed implementation plan' });
        const after = readScope(dir);
        if (after.prompt !== 'fix the sidebar') return fail(`plan mode overwrote prompt: ${after.prompt}`);
        if (after.intent !== 'Fix sidebar layout') return fail(`plan mode clobbered intent: ${after.intent}`);
        return pass();
      }),
    },
    {
      name: 'intent-precompile skips obvious plan-only text but not implementation text',
      run: () => withRepo(ctx, '.cd-verify-precompile-plan-text', (dir) => {
        const cid = 'pcplan2';
        const scopePath = join(dir, '.scope.json');
        seedPrompt(ctx, dir, cid, 'write the plan first');
        if (existsSync(scopePath)) return fail('.scope.json was created for plan-only text');
        runHook(ctx, 'intent-precompile', { conversation_id: cid, cwd: dir, isPlanMode: 'false', prompt: 'implement the plan' });
        if (!existsSync(scopePath)) return fail('.scope.json was not created for implementation text');
        const s = readScope(dir);
        if (s.prompt !== 'implement the plan') return fail(`wrong prompt after implementation text: ${s.prompt}`);
        return pass();
      }),
    },
    {
      name: 'intent-precompile stashes STEP 0 CONTRACT for scope-drain',
      run: () => withRepo(ctx, '.cd-verify-precompile-step0', (dir) => {
        const cid = 'npxvpc0';
        const stashPath = pendingFile(ctx, cid, 'precompile');
        rmPending(ctx, cid, 'precompile');
        seedPrompt(ctx, dir, cid, 'fix the sidebar');
        if (!existsSync(stashPath)) return fail('precompile stash not written');
        const stash = readFileSync(stashPath, 'utf8');
        if (!stash.includes('STEP 0 CONTRACT')) return fail('stash missing STEP 0 CONTRACT header');
        const delivered = runHook(ctx, 'scope-drain', { conversation_id: cid });
        if (!hasContext(delivered) || !delivered.includes('STEP 0 CONTRACT')) return fail(`scope-drain did not deliver precompile stash: ${delivered.slice(0, 200)}`);
        if (existsSync(stashPath)) return fail('precompile stash not one-shot');
        return pass();
      }),
    },
  ];
}
