import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HOOKS_DIR, homeDir, readHookStdinJson, runHookMain } from './hook-common.mjs';
import { writeSessionStartStamp } from './session-state.mjs';

export function run(obj) {
  if (obj && typeof obj === 'object') writeSessionStartStamp(obj);

  const override = join(homeDir(), '.cursor', 'doctrine.md');
  const doctrinePath = existsSync(override) ? override : join(HOOKS_DIR, 'doctrine.md');
  if (!existsSync(doctrinePath)) return {};

  const content = readFileSync(doctrinePath, 'utf8').trim();
  if (!content) return {};
  return { additional_context: content };
}

runHookMain(run, import.meta.url);
