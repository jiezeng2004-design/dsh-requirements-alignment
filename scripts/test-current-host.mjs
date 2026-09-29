// These two fixtures exercise retired pre-SessionHandle storage APIs only.
// Current persistence and migration refusal are covered by test:host instead.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const legacy = new Set(['migration.test.ts', 'persistence-regression.test.ts']);
const tests = readdirSync('test').filter(name => name.endsWith('.test.ts') && !legacy.has(name));
console.log('Legacy storage fixtures not applicable to DSH 0.1.7:', [...legacy].join(', '));
const result = spawnSync(process.execPath, ['--test', '--experimental-test-isolation=none', ...tests.map(name => `test/${name}`)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
