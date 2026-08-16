// Internal storage: plain JSON file. NOT public — do not import this from
// outside the package.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STORE = join(process.cwd(), 'items.json');

export function readStore() {
  try {
    return JSON.parse(readFileSync(STORE, 'utf8'));
  } catch {
    return [];
  }
}

export function writeStore(items) {
  writeFileSync(STORE, JSON.stringify(items, null, 2));
}
