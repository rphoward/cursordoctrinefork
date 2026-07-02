import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { withGitRepo, pass, fail } from '../fixture.mjs';
import { runMinimality, scopeRelativePath } from '../../hooks/hook-common.mjs';

export function checks(ctx) {
  const hasPython = !!ctx.pythonCmd();

  return [
    {
      name: 'minimality.py emits SUMMARY on a modified tracked file',
      warn: !hasPython,
      run: () => {
        if (!hasPython) return { ok: true, warn: true };
        return withGitRepo(ctx, '.cd-verify-minimality', { seed: { 'dummy.ts': 'export const x = 1;\n' } }, (dir) => {
          writeFileSync(join(dir, 'dummy.ts'), 'export const x = 1;\nexport function add(a, b) { return a + b; }\nif (true) { console.log("y"); }\n');
          const r = runMinimality(dir, ['dummy.ts']);
          if (!r || typeof r.worstRatio !== 'number') return fail(`minimality returned no SUMMARY: ${JSON.stringify(r)}`);
          if (r.worstFile !== 'dummy.ts' && r.worstFile.replace(/\\/g, '/') !== 'dummy.ts') return fail(`unexpected worstFile: ${r.worstFile}`);
          return pass();
        });
      },
    },
    {
      name: 'scopeRelativePath: Windows drive case-insensitive',
      run: () => {
        const rel = scopeRelativePath('C:/Users/me/proj/src/foo.ts', 'c:\\Users\\me\\proj');
        if (rel !== 'src/foo.ts') return fail(`expected src/foo.ts, got ${rel}`);
        return pass();
      },
    },
    {
      name: 'scopeRelativePath: backslash relative input normalized',
      run: () => {
        const rel = scopeRelativePath('src\\foo.ts', 'C:/proj');
        if (rel !== 'src/foo.ts') return fail(`expected src/foo.ts, got ${rel}`);
        return pass();
      },
    },
    {
      name: 'scopeRelativePath: Unix absolute under root',
      run: () => {
        const rel = scopeRelativePath('/home/me/proj/src/foo.ts', '/home/me/proj');
        if (rel !== 'src/foo.ts') return fail(`expected src/foo.ts, got ${rel}`);
        return pass();
      },
    },
    {
      name: 'scopeRelativePath: outside root yields empty',
      run: () => {
        const rel = scopeRelativePath('/other/x.ts', '/home/me/proj');
        if (rel !== '') return fail(`expected empty, got ${rel}`);
        return pass();
      },
    },
    {
      name: 'scopeRelativePath: parent traversal yields empty',
      run: () => {
        const rel = scopeRelativePath('../x.ts', '/home/me/proj');
        if (rel !== '') return fail(`expected empty, got ${rel}`);
        return pass();
      },
    },
  ];
}
