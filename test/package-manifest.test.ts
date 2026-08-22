import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as Record<string, Record<string, string> | undefined>;

test('shared DSH host contracts are peers instead of ordinary dependencies', () => {
    const sharedHostPackages = [
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-system-prompt',
        '@deepseek-ai/dsh-tools'
    ];

    for (const packageName of sharedHostPackages) {
        assert.equal(manifest.dependencies?.[packageName], undefined);
        assert.equal(typeof manifest.peerDependencies?.[packageName], 'string');
        assert.equal(typeof manifest.devDependencies?.[packageName], 'string');
    }
});
