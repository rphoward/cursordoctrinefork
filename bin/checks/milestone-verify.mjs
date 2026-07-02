import { runHook, withRepo, writeScope, readScope, writeTranscript, pendingFile, rmPending, hasContext, fail, pass } from '../fixture.mjs';

function scopeWith(decomposition, files, verifications = []) {
  return {
    prompt: 'add login', intent: 'Add JWT login',
    decomposition, verifications, files, acceptance: 'tests pass',
  };
}

export function checks(ctx) {
  return [
    {
      name: 'milestone-verify emits reminder when step expected_files all touched',
      run: () => withRepo(ctx, '.cd-verify-mv1', (dir) => {
        const cid = 'npxvmv1';
        writeScope(dir, scopeWith(
          [
            { step: 1, subtask: 'backend', expected_files: ['server/auth.ts', 'server/routes/login.ts'] },
            { step: 2, subtask: 'frontend', expected_files: ['src/login.tsx'] },
          ],
          ['server/auth.ts', 'server/routes/login.ts'],
        ));
        const out = runHook(ctx, 'milestone-verify', { conversation_id: cid, cwd: dir });
        if (!hasContext(out) || !out.includes('VERIFY MILESTONE step 1')) return fail(`expected reminder for step 1, got: ${out.slice(0, 200)}`);
        return pass();
      }),
    },
    {
      name: 'milestone-verify silent on 1 file with empty decomposition',
      run: () => withRepo(ctx, '.cd-verify-mv2', (dir) => {
        const cid = 'npxvmv2';
        writeScope(dir, { prompt: 'typo fix', intent: '', decomposition: [], verifications: [], files: ['README.md'], acceptance: 'tests pass' });
        const out = runHook(ctx, 'milestone-verify', { conversation_id: cid, cwd: dir });
        if (hasContext(out) || out.includes('DECOMPOSE')) return fail(`should be silent on 1-file trivial task, got: ${out.slice(0, 200)}`);
        return pass();
      }),
    },
    {
      name: 'milestone-verify emits DECOMPOSE on 2 files with empty decomposition',
      run: () => withRepo(ctx, '.cd-verify-mv2c', (dir) => {
        const cid = 'npxvmv2c';
        rmPending(ctx, cid, 'decompose');
        writeScope(dir, { prompt: 'multi fix', intent: '', decomposition: [], verifications: [], files: ['README.md', 'src/a.ts'], acceptance: 'tests pass' });
        const out = runHook(ctx, 'milestone-verify', { conversation_id: cid, cwd: dir });
        if (!hasContext(out) || !out.includes('DECOMPOSE')) return fail(`expected DECOMPOSE nudge on 2 files, got: ${out.slice(0, 200)}`);
        return pass();
      }),
    },
    {
      name: 'milestone-verify silent when no files touched',
      run: () => withRepo(ctx, '.cd-verify-mv2b', (dir) => {
        const cid = 'npxvmv2b';
        writeScope(dir, { prompt: 'typo fix', intent: '', decomposition: [], verifications: [], files: [], acceptance: 'tests pass' });
        const out = runHook(ctx, 'milestone-verify', { conversation_id: cid, cwd: dir });
        if (hasContext(out) || out.includes('DECOMPOSE') || out.includes('VERIFY MILESTONE')) return fail(`should be silent with zero files, got: ${out.slice(0, 200)}`);
        return pass();
      }),
    },
    {
      name: 'milestone-verify scrapes ACCEPT step N from transcript and writes verifications[N]',
      run: () => withRepo(ctx, '.cd-verify-mv3', (dir) => {
        const cid = 'npxvmv3';
        const tp = writeTranscript(ctx, cid, [
          { role: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ACCEPT step 1: backend wired correctly.' }] } },
        ]);
        writeScope(dir, scopeWith([{ step: 1, subtask: 'backend', expected_files: ['server/auth.ts'] }], ['server/auth.ts']));
        const out = runHook(ctx, 'milestone-verify', { conversation_id: cid, transcript_path: tp, cwd: dir });
        if (out.includes('VERIFY MILESTONE')) return fail('reminder fired after verdict was scraped');
        const after = readScope(dir);
        if (!Array.isArray(after.verifications) || after.verifications.length !== 1) return fail(`verdict not recorded: ${JSON.stringify(after.verifications)}`);
        const v = after.verifications[0];
        if (v.step !== 1 || v.verdict !== 'ACCEPT') return fail(`verdict mismatch: ${JSON.stringify(v)}`);
        return pass();
      }),
    },
    {
      name: 'milestone-verify upgrades an existing PENDING verdict to ACCEPT',
      run: () => withRepo(ctx, '.cd-verify-mvu', (dir) => {
        const cid = 'npxvmvu';
        const tp = writeTranscript(ctx, cid, [
          { role: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ACCEPT step 1: backend wired correctly.' }] } },
        ]);
        writeScope(dir, scopeWith(
          [{ step: 1, subtask: 'backend', expected_files: ['server/auth.ts'] }],
          ['server/auth.ts'],
          [{ step: 1, verdict: 'PENDING', diagnosis: 'auto: all expected_files touched' }],
        ));
        const out = runHook(ctx, 'milestone-verify', { conversation_id: cid, transcript_path: tp, cwd: dir });
        if (out.includes('VERIFY MILESTONE')) return fail('reminder fired after PENDING was upgraded to ACCEPT');
        const after = readScope(dir);
        if (!Array.isArray(after.verifications) || after.verifications.length !== 1) return fail(`expected single upgraded verdict, got: ${JSON.stringify(after.verifications)}`);
        const v = after.verifications[0];
        if (v.step !== 1 || v.verdict !== 'ACCEPT') return fail(`PENDING did not upgrade to ACCEPT: ${JSON.stringify(v)}`);
        return pass();
      }),
    },
    {
      name: 'milestone-verify auto-writes PENDING when expected_files all touched',
      run: () => withRepo(ctx, '.cd-verify-mvp', (dir) => {
        const cid = 'npxvmvp';
        writeScope(dir, scopeWith([{ step: 1, subtask: 'backend', expected_files: ['server/auth.ts'] }], ['server/auth.ts']));
        const out = runHook(ctx, 'milestone-verify', { conversation_id: cid, cwd: dir });
        if (!out.includes('VERIFY MILESTONE')) return fail(`expected reminder, got: ${out.slice(0, 200)}`);
        const after = readScope(dir);
        if (!Array.isArray(after.verifications) || after.verifications.length !== 1) return fail(`PENDING not recorded: ${JSON.stringify(after.verifications)}`);
        const v = after.verifications[0];
        if (v.step !== 1 || v.verdict !== 'PENDING') return fail(`expected step 1 PENDING, got: ${JSON.stringify(v)}`);
        return pass();
      }),
    },
    {
      name: 'milestone-verify scrapes loosened phrasings (e.g. "step 1 looks good")',
      run: () => withRepo(ctx, '.cd-verify-mvl', (dir) => {
        const cid = 'npxvmvl';
        const tp = writeTranscript(ctx, cid, [
          { role: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'step 1 looks good, wiring is correct.' }] } },
        ]);
        writeScope(dir, scopeWith([{ step: 1, subtask: 'backend', expected_files: ['server/auth.ts'] }], ['server/auth.ts']));
        const out = runHook(ctx, 'milestone-verify', { conversation_id: cid, transcript_path: tp, cwd: dir });
        if (out.includes('VERIFY MILESTONE')) return fail('reminder fired after loose verdict was scraped');
        const after = readScope(dir);
        const v = after.verifications && after.verifications[0];
        if (!v || v.step !== 1 || v.verdict !== 'ACCEPT') return fail(`expected ACCEPT step 1, got: ${JSON.stringify(after.verifications)}`);
        return pass();
      }),
    },
  ];
}
