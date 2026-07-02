import { join } from 'node:path';
import { runHook, withScope, assertAllow, assertDeny, fail, pass } from '../fixture.mjs';

const EMPTY_SCOPE = {
  prompt: 'fix foo', intent: '', decomposition: [], verifications: [], files: [], acceptance: 'tests pass',
};

export function checks(ctx) {
  return [
    {
      name: 'step0-gate denies code edit when intent empty',
      run: () => withScope(ctx, '.cd-verify-step0-empty', EMPTY_SCOPE, (dir) => {
        const out = runHook(ctx, 'step0-gate', { cwd: dir, tool_name: 'Write', tool_input: { path: join(dir, 'src/foo.ts') } });
        if (!assertDeny(out)) return fail(`expected deny, got: ${out.slice(0, 200)}`);
        return pass();
      }),
    },
    {
      name: 'step0-gate allows .scope.json write when intent empty',
      run: () => withScope(ctx, '.cd-verify-step0-scope', EMPTY_SCOPE, (_dir, scopePath) => {
        const out = runHook(ctx, 'step0-gate', { cwd: _dir, tool_name: 'Write', tool_input: { path: scopePath } });
        if (!assertAllow(out)) return fail(`expected allow, got: ${out.slice(0, 200)}`);
        return pass();
      }),
    },
    {
      name: 'step0-gate allows code edit when intent filled',
      run: () => withScope(ctx, '.cd-verify-step0-allow', {
        ...EMPTY_SCOPE, intent: 'Fix the foo module',
      }, (dir) => {
        const out = runHook(ctx, 'step0-gate', { cwd: dir, tool_name: 'StrReplace', tool_input: { path: join(dir, 'src/foo.ts') } });
        if (!assertAllow(out)) return fail(`expected allow, got: ${out.slice(0, 200)}`);
        return pass();
      }),
    },
    {
      name: 'step0-gate denies second file without decomposition',
      run: () => withScope(ctx, '.cd-verify-step0-decomp', {
        ...EMPTY_SCOPE, intent: 'Fix foo and bar modules', files: ['src/foo.ts'],
      }, (dir) => {
        const out = runHook(ctx, 'step0-gate', { cwd: dir, tool_name: 'Write', tool_input: { path: join(dir, 'src/bar.ts') } });
        if (!assertDeny(out)) return fail(`expected deny, got: ${out.slice(0, 200)}`);
        return pass();
      }),
    },
    {
      name: 'step0-gate allows second file when decomposition declared',
      run: () => withScope(ctx, '.cd-verify-step0-decomp-ok', {
        ...EMPTY_SCOPE,
        intent: 'Fix foo and bar modules',
        decomposition: [
          { step: 1, subtask: 'foo', expected_files: ['src/foo.ts'] },
          { step: 2, subtask: 'bar', expected_files: ['src/bar.ts'] },
        ],
        files: ['src/foo.ts'],
      }, (dir) => {
        const out = runHook(ctx, 'step0-gate', { cwd: dir, tool_name: 'Write', tool_input: { path: join(dir, 'src/bar.ts') } });
        if (!assertAllow(out)) return fail(`expected allow, got: ${out.slice(0, 200)}`);
        return pass();
      }),
    },
  ];
}
