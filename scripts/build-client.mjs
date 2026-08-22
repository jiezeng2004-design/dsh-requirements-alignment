// Wrap the client source into the dsh-web module-loader artifact:
// `window.__ModuleLoader__.load({ id, factory: (require) => { ... } })`.
// The id must equal the package name (the cordis entry name). Recipe
// mirrors dsh-chatgpt-bridge. The source is inserted verbatim inside
// factory(require) so `const React = require('react')` resolves through
// the DSH ModuleLoader — not a global React. No bundler is required.
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const pluginId = manifest.name;
const source = await readFile(join(root, 'src', 'client', 'index.js'), 'utf8');
const wrapped = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  source,
  'return module.exports; } });',
  '',
].join('\n');
await mkdir(join(root, 'lib'), { recursive: true });
await writeFile(join(root, 'lib', 'client.js'), wrapped);
await rm(join(root, '.client-build'), { recursive: true, force: true });
console.log(`built lib/client.js (${wrapped.length} bytes) as module "${pluginId}"`);