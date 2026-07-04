#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const DOCTRINE_PATH = join(HOOKS_DIR, 'doctrine.md');

function main() {
  try {
    const doctrine = existsSync(DOCTRINE_PATH)
      ? readFileSync(DOCTRINE_PATH, 'utf8').trim()
      : '';
    if (!doctrine) {
      console.log('{}');
      return;
    }
    console.log(JSON.stringify({ additional_context: doctrine }, null, 2));
  } catch {
    console.log('{}');
  }
}

main();
