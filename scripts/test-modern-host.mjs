// Run only current-format tests against the probe's installed host graph.
// Legacy artifact fixtures remain historical; the current gate tests safe refusal.
import { readdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
if (resolve(process.cwd()) !== resolve(pluginRoot)) throw new Error('Run from the isolated plugin directory');
const marker = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
if (marker.name !== 'alignment-isolated-host-probe') throw new Error('Prepare an isolated probe first; no source checkout files will be written');
const legacy = ['migration.test.ts', 'persistence-regression.test.ts'];
const run = (args) => {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
};
console.log(`Legacy-only fixtures excluded from this modern gate: ${legacy.join(', ')}`);
await writeFile('tsconfig.modern-probe.json', JSON.stringify({
    extends: './tsconfig.check.json', exclude: legacy.map(name => `test/${name}`)
}));
run([require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.modern-probe.json']);
run([require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json']);
run(['scripts/build-client.mjs']);
const tests = (await readdir('test')).filter(name => name.endsWith('.test.ts') && !legacy.includes(name));
run(['--test', '--experimental-test-isolation=none', ...tests.map(name => `test/${name}`)]);
run(['scripts/modern-host-smoke.mjs']);
