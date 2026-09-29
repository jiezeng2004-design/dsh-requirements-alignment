// Check this plugin against declarations from a built official DSH checkout.
// Usage: node scripts/check-host-types.mjs <official-checkout>
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (!process.argv[2]) throw new Error('Expected the built official DSH checkout path');
const host = resolve(process.argv[2]);
const plugin = dirname(dirname(fileURLToPath(import.meta.url)));
const ts = (await import(pathToFileURL(join(host, 'node_modules/typescript/lib/typescript.js')).href)).default;
const source = ts.readConfigFile(join(host, 'tsconfig.base.json'), ts.sys.readFile);
if (source.error) throw new Error(ts.flattenDiagnosticMessageText(source.error.messageText, '\n'));
const paths = {};
for (const [name, targets] of Object.entries(source.config.compilerOptions.paths)) {
    paths[name] = targets.map(target => {
        let declaration = target.replace('/src', '/lib/types');
        if (declaration.endsWith('.ts')) declaration = declaration.slice(0, -3) + '.d.ts';
        else if (!declaration.includes('*')) declaration += '/index.d.ts';
        return resolve(host, declaration).replaceAll('\\', '/');
    });
}
for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools']) {
    if (!paths[name]?.some(existsSync)) throw new Error(`Build the official host first: missing ${name} declarations`);
}
const configDir = mkdtempSync(join(tmpdir(), 'alignment-host-types-'));
const configPath = join(configDir, 'tsconfig.json');
writeFileSync(configPath, JSON.stringify({
    extends: join(plugin, 'tsconfig.json'),
    compilerOptions: { noEmit: true, paths, types: ['node'], typeRoots: [join(host, 'node_modules/@types').replaceAll('\\', '/')] },
    include: [join(plugin, 'src/**/*.ts').replaceAll('\\', '/')]
}, null, 2));
const result = spawnSync(process.execPath, [join(host, 'node_modules/typescript/bin/tsc'), '-p', configPath], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const version = JSON.parse(readFileSync(join(host, 'apps/cli/package.json'), 'utf8')).version;
console.log(`Plugin typecheck passed against built DSH ${version}; config: ${configPath}`);
