// Install a disposable, exact registry host graph; never changes global DSH.
// Usage: node scripts/prepare-host-probe.mjs 0.1.7-rc.2
import { mkdtemp, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const version = process.argv[2];
if (version !== '0.1.7-rc.2') {
    throw new Error('This release targets the exact audited host 0.1.7-rc.2');
}
const source = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), `alignment-${version}-`));
const plugin = join(root, 'plugin');
await mkdir(plugin);
for (const path of ['src', 'test', 'scripts', 'package.json', 'tsconfig.json', 'tsconfig.check.json', 'eslint.config.js']) {
    await cp(join(source, path), join(plugin, path), { recursive: true });
}
const original = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
const dependencies = { ...original.dependencies, ...original.peerDependencies, ...original.devDependencies };
// The probe checks host contracts, not the repository's independent lint graph.
for (const name of ['eslint', '@eslint/js', 'typescript-eslint']) delete dependencies[name];
delete dependencies['@deepseek-ai/dsh-client-runtime']; // retired after rc.2
for (const name of Object.keys(dependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) dependencies[name] = version;
}
dependencies['@deepseek-ai/cordis'] = '4.0.4';
dependencies['@deepseek-ai/schemastery'] = '3.18.4';
for (const name of ['agent-loop', 'session-projection', 'client-ui-layout', 'client-ui-session']) dependencies[`@deepseek-ai/dsh-${name}`] = version;
await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'alignment-isolated-host-probe', private: true, type: 'module', dependencies
}, null, 2));
console.log(`PROBE=${root}\nPLUGIN=${plugin}`);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], {
    cwd: resolve(root), stdio: 'inherit', shell: process.platform === 'win32'
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
