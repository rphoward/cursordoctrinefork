import { runHook, hasContext } from '../fixture.mjs';

export function checks(ctx) {
  return [
    {
      name: 'doctrine injection emits additional_context',
      run: () => hasContext(runHook(ctx, 'inject-doctrine', {})),
    },
  ];
}
